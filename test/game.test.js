'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BASE_NAMES,
  GameError,
  buildDeck,
  completedSet,
  dealRound,
  currentPlayerId,
  passCard,
} = require('../src/game');

const P4 = ['a', 'b', 'c', 'd'];

// Hand-built round so tests don't depend on shuffling.
function fixedRound(hands, turnIndex = 0) {
  const order = Object.keys(hands);
  let n = 0;
  const built = {};
  for (const id of order) built[id] = hands[id].map((name) => ({ id: `x${n++}`, name }));
  return {
    order,
    names: BASE_NAMES,
    hands: built,
    starterIndex: turnIndex,
    turnIndex,
    receivedCardId: null,
    lastPass: null,
    passCount: 0,
    winner: null,
  };
}

test('deck has 4 cards per name', () => {
  const deck = buildDeck(['Ram', 'Shaayam', 'Jadu', 'Madhu', 'Kanu']);
  assert.equal(deck.length, 20);
  assert.equal(deck.filter((c) => c.name === 'Kanu').length, 4);
  assert.equal(new Set(deck.map((c) => c.id)).size, 20);
});

test('deal gives each player 4 cards and no finished sets', () => {
  for (let i = 0; i < 200; i++) {
    const r = dealRound(P4, BASE_NAMES, 2);
    for (const id of P4) {
      assert.equal(r.hands[id].length, 4);
      assert.equal(completedSet(r.hands[id]), null);
    }
    assert.equal(currentPlayerId(r), 'c');
    assert.equal(r.receivedCardId, null);
  }
});

test('deal supports 6 players with 24 cards', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const r = dealRound(ids, [...BASE_NAMES, 'Kanu', 'Lalu']);
  const all = ids.flatMap((id) => r.hands[id]);
  assert.equal(all.length, 24);
});

test('deal rejects bad player counts and name counts', () => {
  assert.throws(() => dealRound(['a', 'b', 'c'], BASE_NAMES.slice(0, 3)), GameError);
  assert.throws(() => dealRound(['a', 'b', 'c', 'd', 'e'], BASE_NAMES), GameError);
});

test('passing moves a card to the next player and locks it for them', () => {
  const r = fixedRound({
    a: ['Ram', 'Ram', 'Jadu', 'Madhu'],
    b: ['Shaayam', 'Shaayam', 'Jadu', 'Madhu'],
    c: ['Ram', 'Shaayam', 'Jadu', 'Madhu'],
    d: ['Ram', 'Shaayam', 'Jadu', 'Madhu'],
  });
  const card = r.hands.a[2];
  passCard(r, 'a', card.id);
  assert.equal(r.hands.a.length, 3);
  assert.equal(r.hands.b.length, 5);
  assert.equal(currentPlayerId(r), 'b');
  assert.equal(r.receivedCardId, card.id);
  assert.deepEqual(r.lastPass, { from: 'a', to: 'b' });

  assert.throws(() => passCard(r, 'b', card.id), /just received/);
  passCard(r, 'b', r.hands.b[0].id);
  assert.equal(currentPlayerId(r), 'c');
});

test('only the current player can pass, and only their own cards', () => {
  const r = fixedRound({
    a: ['Ram', 'Ram', 'Jadu', 'Madhu'],
    b: ['Shaayam', 'Shaayam', 'Jadu', 'Madhu'],
    c: ['Ram', 'Shaayam', 'Jadu', 'Madhu'],
    d: ['Ram', 'Shaayam', 'Jadu', 'Madhu'],
  });
  assert.throws(() => passCard(r, 'b', r.hands.b[0].id), /not your turn/);
  assert.throws(() => passCard(r, 'a', r.hands.b[0].id), /don't have/);
});

test('turn wraps from last player to first', () => {
  const r = fixedRound({
    a: ['Ram', 'Ram', 'Jadu', 'Madhu'],
    b: ['Shaayam', 'Shaayam', 'Jadu', 'Madhu'],
    c: ['Ram', 'Shaayam', 'Jadu', 'Madhu'],
    d: ['Ram', 'Shaayam', 'Jadu', 'Madhu'],
  }, 3);
  passCard(r, 'd', r.hands.d[0].id);
  assert.equal(currentPlayerId(r), 'a');
  assert.equal(r.hands.a.length, 5);
});

test('receiving the fourth matching card wins', () => {
  const r = fixedRound({
    a: ['Jadu', 'Ram', 'Shaayam', 'Madhu'],
    b: ['Jadu', 'Jadu', 'Jadu', 'Madhu'],
    c: ['Ram', 'Shaayam', 'Ram', 'Madhu'],
    d: ['Ram', 'Shaayam', 'Shaayam', 'Madhu'],
  });
  passCard(r, 'a', r.hands.a[0].id);
  assert.deepEqual(r.winner, { playerId: 'b', name: 'Jadu' });
  assert.throws(() => passCard(r, 'b', r.hands.b[0].id), /over/);
});
