import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { nanoid } from "nanoid";

const PORT = process.env.PORT || 4000;
const ALLOWED = (
  process.env.ALLOWED_ORIGINS || "http://localhost:5173,capacitor://localhost"
)
  .split(",")
  .map((s) => s.trim());

const app = express();
app.use(cors({ origin: ALLOWED }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: ALLOWED } });

const rooms = new Map();

// NEW: simple FIFO queues per mode
const queues = {
  CLASSIC: [],
  REVEAL_DIGITS: [],
  REVEAL_POSITIONS: [],
};

function enqueue(mode, socketId) {
  const q = queues[mode] || (queues[mode] = []);
  if (!q.includes(socketId)) q.push(socketId);
}

function dequeue(mode, socketId) {
  const q = queues[mode] || [];
  queues[mode] = q.filter((id) => id !== socketId);
}

function popOpponent(mode, exceptId) {
  const q = queues[mode] || [];
  for (let i = 0; i < q.length; i++) {
    if (q[i] !== exceptId) {
      const [opp] = q.splice(i, 1);
      return opp;
    }
  }
  return null;
}

function isInAnyQueue(id) {
  return Object.values(queues).some((q) => q.includes(id));
}

function makeRoom(mode = "CLASSIC") {
  const code = nanoid(6).toUpperCase();
  const room = {
    code,
    mode,
    players: {},
    order: [],
    turnIndex: 0,
    winner: null,
    history: [],
  };
  rooms.set(code, room);
  return room;
}

function countCorrectPositions(guess, secret) {
  let c = 0;
  for (let i = 0; i < 4; i++) if (guess[i] === secret[i]) c++;
  return c;
}

function feedbackDigits(guess, secret) {
  const g = guess.split("");
  const s = secret.split("");
  const set = new Set();
  for (const d of g) if (s.includes(d)) set.add(d);
  return [...set];
}

