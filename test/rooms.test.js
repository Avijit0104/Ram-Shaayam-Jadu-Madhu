'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RoomStore,
  TURN_MS,
  OFFLINE_GRACE_MS,
  BOT_MIN_MS,
  BOT_JITTER_MS,
} = require('../src/rooms');
const { chooseBotCard } = require('../src/bots');

const tok = (n) => String(n).padStart(32, '0');

// A store whose clock only moves when a test moves it.
function clockedStore() {
  const clock = { t: 1000000 };
  return { store: new RoomStore({ now: () => clock.t }), clock };
}

// Jumps the clock to when the current turn is due and lets the server play it.
function runDueTurn(store, clock, room) {
  const ticket = store.pendingTurn(room);
  clock.t = Math.max(clock.t, ticket.dueAt);
  return store.autoPass(ticket);
}

const isBotTurn = (room) => room.players.find((p) => p.id === room.round.order[room.round.turnIndex]).bot;

function roomWith(count) {
  const store = new RoomStore();
  const room = store.createRoom(tok(1), 'Host');
  for (let i = 2; i <= count; i++) store.joinRoom(tok(i), room.code, `P${i}`);
  return { store, room };
}

test('create and join a room', () => {
  const { store, room } = roomWith(4);
  assert.equal(room.players.length, 4);
  assert.equal(room.hostId, room.players[0].id);
  assert.equal(store.roomForToken(tok(3)), room);
});

test('join validation', () => {
  const { store, room } = roomWith(6);
  assert.throws(() => store.joinRoom(tok(7), room.code, 'P7'), /full/);
  assert.throws(() => store.joinRoom(tok(7), 'ZZZZ', 'P7'), /not found/);
  const { store: s2, room: r2 } = roomWith(2);
  assert.throws(() => s2.joinRoom(tok(9), r2.code, 'host'), /already has that name/);
});

test('rejoining with the same token keeps the seat', () => {
  const { store, room } = roomWith(4);
  store.setConnected(tok(2), false);
  store.joinRoom(tok(2), room.code, 'Whatever');
  assert.equal(room.players.length, 4);
  assert.equal(room.players[1].connected, true);
  assert.equal(room.players[1].name, 'P2');
});

test('only host can start; 4+ humans means no bots', () => {
  const { store: s4, room } = roomWith(4);
  assert.throws(() => s4.startGame(tok(2)), /Only the host/);
  s4.startGame(tok(1));
  assert.equal(room.phase, 'playing');
  assert.deepEqual(room.round.names, ['Ram', 'Shaayam', 'Jadu', 'Madhu']);
});

test('5 and 6 players need extra card names from the host', () => {
  const { store, room } = roomWith(6);
  assert.throws(() => store.startGame(tok(1)), /2 extra card names/);
  store.setExtraNames(tok(1), ['Kanu', 'ram']);
  assert.throws(() => store.startGame(tok(1)), /already used/);
  store.setExtraNames(tok(1), ['Kanu', 'Lalu']);
  store.startGame(tok(1));
  assert.equal(room.round.names.length, 6);
  assert.throws(() => store.setExtraNames(tok(2), ['x']), /Only the host/);
});

test('views hide other hands and tokens until the round ends', () => {
  const { store, room } = roomWith(4);
  store.startGame(tok(1));
  const me = room.players[1];
  const view = store.viewFor(room, me.id);
  assert.equal(view.round.yourHand.length, 4);
  assert.equal(view.round.revealedHands, null);
  assert.ok(!JSON.stringify(view).includes(tok(1)));
  const otherCard = room.round.hands[room.players[0].id][0];
  assert.ok(!JSON.stringify(view).includes(`"${otherCard.id}"`));
});

