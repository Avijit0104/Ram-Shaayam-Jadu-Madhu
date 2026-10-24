'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseBotCard } = require('../src/bots');

const hand = (...names) => names.map((name, i) => ({ id: `h${i}`, name }));

test('bot passes a card of the name it holds fewest of', () => {
  const h = hand('Ram', 'Ram', 'Ram', 'Jadu', 'Ram');
  assert.equal(chooseBotCard(h, null).name, 'Jadu');
});

test('bot never passes the locked card', () => {
  const h = hand('Ram', 'Ram', 'Ram', 'Jadu', 'Madhu');
  for (let i = 0; i < 50; i++) {
    assert.notEqual(chooseBotCard(h, 'h3').id, 'h3');
  }
  assert.equal(chooseBotCard(h, 'h3').name, 'Madhu');
});

test('locked card still counts toward what the bot keeps', () => {
  // Holding 2 Jadu (one just received) and 1 Ram: should pass the Ram, keep Jadu.
  const h = hand('Jadu', 'Ram', 'Madhu', 'Madhu', 'Jadu');
  assert.equal(chooseBotCard(h, 'h4').name, 'Ram');
});