function feedbackMask(guess, secret) {
  return guess
    .split("")
    .map((d, i) => (d === secret[i] ? "●" : "○"))
    .join(" ");
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name, mode }, cb) => {
    // If queued, remove from queue before manual room flow
    const qMode = socket.data?.queueMode;
    if (qMode) {
      dequeue(qMode, socket.id);
      socket.data.queueMode = undefined;
    }

    const room = makeRoom((mode || "CLASSIC").toUpperCase());
    room.players[socket.id] = {
      name: name?.trim() || "Player A",
      secret: null,
      ready: false,
    };
    room.order.push(socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code; // track membership
    cb?.({ code: room.code });
    io.to(room.code).emit("room-update", publicRoom(room));
  });

  socket.on("join-room", ({ code, name }, cb) => {
    // If queued, remove from queue before manual join
    const qMode = socket.data?.queueMode;
    if (qMode) {
      dequeue(qMode, socket.id);
      socket.data.queueMode = undefined;
    }

    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb?.({ error: "Room not found" });
    if (Object.keys(room.players).length >= 2)
      return cb?.({ error: "Room is full" });

    room.players[socket.id] = {
      name: name?.trim() || "Player B",
      secret: null,
      ready: false,
    };
    room.order.push(socket.id);
    socket.join(room.code);
    socket.data.roomCode = room.code; // track membership
    cb?.({ code: room.code });
    io.to(room.code).emit("room-update", publicRoom(room));
  });

  socket.on("set-secret", ({ code, secret }) => {
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    if (!/^\d{4}$/.test(secret)) return;
    p.secret = secret;
    p.ready = true;
    const readyCount = Object.values(room.players).filter(
      (pl) => pl.ready
    ).length;
    if (readyCount === 2 && room.order.length === 2) {
      room.turnIndex = Math.round(Math.random());
      room.winner = null;
    }
    io.to(code).emit("room-update", publicRoom(room));
  });

  socket.on("guess", ({ code, guess }) => {
    const room = rooms.get(code);
    if (!room || room.winner) return;
    const idx = room.turnIndex % room.order.length;
    if (socket.id !== room.order[idx]) return;
    if (!/^\d{4}$/.test(guess)) {
      io.to(socket.id).emit("error-msg", "Guess must be 4 digits.");
      return;
    }
    const opp = room.order.find((id) => id !== socket.id);
    const oppPlayer = room.players[opp];
    if (!oppPlayer?.secret) {
      io.to(socket.id).emit("error-msg", "Opponent not ready yet.");
      return;
    }

    const correctCount = countCorrectPositions(guess, oppPlayer.secret);
    const item = { by: socket.id, guess, correctCount, ts: Date.now() };
    if (room.mode === "REVEAL_DIGITS")
      item.feedbackDigits = feedbackDigits(guess, oppPlayer.secret);
    if (room.mode === "REVEAL_POSITIONS")
      item.feedbackMask = feedbackMask(guess, oppPlayer.secret);
    room.history.push(item);

    if (correctCount === 4) {
      room.winner = socket.id;
      io.to(code).emit("game-over", { winner: socket.id });
    } else {
      room.turnIndex = (room.turnIndex + 1) % room.order.length;
    }

    io.to(code).emit("history-update", room.history.map(slimHistory));
    io.to(code).emit("room-update", publicRoom(room));

    // --- QUEUE: JOIN ---
    socket.on("queue:join", ({ mode, name }, cb) => {
      mode = (mode || "CLASSIC").toUpperCase();
      if (!queues[mode]) return cb?.({ error: "Unknown mode" });

      // Don't allow queueing if already in a room
      if (socket.data.roomCode) return cb?.({ error: "Already in a room" });

      // Avoid double-queueing
      if (isInAnyQueue(socket.id)) return cb?.({ error: "Already queued" });

      socket.data.playerName = name?.trim() || "Player";
      socket.data.queueMode = mode;

      enqueue(mode, socket.id);
      cb?.({ ok: true });
      io.to(socket.id).emit("queue:joined", { mode });

      // Try to match
      const opponentId = popOpponent(mode, socket.id);
      if (opponentId) {
        // Also remove self from queue
        dequeue(mode, socket.id);

        const oppSocket = io.sockets.sockets.get(opponentId);
        if (!oppSocket) {
          // Opponent vanished – re-enqueue self
          enqueue(mode, socket.id);
          return;
        }

        // Create room & add both
        const room = makeRoom(mode);
        const meName = socket.data.playerName || "Player A";
        const oppName = oppSocket.data.playerName || "Player B";

        room.players[socket.id] = { name: meName, secret: null, ready: false };
        room.players[opponentId] = {
          name: oppName,
          secret: null,
          ready: false,
        };
        room.order.push(socket.id, opponentId);

        socket.join(room.code);
        oppSocket.join(room.code);
        socket.data.roomCode = room.code;
        oppSocket.data.roomCode = room.code;

        // Let them know they’re matched
        io.to(socket.id).emit("queue:matched", { code: room.code, mode });
        io.to(opponentId).emit("queue:matched", { code: room.code, mode });

        io.to(room.code).emit("room-update", publicRoom(room));
      }
    });
  });

  socket.on("queue:leave", (_, cb) => {
    const mode = socket.data?.queueMode;
    if (mode) dequeue(mode, socket.id);
    socket.data.queueMode = undefined;
    cb?.({ ok: true });
  });

  socket.on("reset-room", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;

    // If one player left, destroy instead of resetting
    if (Object.keys(room.players).length < 2) {
      destroyRoom(code, "player-left");
      return;
    }

    // Normal reset
    for (const id of Object.keys(room.players)) {
      room.players[id].secret = null;
      room.players[id].ready = false;
    }
    room.history = [];
    room.winner = null;
    room.turnIndex = room.order.length === 2 ? (room.turnIndex + 1) % 2 : 0;

    io.to(code).emit("room-update", publicRoom(room));
    io.to(code).emit("room-reset", publicRoom(room));
  });

  function destroyRoom(code, reason = "player-left") {
    const room = rooms.get(code);
    if (!room) return;

    io.to(code).emit("room-destroyed", { reason });
    try {
      // clear membership markers
      for (const id of Object.keys(room.players)) {
        const s = io.sockets.sockets.get(id);
        if (s) s.data.roomCode = undefined;
      }
      io.in(code).socketsLeave(code);
    } catch {}

    rooms.delete(code);
  }

  socket.on("leave-room", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (!room.players[socket.id]) return;
    destroyRoom(code, "player-left");
  });

  socket.on("disconnecting", () => {
    // If queued, remove
    const qMode = socket.data?.queueMode;
    if (qMode) dequeue(qMode, socket.id);

    // If in a room, destroy (keeps your current behavior)
    const code = socket.data?.roomCode;
    if (code && rooms.has(code)) {
      destroyRoom(code, "player-left");
    }
  });

  socket.on("disconnect", () => {
    // Also sweep queues just in case
    Object.keys(queues).forEach((m) => dequeue(m, socket.id));
  });
});

function publicRoom(room) {
  return {
    code: room.code,
    mode: room.mode,
    players: Object.entries(room.players).map(([id, p]) => ({
      id,
      name: p.name,
      ready: p.ready,
    })),
    currentTurn: room.order[room.turnIndex] || null,
    winner: room.winner,
  };
}
function slimHistory(h) {
  return {
    by: h.by,
    guess: h.guess,
    correctCount: h.correctCount,
    feedbackDigits: h.feedbackDigits,
    feedbackMask: h.feedbackMask,
    ts: h.ts,
  };
}
app.get("/", (_, res) => res.send("1234 server OK"));
app.get("/health", (_, res) => res.json({ ok: true }));
httpServer.listen(PORT, () => {
  console.log(`server on :${PORT}`);
});
