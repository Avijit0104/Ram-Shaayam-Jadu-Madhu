'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { GameError } = require('./src/game');
const { RoomStore } = require('./src/rooms');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });
const store = new RoomStore();

// Every socket joins a channel named after its secret token, so all of a player's
// tabs/reconnects get the same personalised state.
const channel = (token) => `t:${token}`;
const socketCounts = new Map(); // token -> number of open sockets

function broadcast(room) {
  if (!room) return;
  for (const p of room.players) {
    if (!p.bot) io.to(channel(p.token)).emit('state', store.viewFor(room, p.id));
  }
  scheduleBot(room);
}

// Bots move on a short timer so humans can follow the cards going round.
// At most one pending timer per room; the ticket makes stale timers no-ops.
const BOT_DELAY_MS = 1200;
const botTimers = new Map(); // room code -> timeout

function scheduleBot(room) {
  if (botTimers.has(room.code)) return;
  const ticket = store.pendingBotTurn(room);
  if (!ticket) return;
  const timer = setTimeout(() => {
    botTimers.delete(ticket.code);
    const updated = store.botPass(ticket);
    if (updated) broadcast(updated);
    else if (store.rooms.has(ticket.code)) scheduleBot(store.rooms.get(ticket.code));
  }, BOT_DELAY_MS + Math.random() * 800);
  botTimers.set(room.code, timer);
}

function sendHome(token, notice) {
  io.to(channel(token)).emit('state', null, notice || null);
}

io.on('connection', (socket) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (typeof token !== 'string' || !/^[a-f0-9]{32,64}$/.test(token)) {
    socket.emit('fatal', 'Invalid session. Reload the page.');
    socket.disconnect(true);
    return;
  }
  socket.join(channel(token));
  socketCounts.set(token, (socketCounts.get(token) || 0) + 1);

  const resumed = store.setConnected(token, true);
  if (resumed) broadcast(resumed);
  else socket.emit('state', null, null);

  // Wraps a handler: GameErrors go back to the caller via the ack, anything else is logged.
  const on = (event, fn) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        fn(payload || {});
        reply({ ok: true });
      } catch (err) {
        if (err instanceof GameError) reply({ ok: false, error: err.message });
        else {
          console.error(`[${event}]`, err);
          reply({ ok: false, error: 'Something went wrong' });
        }
      }
    });
  };

  on('room:create', ({ name }) => {
    const previous = store.roomForToken(token);
    const room = store.createRoom(token, name);
    if (previous && previous !== room) broadcast(store.rooms.get(previous.code));
    broadcast(room);
  });

  on('room:join', ({ code, name }) => {
    const previous = store.roomForToken(token);
    const room = store.joinRoom(token, code, name);
    if (previous && previous !== room) broadcast(store.rooms.get(previous.code));
    broadcast(room);
  });

  on('room:leave', () => {
    broadcast(store.leave(token));
    sendHome(token);
  });

  on('room:kick', ({ playerId }) => {
    const { room, kickedToken } = store.kick(token, playerId);
    broadcast(room);
    sendHome(kickedToken, 'The host removed you from the room');
  });

  on('room:extraNames', ({ names }) => broadcast(store.setExtraNames(token, names)));
  on('game:start', () => broadcast(store.startGame(token)));
  on('game:pass', ({ cardId }) => broadcast(store.pass(token, cardId)));
  on('game:nextRound', () => broadcast(store.nextRound(token)));
  on('game:toLobby', () => broadcast(store.toLobby(token)));

  socket.on('disconnect', () => {
    const left = (socketCounts.get(token) || 1) - 1;
    if (left > 0) {
      socketCounts.set(token, left);
      return;
    }
    socketCounts.delete(token);
    broadcast(store.setConnected(token, false));
  });
});

setInterval(() => store.sweep(), 10 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`RSJM listening on http://localhost:${PORT}`);
});
