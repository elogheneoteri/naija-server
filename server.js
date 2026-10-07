// Step 4 server: checks logins with Supabase, loads/saves players, shares positions.
// Needs these environment variables (set them in Render, never in the code):
//   SUPABASE_URL          your project URL
//   SUPABASE_SERVICE_KEY  your service_role key (SECRET)
//   DEV_TOOLS             "true" while testing (lets the test button change progress)

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 500;
const WORLD_W = 10800;   // 360 m (the city lies east of the gate)
const WORLD_H = 7200;    // 240 m
const MAX_SPEED = 190;      // must match SPEED in game.js
const GATE_LIMIT = 1995;    // players without "indigene" can't go past this x
const SPAWN = { x: 470, y: 850 };
const DEV_TOOLS = process.env.DEV_TOOLS === 'true';
const PROGRESS_STEPS = ['arrived', 'verified', 'indigene'];

// ----- NIN card (Ivory, Immigration Office) -----
// Needs these columns on the players table (run nin_setup.sql once in the Supabase SQL editor):
//   nin_form jsonb, nin_ready_at timestamptz, nin_card jsonb, nin_number text unique
const NIN_WAIT_MS = 2 * 60 * 1000;           // the wait after the form is handed in
const NIN_AGE_MIN = 16, NIN_AGE_MAX = 40;
const NIN_STATE = 'DELTA';                   // state of origin on every card for now (Lagos / Abuja come with the state pick)
// Where Ivory stands, in server pixels (30 px = 1 m): building at x 50 m, z 11.8 m + IVORY_SPOT in immigration_office.js.
const IVORY_PX = { x: 1269, y: 450 };
const NIN_REACH_PX = 8 * 30;                 // a player must be within 8 m of Ivory to hand in the form or collect the card
const NAME_RE = /^[A-Za-z][A-Za-z'\- ]{1,19}$/;

// Characters a player may pick. Premium characters are NOT allowed yet: they will be added
// here per player once the shop exists. Keep the free list in step with characters.json.
const FREE_CHARACTERS = ['male_civilian', 'male_wong', 'male_streetwear', 'female_floral', 'female_sammie', 'female_rocker'];
const DEFAULT_CHARACTER = 'male_civilian';
const validCharacter = id => (FREE_CHARACTERS.includes(id) ? id : null);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variable.');
  process.exit(1);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const players = new Map(); // socket id -> player
const byUser = new Map();  // user id -> socket id (one session per account)

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Delta server is running. Players online: ' + players.size);
});

const io = new Server(httpServer, { cors: { origin: '*' } });

function cleanName(n) {
  const name = String(n || '').trim().replace(/[^\w \-]/g, '').slice(0, 16);
  return name || 'Player' + Math.floor(Math.random() * 900 + 100);
}

// ----- NIN helpers -----
function ninFromRow(row) {
  const enabled = 'nin_form' in row && 'nin_card' in row && 'nin_ready_at' in row;
  return {
    enabled,
    form: enabled ? row.nin_form || null : null,
    readyAt: enabled && row.nin_ready_at ? new Date(row.nin_ready_at).getTime() : 0,
    card: enabled ? row.nin_card || null : null,
    busy: false
  };
}

// What the client is told. remainingMs (not a clock time) so a wrong clock on the phone does not matter.
function ninState(p) {
  const n = p.nin;
  if (!n.enabled) return { status: 'disabled' };
  if (n.card) return { status: 'issued', card: n.card };
  if (n.readyAt) {
    const left = n.readyAt - Date.now();
    return left > 0 ? { status: 'waiting', remainingMs: left } : { status: 'ready', remainingMs: 0 };
  }
  return { status: 'none' };
}

const nearIvory = p => Math.hypot(p.x - IVORY_PX.x, p.y - IVORY_PX.y) <= NIN_REACH_PX;
const isMissingColumn = e => !!e && (e.code === '42703' || e.code === 'PGRST204' || /column|schema cache/i.test(e.message || ''));
const randDigits = n => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');

