'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/shared/thirteen');

// Cards by name: '3D' = 3♦, 'AS' = A♠, '10H' = 10♥, '2C' = 2♣.
const c = (s) => {
  const r = T.RANKS.indexOf(s.slice(0, -1));
  const su = 'DCHS'.indexOf(s.slice(-1));
  return r * 4 + su;
};
const cs = (...xs) => xs.map(c);

test('card order: 3 lowest, 2 highest; suits ♦ < ♣ < ♥ < ♠', () => {
  assert.strictEqual(c('3D'), 0);
  assert.strictEqual(c('2S'), 51);
  assert.ok(c('3S') > c('3H') && c('3H') > c('3C') && c('3C') > c('3D'));
  assert.strictEqual(T.name(c('10H')), '10♥');
});

test('combinations and what beats what', () => {
  assert.strictEqual(T.classify(cs('5D', '5S')).type, 'pair');
  assert.strictEqual(T.classify(cs('5D', '6S')), null);
  assert.strictEqual(T.classify(cs('5D', '5S', '5H', '5C')), null, 'four cards alone are not a play');
  assert.strictEqual(T.classify(cs('3D', '4C', '5H', '6S', '7D')).type, 'straight');
  assert.strictEqual(T.classify(cs('JD', 'QC', 'KH', 'AS', '2D')), null, 'no 2 in a straight');
  assert.strictEqual(T.classify(cs('AD', '2C', '3H', '4S', '5D')), null);
  assert.strictEqual(T.classify(cs('3H', '7H', '9H', 'JH', 'KH')).type, 'flush');
  assert.strictEqual(T.classify(cs('8D', '8C', '8H', 'KS', 'KD')).type, 'fullhouse');
  assert.strictEqual(T.classify(cs('9D', '9C', '9H', '9S', '3D')).type, 'four');
  assert.strictEqual(T.classify(cs('5S', '6S', '7S', '8S', '9S')).type, 'straightflush');
  const b = (x, y) => T.beats(T.classify(cs(...x)), T.classify(cs(...y)));
  assert.ok(b(['2D'], ['AS']), 'a 2 beats an ace');
  assert.ok(b(['5S'], ['5H']), 'same rank: higher suit');
  assert.ok(!b(['5H'], ['5S']));
  assert.ok(b(['7D', '7S'], ['7C', '7H']), 'pairs: the higher top card');
  assert.ok(!b(['7D', '7S'], ['8D', '8C']));
  assert.ok(b(['3D', '7D', '9D', 'JD', 'KD'], ['4C', '5H', '6S', '7D', '8C']), 'flush beats straight');
  assert.ok(b(['3D', '3C', '3H', '4S', '4D'], ['2D', '7D', '9D', 'JD', 'KD']), 'full house beats flush');
  assert.ok(b(['4C', '5C', '6C', '7C', '8C'], ['AD', 'AC', 'AH', 'AS', '3D']), 'straight flush beats four');
  assert.ok(!b(['5D', '5S'], ['4D']), 'different number of cards');
});

test('points for cards left: x2 from 10 cards, x3 with all 13', () => {
  assert.strictEqual(T.penalty(0), 0);
  assert.strictEqual(T.penalty(9), 9);
  assert.strictEqual(T.penalty(10), 20);
  assert.strictEqual(T.penalty(12), 24);
  assert.strictEqual(T.penalty(13), 39);
});

test('money: everyone pays everyone below them', () => {
  const { pays, net } = T.settle({ a: 10, b: 100, c: 40 }, 100);
  assert.deepStrictEqual(net, { a: 3000 + 9000, b: -9000 - 6000, c: 6000 - 3000 });
  assert.strictEqual(pays.length, 3);
  assert.deepStrictEqual(T.settle({ a: 10, b: 30 }, 0).pays, []);
});

const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }];

test('the holder of 3♦ starts and must play it; passing round gives the lead back', () => {
  const m = new T.Match(players, { seed: 5 });
  m.deal(0);
  const g = m.game;
  if (g.winner) return; // a dealt dragon (very unlikely with this seed)
  const first = g.turn;
  assert.ok(g.hands[first].includes(c('3D')));
  const other = g.hands[first].find((x) => x !== c('3D'));
  assert.ok(m.play(first, [other]).error, 'must include 3♦');
  assert.ok(m.play(first, [c('3D')]).ok);
  for (let i = 0; i < 3; i++) m.play(m.game.turn, []);
  assert.strictEqual(m.game.turn, first, 'all passed: back to the player who played');
  assert.strictEqual(m.game.table, null);
  assert.ok(m.play(first, []).error, 'cannot pass when starting a trick');
});

