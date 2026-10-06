// Step 4 server: checks logins with Supabase, loads/saves players, shares positions.
// Needs these environment variables (set them in Render, never in the code):
//   SUPABASE_URL          your project URL
//   SUPABASE_SERVICE_KEY  your service_role key (SECRET)
//   DEV_TOOLS             "true" while testing (lets the test button change progress)

const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 500;
const WORLD_W = 3900;
const WORLD_H = 1500;
const MAX_SPEED = 190;      // must match SPEED in game.js
const GATE_LIMIT = 1995;    // players without "indigene" can't go past this x
const SPAWN = { x: 470, y: 850 };
const DEV_TOOLS = process.env.DEV_TOOLS === 'true';
const PROGRESS_STEPS = ['arrived', 'verified', 'indigene'];

// Characters a player may pick. Premium characters are NOT allowed yet: they will be added
// here per player once the shop exists. Keep the free list in step with characters.json.
const FREE_CHARACTERS = ['male_civilian', 'male_wong', 'male_streetwear', 'female_floral', 'female_sammie', 'female_rocker'];
const DEFAULT_CHARACTER = 'male_civilian';
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const cleanLook = l => { l = l || {}; return { top: isHex(l.top) ? l.top : null, bottom: isHex(l.bottom) ? l.bottom : null, shoes: isHex(l.shoes) ? l.shoes : null, hair: isHex(l.hair) ? l.hair : null }; };
const parseLook = v => { try { return cleanLook(typeof v === 'string' ? JSON.parse(v) : v); } catch (e) { return cleanLook(); } };
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

function publicView(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, flip: p.flip, character: p.character, look: p.look };
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

      // Clothing colours: the saved ones, otherwise the ones chosen on the client (needs a "look" text column)
      let look = parseLook(row.look);
      if (!row.look && data.look) {
        look = cleanLook(data.look);
        const sv = await db.from('players').update({ look: JSON.stringify(look) }).eq('id', userId);
        if (sv.error) console.error('Could not save look:', sv.error.message);
      }

      // Same account logging in twice: the older session is removed
      const oldId = byUser.get(userId);
      if (oldId) {
        const oldSocket = io.sockets.sockets.get(oldId);
        if (oldSocket) { oldSocket.emit('kicked'); oldSocket.disconnect(true); }
      }

      const player = {
        id: socket.id, userId, name: row.name, character, look,
        x: row.x, y: row.y, flip: false,
        progress: row.progress, dirty: false,
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
        name: player.name,
        character: player.character,
        look: player.look,
        progress: player.progress,
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

  // The player changes their clothing colours
  socket.on('set_look', async data => {
    const p = players.get(socket.id);
    if (!p) return;
    const look = cleanLook(data);
    const { error } = await db.from('players').update({ look: JSON.stringify(look) }).eq('id', p.userId);
    if (error) { console.error('set_look failed:', error.message); return; }
    p.look = look;
    io.emit('look', { id: p.id, look });
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