// Date of birth from the age the player picked: today minus that many years, minus 0-360 extra days, so the age always works out right.
function makeDob(age) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - crypto.randomInt(0, 361));
  return d.toISOString().slice(0, 10);
}

const titleCase = s => s.toLowerCase().replace(/(^|[ '\-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

// The name other players see above a character: the name on the NIN card once the player has collected one.
const displayName = p => (p.nin && p.nin.card && p.nin.card.first ? p.nin.card.first + ' ' + p.nin.card.last : p.name);

function publicView(p) {
  return { id: p.id, name: displayName(p), x: p.x, y: p.y, flip: p.flip, character: p.character };
}

async function savePlayer(p) {
  const { error } = await db.from('players').update({ x: p.x, y: p.y }).eq('id', p.userId);
  if (error) console.error('Save failed for', p.userId, error.message);
  else p.dirty = false;
}

io.on('connection', socket => {
  socket.on('join', async data => {
    if (socket.data.joined || socket.data.joining) return;
    socket.data.joining = true;
    try {
      const token = data && data.token;
      if (!token) { socket.emit('join_error', 'Please log in.'); return; }

      const { data: auth, error: authError } = await db.auth.getUser(token);
      if (authError || !auth || !auth.user) {
        socket.emit('join_error', 'Login expired. Please log in again.');
        return;
      }
      const userId = auth.user.id;

      if (players.size >= MAX_PLAYERS && !byUser.has(userId)) {
        socket.emit('full');
        return;
      }

      // Load the saved player, or create it the first time
      const found = await db.from('players').select('*').eq('id', userId).maybeSingle();
      if (found.error) {
        console.error(found.error);
        socket.emit('join_error', 'Server error. Try again.');
        return;
      }
      let row = found.data;
      if (!row) {
        const wanted = validCharacter(data.character) || DEFAULT_CHARACTER;
        let created = await db.from('players')
          .insert({ id: userId, name: cleanName(data.name), character: wanted })
          .select().single();
        // the "character" column may not exist yet: create the player without it
        if (created.error && created.error.code !== '23505' && /character/i.test(created.error.message)) {
          created = await db.from('players').insert({ id: userId, name: cleanName(data.name) }).select().single();
        }
        if (created.error) {
          socket.emit('join_error',
            created.error.code === '23505' ? 'That name is taken. Choose another.' : 'Could not create player.');
          return;
        }
        row = created.data;
      }

      // Which character this player uses: the saved one, otherwise the one they picked on the client
      let character = validCharacter(row.character);
      if (!character) {
        character = validCharacter(data.character) || DEFAULT_CHARACTER;
        const saved = await db.from('players').update({ character }).eq('id', userId);
        if (saved.error) console.error('Could not save character:', saved.error.message);
      }

      // Same account logging in twice: the older session is removed
      const oldId = byUser.get(userId);
      if (oldId) {
        const oldSocket = io.sockets.sockets.get(oldId);
        if (oldSocket) { oldSocket.emit('kicked'); oldSocket.disconnect(true); }
      }

      const player = {
        id: socket.id, userId, name: row.name, character,
        x: row.x, y: row.y, flip: false,
        progress: row.progress, dirty: false,
        nin: ninFromRow(row),
        lastMoveAt: Date.now()
      };
      // Safety: someone who hasn't finished immigration can't start past the gate
      if (player.progress !== 'indigene' && player.x > GATE_LIMIT) {
        player.x = SPAWN.x;
        player.y = SPAWN.y;
        player.dirty = true;
      }
      players.set(socket.id, player);
      byUser.set(userId, socket.id);
      socket.data.joined = true;

      socket.emit('init', {
        you: socket.id,
        name: displayName(player),
        character: player.character,
        progress: player.progress,
        nin: ninState(player),
        devTools: DEV_TOOLS,
        x: player.x,
        y: player.y,
        players: [...players.values()].map(publicView)
      });
      socket.broadcast.emit('joined', publicView(player));
    } catch (err) {
      console.error(err);
      socket.emit('join_error', 'Server error. Try again.');
    } finally {
      socket.data.joining = false;
    }
  });

  socket.on('move', data => {
    const p = players.get(socket.id);
    if (!p || !data) return;
    let x = Number(data.x);
    let y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x = Math.max(0, Math.min(WORLD_W, x));
    y = Math.max(0, Math.min(WORLD_H, y));

    // Speed check: no teleporting or speed hacks
    const now = Date.now();
    const dt = Math.min(now - p.lastMoveAt, 1000);
    p.lastMoveAt = now;
    const maxStep = MAX_SPEED * (dt / 1000) * 1.6 + 12;
    let rejected = Math.hypot(x - p.x, y - p.y) > maxStep;

    // Gate check: needs the "indigene" progress to go past the gate
    if (!rejected && p.progress !== 'indigene' && x > GATE_LIMIT) rejected = true;

    if (rejected) {
      socket.emit('correct', { x: p.x, y: p.y });
      return;
    }
    p.x = x;
    p.y = y;
    p.flip = !!data.flip;
    p.dirty = true;
    socket.broadcast.emit('moved', { id: p.id, x: p.x, y: p.y, flip: p.flip });
  });

  // The player picks one of the free characters
  socket.on('set_character', async id => {
    const p = players.get(socket.id);
    const character = validCharacter(id);
    if (!p || !character || character === p.character) return;
    const { error } = await db.from('players').update({ character }).eq('id', p.userId);
    if (error) { console.error('set_character failed:', error.message); return; }
    p.character = character;
    io.emit('character', { id: p.id, character });
  });

  // Testing only: lets the test button set progress until the NPC exists (Step 6)
  socket.on('dev_progress', async value => {
    const p = players.get(socket.id);
    if (!DEV_TOOLS || !p || !PROGRESS_STEPS.includes(value)) return;
    const { error } = await db.from('players').update({ progress: value }).eq('id', p.userId);
    if (error) { console.error(error.message); return; }
    p.progress = value;
    socket.emit('progress', { progress: value });
    if (value !== 'indigene' && p.x > GATE_LIMIT) {
      p.x = SPAWN.x;
      p.y = SPAWN.y;
      p.dirty = true;
      socket.emit('correct', { x: p.x, y: p.y });
      socket.broadcast.emit('moved', { id: p.id, x: p.x, y: p.y, flip: p.flip });
    }
  });

  // ----- NIN card -----
  // 1) the player hands in the form to Ivory: starts the 2-minute wait (saved, so it survives logging out)
  socket.on('nin_submit', async data => {
    const p = players.get(socket.id);
    if (!p || !data) return;
    const n = p.nin;
    if (!n.enabled) { socket.emit('nin_error', 'The NIN system is not set up on the server yet.'); return; }
    if (n.busy || n.card || n.readyAt) { socket.emit('nin', ninState(p)); return; }
    if (!nearIvory(p)) { socket.emit('nin_error', 'Please stand closer to Ivory.'); return; }
    const first = String(data.first || '').trim().replace(/\s+/g, ' ');
    const last = String(data.last || '').trim().replace(/\s+/g, ' ');
    const age = Number(data.age);
    if (!NAME_RE.test(first) || !NAME_RE.test(last)) { socket.emit('nin_error', 'Names use letters only (2 to 20 characters).'); return; }
    if (!Number.isInteger(age) || age < NIN_AGE_MIN || age > NIN_AGE_MAX) {
      socket.emit('nin_error', 'Age must be between ' + NIN_AGE_MIN + ' and ' + NIN_AGE_MAX + '.'); return;
    }
    n.busy = true;
    try {
      const form = { first: titleCase(first), last: titleCase(last), age, dob: makeDob(age) };
      const readyAt = Date.now() + NIN_WAIT_MS;
      const { error } = await db.from('players').update({ nin_form: form, nin_ready_at: new Date(readyAt).toISOString() }).eq('id', p.userId);
      if (error) {
        console.error('nin_submit failed:', error.message);
        socket.emit('nin_error', isMissingColumn(error) ? 'The NIN system is not set up on the server yet.' : 'Could not save your form. Try again.');
        return;
      }
      n.form = form; n.readyAt = readyAt;
      socket.emit('nin', ninState(p));
    } finally { n.busy = false; }
  });

  // 2) after the wait, the player collects the card: the server makes the unique NIN and saves the card
  socket.on('nin_collect', async () => {
    const p = players.get(socket.id);
    if (!p) return;
    const n = p.nin;
    if (!n.enabled) { socket.emit('nin_error', 'The NIN system is not set up on the server yet.'); return; }
    if (n.busy) return;
    if (n.card || !n.form || !n.readyAt || Date.now() < n.readyAt) { socket.emit('nin', ninState(p)); return; }
    if (!nearIvory(p)) { socket.emit('nin_error', 'Please stand closer to Ivory.'); return; }
    n.busy = true;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const card = {
          name: (n.form.first + ' ' + n.form.last).toUpperCase(), first: n.form.first, last: n.form.last,
          nin: String(crypto.randomInt(1, 10)) + randDigits(10),          // 11 digits, never starts with 0
          dob: n.form.dob,
          sex: /^female/.test(p.character) ? 'FEMALE' : 'MALE',
          nationality: 'NIGERIAN',
          state: NIN_STATE,
          registered: new Date().toISOString().slice(0, 10),
          doc: 'NVD' + randDigits(9)
        };
        const { error } = await db.from('players').update({ nin_card: card, nin_number: card.nin, progress: 'indigene' }).eq('id', p.userId);
        if (!error) {
          n.card = card; p.progress = 'indigene';
          socket.emit('nin', ninState(p));
          socket.emit('progress', { progress: 'indigene' });                 // status becomes Indigene and the gate opens
          io.emit('renamed', { id: p.id, name: displayName(p) });            // everybody sees the new name tag
          return;
        }
        if (error.code === '23505') continue;                              // that NIN already exists: make another
        console.error('nin_collect failed:', error.message);
        socket.emit('nin_error', 'Could not save your card. Try again.');
        return;
      }
      socket.emit('nin_error', 'Could not make a unique NIN. Try again.');
    } finally { n.busy = false; }
  });

  // Testing only (DEV_TOOLS): start the NIN quest again, or skip the 2-minute wait
  socket.on('dev_nin', async action => {
    const p = players.get(socket.id);
    if (!DEV_TOOLS || !p || !p.nin.enabled) return;
    if (action === 'reset') {
      const { error } = await db.from('players').update({ nin_form: null, nin_ready_at: null, nin_card: null, nin_number: null, progress: 'arrived' }).eq('id', p.userId);
      if (error) { console.error(error.message); return; }
      p.nin.form = null; p.nin.readyAt = 0; p.nin.card = null; p.progress = 'arrived';
      socket.emit('progress', { progress: 'arrived' });
      io.emit('renamed', { id: p.id, name: displayName(p) });
      if (p.x > GATE_LIMIT) {                                                // was past the gate: back to the camp
        p.x = SPAWN.x; p.y = SPAWN.y; p.dirty = true;
        socket.emit('correct', { x: p.x, y: p.y });
        socket.broadcast.emit('moved', { id: p.id, x: p.x, y: p.y, flip: p.flip });
      }
    } else if (action === 'skip' && p.nin.readyAt && !p.nin.card) {
      const now = Date.now();
      const { error } = await db.from('players').update({ nin_ready_at: new Date(now).toISOString() }).eq('id', p.userId);
      if (error) { console.error(error.message); return; }
      p.nin.readyAt = now;
    } else return;
    socket.emit('nin', ninState(p));
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (!p) return;
    players.delete(socket.id);
    if (byUser.get(p.userId) === socket.id) byUser.delete(p.userId);
    savePlayer(p);
    io.emit('left', socket.id);
  });
});

// Save positions of anyone who moved, every 30 seconds
setInterval(() => {
  players.forEach(p => { if (p.dirty) savePlayer(p); });
}, 30000);

httpServer.listen(PORT, () => {
  console.log('Delta server listening on port ' + PORT);
});