test('a game ends when someone empties their hand; losers score their cards', () => {
  const m = new T.Match(players.slice(0, 2), { seed: 2, end: 'limit', limit: 30 });
  m.deal(0);
  const g = m.game;
  g.hands.a = cs('5D');
  g.hands.b = [...Array(11).keys()].map((i) => i * 4 + 1);
  g.turn = 'a'; g.mustPlay = null; g.table = null;
  m.play('a', cs('5D'));
  assert.strictEqual(g.winner, 'a');
  assert.strictEqual(m.totals.b, 22, '11 cards left: doubled');
  assert.strictEqual(m.wins.a, 1);
  assert.strictEqual(m.over, null);
  // Next game: the winner starts with anything.
  m.deal(1000);
  assert.strictEqual(m.game.turn, 'a');
  assert.strictEqual(m.game.mustPlay, null);
});

test('point limit: a player who reaches it is out; the last one in wins', () => {
  const m = new T.Match(players.slice(0, 2), { seed: 3, end: 'limit', limit: 20, rate: 100 });
  m.deal(0);
  m.game.hands.a = cs('9S');
  m.game.hands.b = cs('3D', '3C', '3H', '3S', '4D', '4C', '4H', '4S', '5D', '5C');
  m.game.turn = 'a'; m.game.mustPlay = null; m.game.table = null;
  m.play('a', cs('9S'));
  assert.ok(m.out.has('b'));
  assert.strictEqual(m.over.winner, 'a');
  assert.deepStrictEqual(m.over.settle.net, { a: 2000, b: -2000 });
});

test('a dealt hand of 13 different ranks wins at once', () => {
  assert.ok(T.isDragon(cs('3D', '4C', '5H', '6S', '7D', '8C', '9H', '10S', 'JD', 'QC', 'KH', 'AS', '2D')));
  assert.ok(!T.isDragon(cs('3D', '3C', '5H', '6S', '7D', '8C', '9H', '10S', 'JD', 'QC', 'KH', 'AS', '2D')));
});

test('time limit: lowest points wins; a tie on points and wins goes to a deciding game', () => {
  const m = new T.Match(players.slice(0, 3), { seed: 4, end: 'time', minutes: 1, now: 0 });
  m.totals = { a: 5, b: 5, c: 30 };
  m.wins = { a: 1, b: 1, c: 0 };
  m.timeUp();
  assert.deepStrictEqual(m.tiebreak, ['a', 'b']);
  m.deal(70000);
  assert.deepStrictEqual(m.game.seats, ['a', 'b']);
  const w = m.game.turn;
  m.game.hands[w] = [m.game.hands[w][0]];
  m.game.mustPlay = null;
  m.play(w, m.game.hands[w]);
  assert.strictEqual(m.over.winner, w);
  assert.deepStrictEqual(m.totals, { a: 5, b: 5, c: 30 }, 'the deciding game adds no points');
});

test('the turn timer passes for a slow player, or plays their lowest card when they start', () => {
  const m = new T.Match(players.slice(0, 2), { seed: 9, turnTime: 20 });
  m.deal(0);
  const first = m.game.turn;
  const low = m.game.hands[first][0];
  m.tick(21000);
  assert.ok(!m.game.hands[first].includes(low));
  const second = m.game.turn;
  assert.notStrictEqual(second, first);
  m.tick(21000 + 21000);
  assert.ok(m.game.passed.includes(second) || m.game.table === null);
});

test('each player only sees their own cards', () => {
  const m = new T.Match(players, { seed: 7 });
  m.deal(0);
  const v = m.view('b');
  assert.deepStrictEqual(v.game.hand, m.game.hands.b);
  assert.ok(!JSON.stringify(v).includes(JSON.stringify(m.game.hands.a)) || m.game.winner);
  assert.strictEqual(v.game.counts.a, 13);
});
