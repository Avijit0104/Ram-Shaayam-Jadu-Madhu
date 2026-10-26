'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RoomStore,
  MIN_PASSES_FOR_VOTE,
  BLOCK_STREAK,
  VOTE_COOLDOWN_PASSES,
} = require('../src/rooms');

const tok = (n) => String(n).padStart(32, '0');

// Four people in a running round, with enough passes made to allow a vote.
function votingRoom() {
  const clock = { t: 1000000 };
  const store = new RoomStore({ now: () => clock.t });
  const room = store.createRoom(tok(1), 'Host');
  for (let i = 2; i <= 4; i++) store.joinRoom(tok(i), room.code, `P${i}`);
  store.startGame(tok(1));
  room.round.passesSinceDeal = MIN_PASSES_FOR_VOTE;
  return { store, room, clock, view: (n) => store.viewFor(room, room.players[n - 1].id) };
}

// Rigs the host (whose turn it is) to block: one of each name plus a received Ram,
// with BLOCK_STREAK - 1 blocking turns already made. Passing the other Ram triggers.
function rigBlocker(room) {
  const host = room.players[0].id;
  const next = room.round.order[1];
  room.round.hands[host] = [
    { id: 'r1', name: 'Ram' }, { id: 's1', name: 'Shaayam' }, { id: 'j1', name: 'Jadu' },
    { id: 'm1', name: 'Madhu' }, { id: 'r2', name: 'Ram' },
  ];
  room.round.hands[next] = [
    { id: 'j2', name: 'Jadu' }, { id: 'j3', name: 'Jadu' }, { id: 's2', name: 'Shaayam' }, { id: 'm2', name: 'Madhu' },
  ];
  room.round.receivedCardId = 'r2';
  room.round.blockStreak[host] = BLOCK_STREAK - 1;
  return host;
}

test('a reshuffle vote can only be asked for after 15 passes', () => {
  const { store, room, view } = votingRoom();
  room.round.passesSinceDeal = MIN_PASSES_FOR_VOTE - 1;
  assert.equal(view(2).canRequestVote, false);
  assert.throws(() => store.requestReshuffle(tok(2)), /after 15 passes/);
  room.round.passesSinceDeal = MIN_PASSES_FOR_VOTE;
  assert.equal(view(2).canRequestVote, true);
  store.requestReshuffle(tok(2));
  assert.equal(room.vote.kind, 'manual');
  assert.equal(view(3).canRequestVote, false);
  assert.throws(() => store.requestReshuffle(tok(3)), /already running/);
});

test('a manual reshuffle needs everyone, then deals fresh cards', () => {
  const { store, room, view } = votingRoom();
  const turnBefore = room.round.turnIndex;
  store.requestReshuffle(tok(2));
  assert.deepEqual([view(2).vote.yes, view(2).vote.total, view(2).vote.canVote], [1, 4, false]);
  store.castVote(tok(1), true);
  store.castVote(tok(3), true);
  assert.ok(room.vote, 'still waiting for the last person');
  assert.throws(() => store.castVote(tok(3), true), /already voted/);
  store.castVote(tok(4), true);
  assert.equal(room.vote, null);
  assert.deepEqual(room.voteResult, { id: 1, kind: 'manual', passed: true });
  assert.equal(room.round.reshuffles, 1);
  assert.equal(room.round.passesSinceDeal, 0);
  assert.equal(room.round.turnIndex, turnBefore);
  for (const id of room.round.order) assert.equal(room.round.hands[id].length, 4);
});

test('one No fails a manual vote and starts a cooldown', () => {
  const { store, room } = votingRoom();
  store.requestReshuffle(tok(2));
  store.castVote(tok(3), false);
  assert.equal(room.vote, null);
  assert.equal(room.voteResult.passed, false);
  assert.equal(room.round.reshuffles, 0);
  const at = MIN_PASSES_FOR_VOTE + VOTE_COOLDOWN_PASSES;
  assert.throws(() => store.requestReshuffle(tok(2)), new RegExp(`after ${at} passes`));
});

test('a manual vote times out unless the only missing votes are from offline players', () => {
  const a = votingRoom();
  a.store.requestReshuffle(tok(2));
  a.store.castVote(tok(1), true);
  a.store.castVote(tok(3), true); // P4 never answers
  a.clock.t = a.room.vote.endsAt;
  a.store.expireVote(a.store.pendingVote(a.room));
  assert.equal(a.room.voteResult.passed, false);

  const b = votingRoom();
  b.store.requestReshuffle(tok(2));
  b.store.castVote(tok(1), true);
  b.store.castVote(tok(3), true);
  b.store.setConnected(tok(4), false);
  assert.ok(b.room.vote, 'going offline is not a vote by itself');
  b.clock.t = b.room.vote.endsAt;
  b.store.expireVote(b.store.pendingVote(b.room));
  assert.equal(b.room.voteResult.passed, true);
});

