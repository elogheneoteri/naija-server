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
const WORLD_W = 2400;
const WORLD_H = 900;
const DEV_TOOLS = process.env.DEV_TOOLS === 'true';
const PROGRESS_STEPS = ['arrived', 'verified', 'indigene'];

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
  return { id: p.id, name: p.name, x: p.x, y: p.y, flip: p.flip };
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
        const created = await db.from('players')
          .insert({ id: userId, name: cleanName(data.name) })
          .select().single();
        if (created.error) {
          socket.emit('join_error',
            created.error.code === '23505' ? 'That name is taken. Choose another.' : 'Could not create player.');
          return;
        }
        row = created.data;
      }

      // Same account logging in twice: the older session is removed
      const oldId = byUser.get(userId);
      if (oldId) {
        const oldSocket = io.sockets.sockets.get(oldId);
        if (oldSocket) { oldSocket.emit('kicked'); oldSocket.disconnect(true); }
      }

      const player = {
        id: socket.id, userId, name: row.name,
        x: row.x, y: row.y, flip: false,
        progress: row.progress, dirty: false
      };
      players.set(socket.id, player);
      byUser.set(userId, socket.id);
      socket.data.joined = true;

      socket.emit('init', {
        you: socket.id,
        name: player.name,
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
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    p.x = Math.max(0, Math.min(WORLD_W, x));
    p.y = Math.max(0, Math.min(WORLD_H, y));
    p.flip = !!data.flip;
    p.dirty = true;
    socket.broadcast.emit('moved', { id: p.id, x: p.x, y: p.y, flip: p.flip });
  });

  // Testing only: lets the test button set progress until the NPC exists (Step 6)
  socket.on('dev_progress', async value => {
    const p = players.get(socket.id);
    if (!DEV_TOOLS || !p || !PROGRESS_STEPS.includes(value)) return;
    const { error } = await db.from('players').update({ progress: value }).eq('id', p.userId);
    if (error) { console.error(error.message); return; }
    p.progress = value;
    socket.emit('progress', { progress: value });
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