test('winning ends the round, scores, and next round rotates starter', () => {
  const { store, room } = roomWith(4);
  store.startGame(tok(1));
  const [a, b] = room.players;
  // Rig hands so the first pass wins for b.
  room.round.hands[a.id] = [
    { id: 'w', name: 'Jadu' }, { id: 'a2', name: 'Ram' }, { id: 'a3', name: 'Ram' }, { id: 'a4', name: 'Madhu' },
  ];
  room.round.hands[b.id] = [
    { id: 'b1', name: 'Jadu' }, { id: 'b2', name: 'Jadu' }, { id: 'b3', name: 'Jadu' }, { id: 'b4', name: 'Madhu' },
  ];
  store.pass(tok(1), 'w');
  assert.equal(room.phase, 'roundOver');
  assert.equal(b.score, 1);
  assert.ok(store.viewFor(room, a.id).round.revealedHands);

  store.nextRound(tok(1));
  assert.equal(room.phase, 'playing');
  assert.equal(room.round.order[room.round.starterIndex], b.id);
});

test('leaving mid-round returns everyone to the lobby and passes host', () => {
  const { store, room } = roomWith(4);
  store.startGame(tok(1));
  store.leave(tok(1));
  assert.equal(room.phase, 'lobby');
  assert.equal(room.round, null);
  assert.equal(room.hostId, room.players[0].id);
  assert.match(room.notice, /Host left/);
});

test('last player leaving deletes the room', () => {
  const { store, room } = roomWith(1);
  assert.equal(store.leave(tok(1)), null);
  assert.equal(store.rooms.has(room.code), false);
});

test('kick only works for host in lobby', () => {
  const { store, room } = roomWith(4);
  const target = room.players[2];
  assert.throws(() => store.kick(tok(2), target.id), /Only the host/);
  const { kickedToken } = store.kick(tok(1), target.id);
  assert.equal(kickedToken, tok(3));
  assert.equal(room.players.length, 3);
  assert.equal(store.roomForToken(tok(3)), null);
});

test('bots fill empty seats up to 4 and leave on return to lobby', () => {
  for (const humans of [1, 2, 3]) {
    const { store, room } = roomWith(humans);
    assert.equal(store.viewFor(room, room.players[0].id).botsNeeded, 4 - humans);
    store.startGame(tok(1));
    assert.equal(room.players.length, 4);
    assert.equal(room.players.filter((p) => p.bot).length, 4 - humans);
    assert.equal(room.round.names.length, 4);
    store.toLobby(tok(1));
    assert.equal(room.players.length, humans);
  }
});

test('bot names never clash with human names', () => {
  const store = new RoomStore();
  const room = store.createRoom(tok(1), 'raju');
  store.startGame(tok(1));
  const names = room.players.map((p) => p.name.toLowerCase());
  assert.equal(new Set(names).size, 4);
});

test('a solo player can finish a round against bots', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  const me = room.players[0];
  for (let i = 0; i < 10000 && room.phase === 'playing'; i++) {
    if (isBotTurn(room)) {
      assert.ok(runDueTurn(store, clock, room));
    } else {
      const r = room.round;
      store.pass(tok(1), chooseBotCard(r.hands[me.id], r.receivedCardId).id);
    }
  }
  assert.equal(room.phase, 'roundOver');
});

test('stale turn tickets are ignored', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  const ticket = store.pendingTurn(room);
  clock.t = ticket.dueAt;
  assert.ok(store.autoPass(ticket));
  assert.equal(store.autoPass(ticket), null);
});

test('bots move 1.2-2s into their turn', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  const r = room.round;
  store.pass(tok(1), chooseBotCard(r.hands[room.players[0].id], r.receivedCardId).id);
  assert.ok(isBotTurn(room));
  const wait = store.pendingTurn(room).dueAt - clock.t;
  assert.ok(wait >= BOT_MIN_MS && wait <= BOT_MIN_MS + BOT_JITTER_MS, `bot wait ${wait}`);
});

test('a person who runs out of time gets a card passed for them', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Solo'); // the host starts round 1
  store.startGame(tok(1));
  const ticket = store.pendingTurn(room);
  assert.equal(ticket.dueAt - clock.t, TURN_MS);

  clock.t += TURN_MS - 1;
  assert.equal(store.autoPass(ticket), null, 'not due yet');
  clock.t += 1;
  assert.ok(store.autoPass(ticket));
  assert.equal(room.round.hands[room.players[0].id].length, 3);
  assert.equal(room.round.lastPass.auto, true);
});

test('bot passes are not marked as timed out', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  const r = room.round;
  store.pass(tok(1), chooseBotCard(r.hands[room.players[0].id], r.receivedCardId).id);
  runDueTurn(store, clock, room);
  assert.equal(room.round.lastPass.auto, undefined);
});