test('blocking 4 turns in a row starts an anonymous majority vote the blocker cannot join', () => {
  const { store, room, view } = votingRoom();
  const blocker = rigBlocker(room);
  store.pass(tok(1), 'r1');
  assert.equal(room.vote.kind, 'blocking');
  assert.equal(view(1).vote.canVote, false);
  assert.equal(view(2).vote.canVote, true);
  assert.equal(view(2).vote.total, 3);
  assert.ok(!JSON.stringify(view(2).vote).includes(blocker), 'the blocker is not revealed');
  assert.throws(() => store.castVote(tok(1), true), /can't vote/);

  store.castVote(tok(2), true);
  assert.ok(room.vote, '1 of 3 is not a majority');
  store.castVote(tok(3), true);
  assert.equal(room.vote, null);
  assert.deepEqual(room.voteResult, { id: 1, kind: 'blocking', passed: true });
  assert.equal(room.round.reshuffles, 1);
});

test('a blocking vote fails once a majority says No, and the blocker must block again', () => {
  const { store, room } = votingRoom();
  const blocker = rigBlocker(room);
  store.pass(tok(1), 'r1');
  store.castVote(tok(2), false);
  store.castVote(tok(3), false);
  assert.equal(room.voteResult.passed, false);
  assert.equal(room.round.blockStreak[blocker], 0);
  assert.equal(room.round.reshuffles, 0);
});

test('when a blocking vote times out, missing votes count as Yes', () => {
  const { store, room, clock } = votingRoom();
  rigBlocker(room);
  store.pass(tok(1), 'r1');
  store.castVote(tok(2), false);
  clock.t = room.vote.endsAt - 1;
  assert.equal(store.expireVote(store.pendingVote(room)), null, 'not due yet');
  clock.t += 1;
  store.expireVote(store.pendingVote(room));
  assert.equal(room.voteResult.passed, true);
});

test('blocking is not flagged before 15 passes', () => {
  const { store, room } = votingRoom();
  rigBlocker(room);
  room.round.passesSinceDeal = 3;
  store.pass(tok(1), 'r1');
  assert.equal(room.vote, null);
});

test('bots vote yes, so a blocker against bots is reshuffled straight away', () => {
  const store = new RoomStore();
  const room = store.createRoom(tok(1), 'Solo');
  store.startGame(tok(1));
  room.round.passesSinceDeal = MIN_PASSES_FOR_VOTE;
  rigBlocker(room);
  store.pass(tok(1), 'r1');
  assert.equal(room.vote, null);
  assert.equal(room.voteResult.passed, true);
  assert.equal(room.round.reshuffles, 1);
});

test('watchers cannot ask for or vote in a reshuffle', () => {
  const { store, room } = votingRoom();
  store.joinRoom(tok(5), room.code, 'Late');
  assert.throws(() => store.requestReshuffle(tok(5)), /watching/);
  store.requestReshuffle(tok(2));
  assert.throws(() => store.castVote(tok(5), true), /can't vote/);
});

test('a reshuffle makes the pending turn timer stale', () => {
  const { store, room, clock } = votingRoom();
  const ticket = store.pendingTurn(room);
  store.requestReshuffle(tok(1));
  for (const n of [2, 3, 4]) store.castVote(tok(n), true);
  clock.t = ticket.dueAt;
  assert.equal(store.autoPass(ticket), null);
});

test('a win ends any running vote', () => {
  const { store, room } = votingRoom();
  store.requestReshuffle(tok(2));
  const host = room.players[0].id;
  const next = room.round.order[1];
  room.round.hands[host] = [
    { id: 'w', name: 'Jadu' }, { id: 'a2', name: 'Ram' }, { id: 'a3', name: 'Ram' }, { id: 'a4', name: 'Madhu' },
  ];
  room.round.hands[next] = [
    { id: 'b1', name: 'Jadu' }, { id: 'b2', name: 'Jadu' }, { id: 'b3', name: 'Jadu' }, { id: 'b4', name: 'Madhu' },
  ];
  store.pass(tok(1), 'w');
  assert.equal(room.phase, 'roundOver');
  assert.equal(room.vote, null);
  assert.equal(store.viewFor(room, room.players[1].id).vote, null);
});
