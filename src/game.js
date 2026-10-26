'use strict';

// Pure round logic: deck building, dealing, passing and win detection.
// No I/O here so it can be unit tested directly.

const BASE_NAMES = ['Ram', 'Shaayam', 'Jadu', 'Madhu'];
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 6;
const CARDS_PER_NAME = 4;
const HAND_SIZE = 4;
const SET_SIZE = 4;

class GameError extends Error {}

function buildDeck(names) {
  const deck = [];
  let n = 0;
  for (const name of names) {
    for (let i = 0; i < CARDS_PER_NAME; i++) deck.push({ id: `c${n++}`, name });
  }
  return deck;
}

function shuffle(cards, rng = Math.random) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns the name a hand has SET_SIZE of, or null.
function completedSet(hand) {
  const counts = {};
  for (const c of hand) {
    counts[c.name] = (counts[c.name] || 0) + 1;
    if (counts[c.name] >= SET_SIZE) return c.name;
  }
  return null;
}

// One card name per player, so the deck always splits into HAND_SIZE cards each.
// Re-deals if anyone is dealt a finished set, so nobody wins without playing.
function dealRound(playerIds, names, starterIndex = 0, rng = Math.random) {
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    throw new GameError(`Need ${MIN_PLAYERS}-${MAX_PLAYERS} players`);
  }
  if (names.length !== playerIds.length) {
    throw new GameError('Need exactly one card name per player');
  }
  let hands;
  do {
    const deck = shuffle(buildDeck(names), rng);
    hands = {};
    playerIds.forEach((id, i) => {
      hands[id] = deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE);
    });
  } while (playerIds.some((id) => completedSet(hands[id])));

  return {
    order: playerIds.slice(),
    names: names.slice(),
    hands,
    starterIndex,
    turnIndex: starterIndex,
    receivedCardId: null, // card the current player just got and may not pass on
    lastPass: null,
    passCount: 0, // total passes this round; never reset, so it identifies a turn
    passesSinceDeal: 0, // passes since the last deal or reshuffle
    reshuffles: 0,
    blockStreak: {}, // playerId -> consecutive blocking passes (see passCard)
    winner: null,
  };
}

// Collects every card and deals again within the same round. The player whose turn
// it is keeps the turn and passes from a fresh 4-card hand.
function reshuffle(round, rng = Math.random) {
  const fresh = dealRound(round.order, round.names, round.turnIndex, rng);
  round.hands = fresh.hands;
  round.receivedCardId = null;
  round.lastPass = null;
  round.passesSinceDeal = 0;
  round.blockStreak = {};
  round.reshuffles++;
  return round;
}

function currentPlayerId(round) {
  return round.order[round.turnIndex];
}

// The current player passes one card to the next player in order.
// Only the receiver can complete a set (the passer would already have won on receipt).
function passCard(round, playerId, cardId) {
  if (round.winner) throw new GameError('This round is over');
  if (currentPlayerId(round) !== playerId) throw new GameError("It's not your turn");
  const hand = round.hands[playerId];
  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) throw new GameError("You don't have that card");
  if (cardId === round.receivedCardId) {
    throw new GameError("You can't pass the card you just received");
  }

  const received = hand.find((c) => c.id === round.receivedCardId);
  const [card] = hand.splice(idx, 1);

  // Blocking: passing on the same name you just received while keeping a full hand
  // of all-different names. Holding one of each name forever means nobody else can
  // ever collect 4 of those names.
  const allDifferent = new Set(hand.map((c) => c.name)).size === hand.length;
  const blocking = !!received && card.name === received.name && allDifferent && hand.length >= HAND_SIZE;
  round.blockStreak[playerId] = blocking ? (round.blockStreak[playerId] || 0) + 1 : 0;

  const nextIndex = (round.turnIndex + 1) % round.order.length;
  const receiverId = round.order[nextIndex];
  round.hands[receiverId].push(card);
  round.receivedCardId = card.id;
  round.turnIndex = nextIndex;
  round.passCount++;
  round.passesSinceDeal++;
  round.lastPass = { from: playerId, to: receiverId };

  const setName = completedSet(round.hands[receiverId]);
  if (setName) round.winner = { playerId: receiverId, name: setName };
  return round;
}

module.exports = {
  BASE_NAMES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  CARDS_PER_NAME,
  HAND_SIZE,
  SET_SIZE,
  GameError,
  buildDeck,
  shuffle,
  completedSet,
  dealRound,
  currentPlayerId,
  passCard,
  reshuffle,
};