test('an offline player is skipped after the grace period, not the full turn', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  clock.t += 5000;
  store.setConnected(tok(1), false);
  assert.equal(store.pendingTurn(room).dueAt, clock.t + OFFLINE_GRACE_MS);

  // Coming back restores the normal deadline.
  store.setConnected(tok(1), true);
  assert.equal(store.pendingTurn(room).dueAt, room.round.turnStartedAt + TURN_MS);
});

test('a player already offline when their turn starts is skipped after the grace period', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  store.setConnected(tok(1), false);
  const me = room.players[0];
  let checked = false;
  for (let i = 0; i < 1000 && !checked; i++) {
    if (room.phase === 'roundOver') store.nextRound(tok(1));
    else if (!isBotTurn(room) && room.round.turnStartedAt > me.offlineSince) {
      assert.equal(store.pendingTurn(room).dueAt, room.round.turnStartedAt + OFFLINE_GRACE_MS);
      checked = true;
    } else {
      clock.t += 1; // make the next turn start strictly after going offline
      runDueTurn(store, clock, room);
    }
  }
  assert.ok(checked);
});

test('people joining mid-game watch, then take a bot seat next round', () => {
  const { store, clock } = clockedStore();
  const room = store.createRoom(tok(1), 'Host');
  store.joinRoom(tok(2), room.code, 'P2');
  store.startGame(tok(1)); // 2 people + 2 bots
  const order = room.round.order.slice();

  store.joinRoom(tok(3), room.code, 'Late');
  const late = room.players.find((p) => p.name === 'Late');
  assert.equal(late.spectator, true);
  assert.equal(room.phase, 'playing');
  assert.deepEqual(room.round.order, order);
  assert.throws(() => store.pass(tok(3), 'c0'), /not your turn/);

  const view = store.viewFor(room, late.id);
  assert.equal(view.spectating, true);
  assert.equal(view.seatNextRound, true);
  assert.deepEqual(view.round.yourHand, []);

  // Finish the round, then deal again.
  for (let i = 0; i < 10000 && room.phase === 'playing'; i++) runDueTurn(store, clock, room);
  const firstBotSeat = order.findIndex((id) => room.players.find((p) => p.id === id).bot);
  store.nextRound(tok(1));
  assert.equal(late.spectator, false);
  assert.equal(room.round.order.length, 4);
  assert.equal(room.round.order[firstBotSeat], late.id);
  assert.equal(room.players.filter((p) => p.bot).length, 1);
});

test('without a bot seat, late joiners wait for the lobby', () => {
  const { store, room } = roomWith(4);
  store.startGame(tok(1));
  store.joinRoom(tok(5), room.code, 'Late');
  const late = room.players.find((p) => p.name === 'Late');
  assert.equal(store.viewFor(room, late.id).seatNextRound, false);
  store.toLobby(tok(1));
  assert.equal(late.spectator, false);
  assert.equal(room.players.length, 5);
});

test('a spectator leaving does not end the round', () => {
  const { store, room } = roomWith(4);
  store.startGame(tok(1));
  store.joinRoom(tok(5), room.code, 'Late');
  store.leave(tok(5));
  assert.equal(room.phase, 'playing');
  assert.equal(room.players.length, 4);
});

test('spectators count toward the room limit and cannot reuse bot names', () => {
  const store = new RoomStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  const botName = room.players.find((p) => p.bot).name;
  assert.throws(() => store.joinRoom(tok(2), room.code, botName), /already has that name/);
  for (let i = 2; i <= 6; i++) store.joinRoom(tok(i), room.code, `W${i}`);
  assert.throws(() => store.joinRoom(tok(7), room.code, 'W7'), /full/);
});

test('last human leaving deletes a room with bots', () => {
  const store = new RoomStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  assert.equal(store.leave(tok(1)), null);
  assert.equal(store.rooms.has(room.code), false);
});

test('views mark bots and never include their hands mid-round', () => {
  const store = new RoomStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  const view = store.viewFor(room, room.players[0].id);
  assert.equal(view.players.filter((p) => p.bot).length, 3);
  assert.equal(view.round.revealedHands, null);
});
