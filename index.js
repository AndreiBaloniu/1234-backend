import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });

const rooms = new Map();

function makeRoom(mode = 'CLASSIC') {
  const code = nanoid(6).toUpperCase();
  const room = { code, mode, players: {}, order: [], turnIndex: 0, winner: null, history: [] };
  rooms.set(code, room);
  return room;
}

function countCorrectPositions(guess, secret) {
  let c = 0;
  for (let i = 0; i < 4; i++) if (guess[i] === secret[i]) c++;
  return c;
}

function feedbackDigits(guess, secret) {
  const g = guess.split('');
  const s = secret.split('');
  const set = new Set();
  for (const d of g) if (s.includes(d)) set.add(d);
  return [...set];
}

function feedbackMask(guess, secret) {
  return guess.split('').map((d, i) => (d === secret[i] ? '●' : '○')).join(' ');
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name, mode }, cb) => {
    const room = makeRoom((mode || 'CLASSIC').toUpperCase());
    room.players[socket.id] = { name: name?.trim() || 'Player A', secret: null, ready: false };
    room.order.push(socket.id);
    socket.join(room.code);
    cb?.({ code: room.code });
    io.to(room.code).emit('room-update', publicRoom(room));
  });

  socket.on('join-room', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb?.({ error: 'Room not found' });
    if (Object.keys(room.players).length >= 2) return cb?.({ error: 'Room is full' });
    room.players[socket.id] = { name: name?.trim() || 'Player B', secret: null, ready: false };
    room.order.push(socket.id);
    socket.join(room.code);
    cb?.({ code: room.code });
    io.to(room.code).emit('room-update', publicRoom(room));
  });

  socket.on('set-secret', ({ code, secret }) => {
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    if (!/^\d{4}$/.test(secret)) return;
    p.secret = secret;
    p.ready = true;
    const readyCount = Object.values(room.players).filter(pl => pl.ready).length;
    if (readyCount === 2 && room.order.length === 2) {
      room.turnIndex = Math.round(Math.random());
      room.winner = null;
    }
    io.to(code).emit('room-update', publicRoom(room));
  });

  socket.on('guess', ({ code, guess }) => {
    const room = rooms.get(code);
    if (!room || room.winner) return;
    const idx = room.turnIndex % room.order.length;
    if (socket.id !== room.order[idx]) return;
    if (!/^\d{4}$/.test(guess)) { io.to(socket.id).emit('error-msg', 'Guess must be 4 digits.'); return; }
    const opp = room.order.find(id => id !== socket.id);
    const oppPlayer = room.players[opp];
    if (!oppPlayer?.secret) { io.to(socket.id).emit('error-msg', 'Opponent not ready yet.'); return; }

    const correctCount = countCorrectPositions(guess, oppPlayer.secret);
    const item = { by: socket.id, guess, correctCount, ts: Date.now() };
    if (room.mode === 'REVEAL_DIGITS') item.feedbackDigits = feedbackDigits(guess, oppPlayer.secret);
    if (room.mode === 'REVEAL_POSITIONS') item.feedbackMask = feedbackMask(guess, oppPlayer.secret);
    room.history.push(item);

    if (correctCount === 4) { room.winner = socket.id; io.to(code).emit('game-over', { winner: socket.id }); }
    else { room.turnIndex = (room.turnIndex + 1) % room.order.length; }

    io.to(code).emit('history-update', room.history.map(slimHistory));
    io.to(code).emit('room-update', publicRoom(room));
  });

  socket.on('reset-room', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    for (const id of Object.keys(room.players)) {
      room.players[id].secret = null;
      room.players[id].ready = false;
    }
    room.history = [];
    room.winner = null;
    room.turnIndex = room.order.length === 2 ? (room.turnIndex + 1) % 2 : 0;
    io.to(code).emit('room-update', publicRoom(room));
    io.to(code).emit('room-reset', publicRoom(room));
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        room.order = room.order.filter(x => x !== socket.id);
        io.to(code).emit('room-update', publicRoom(room));
        if (Object.keys(room.players).length === 0) rooms.delete(code);
      }
    }
  });
});

function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    players: Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, ready: p.ready })),
    currentTurn: room.order[room.turnIndex] || null,
    winner: room.winner
  };
}
function slimHistory(h) { return { by: h.by, guess: h.guess, correctCount: h.correctCount, feedbackDigits: h.feedbackDigits, feedbackMask: h.feedbackMask, ts: h.ts }; }
app.get('/', (_, res) => res.send('1234 server OK'));
app.get('/health', (_, res) => res.json({ ok: true }));
httpServer.listen(PORT, () => { console.log(`server on :${PORT}`); });
