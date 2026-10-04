// Step 3 server: keeps track of every connected player and shares positions.
// Run locally with: npm install && npm start

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 500;
const WORLD_W = 2400;
const WORLD_H = 900;

// A plain page so you can open the server URL in a browser and see it is awake.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Delta server is running. Players online: ' + players.size);
});

const io = new Server(httpServer, { cors: { origin: '*' } });
const players = new Map();

io.on('connection', socket => {
  socket.on('join', data => {
    if (players.has(socket.id)) return;
    if (players.size >= MAX_PLAYERS) {
      socket.emit('full');
      socket.disconnect(true);
      return;
    }
    const name = String((data && data.name) || 'Player').trim().slice(0, 16) || 'Player';
    const player = { id: socket.id, name, x: 200, y: 450, flip: false };
    players.set(socket.id, player);

    // Tell the new player who is already here, and tell everyone else about them.
    socket.emit('init', { you: socket.id, players: [...players.values()] });
    socket.broadcast.emit('joined', player);
  });

  socket.on('move', data => {
    const player = players.get(socket.id);
    if (!player || !data) return;
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    player.x = Math.max(0, Math.min(WORLD_W, x));
    player.y = Math.max(0, Math.min(WORLD_H, y));
    player.flip = !!data.flip;
    socket.broadcast.emit('moved', { id: player.id, x: player.x, y: player.y, flip: player.flip });
  });

  socket.on('disconnect', () => {
    if (players.delete(socket.id)) io.emit('left', socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log('Delta server listening on port ' + PORT);
});
