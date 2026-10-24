'use strict';

// Server-side bot players that fill empty seats up to MIN_PLAYERS.

const BOT_NAMES = ['Raju', 'Pinky', 'Golu', 'Chintu', 'Munni', 'Bablu'];

// Greedy strategy: keep the names you hold most of, pass away one of the rarest.
// The locked (just received) card still counts toward what's worth keeping.
function chooseBotCard(hand, lockedCardId, rng = Math.random) {
  const counts = {};
  for (const c of hand) counts[c.name] = (counts[c.name] || 0) + 1;
  const options = hand.filter((c) => c.id !== lockedCardId);
  const fewest = Math.min(...options.map((c) => counts[c.name]));
  const worst = options.filter((c) => counts[c.name] === fewest);
  return worst[Math.floor(rng() * worst.length)];
}

module.exports = { BOT_NAMES, chooseBotCard };
