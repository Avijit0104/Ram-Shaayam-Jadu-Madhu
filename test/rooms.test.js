'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomStore } = require('../src/rooms');

const tok = (n) => String(n).padStart(32, '0');

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

test('only host can start, and needs 4 players', () => {
  const { store } = roomWith(3);
  assert.throws(() => store.startGame(tok(1)), /at least 4/);
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
