'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Games = require('../src/shared/games');

const { chess } = Games.RULES;

// "perft" counts every possible game up to a depth. The expected numbers are
// the well-known reference values; matching them proves the move rules
// (castling, en passant, promotion, pins, checks) are right.
function perft(st, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const mv of chess.legalMoves(st)) {
    const next = chess.apply(st, { from: mv.from, to: mv.to, promo: mv.promo }, st.turn === 'w' ? 0 : 1);
    n += perft(next, depth - 1);
  }
  return n;
}

test('chess move generation matches reference counts (start position)', () => {
  const st = chess.init();
  assert.strictEqual(perft(st, 1), 20);
  assert.strictEqual(perft(st, 2), 400);
  assert.strictEqual(perft(st, 3), 8902);
});

test('chess move generation matches reference counts (tricky positions)', () => {
  // "Kiwipete": castling, pins, en passant and promotions all at once.
  const kiwi = chess.fromFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.strictEqual(perft(kiwi, 1), 48);
  assert.strictEqual(perft(kiwi, 2), 2039);
  // Position 3: en passant discovered checks along the rank.
  const p3 = chess.fromFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.strictEqual(perft(p3, 1), 14);
  assert.strictEqual(perft(p3, 2), 191);
  assert.strictEqual(perft(p3, 3), 2812);
  // Position 4: promotions and castling under attack.
  const p4 = chess.fromFen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
  assert.strictEqual(perft(p4, 1), 6);
  assert.strictEqual(perft(p4, 2), 264);
  assert.strictEqual(perft(p4, 3), 9467);
});

test("chess detects checkmate (fool's mate)", () => {
  const moves = [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']].map(([from, to], i) => ({ p: i % 2, m: { from, to } }));
  const { status } = Games.replay('chess', moves);
  assert.deepStrictEqual(status, { over: true, winner: 1, reason: 'checkmate' });
});

test('illegal moves and moving out of turn are rejected', () => {
  assert.throws(() => Games.replay('chess', [{ p: 0, m: { from: 'e2', to: 'e5' } }]), /Illegal/);
  assert.throws(() => Games.replay('chess', [{ p: 1, m: { from: 'e7', to: 'e5' } }]), /turn/);
  assert.throws(() => Games.replay('ttt', [{ p: 0, m: { cell: 4 } }, { p: 1, m: { cell: 4 } }]), /Illegal/);
});

test('resign and draw offers', () => {
  const r = Games.replay('chess', [{ p: 0, m: { from: 'e2', to: 'e4' } }, { p: 1, m: { resign: true } }]);
  assert.deepStrictEqual(r.status, { over: true, winner: 0, reason: 'resign' });
  const d = Games.replay('chess', [{ p: 0, m: { draw: 'offer' } }, { p: 1, m: { draw: 'accept' } }]);
  assert.strictEqual(d.status.reason, 'agreed');
  assert.throws(() => Games.replay('chess', [{ p: 0, m: { draw: 'accept' } }]));
  const declined = Games.replay('chess', [{ p: 0, m: { draw: 'offer' } }, { p: 1, m: { draw: 'decline' } }]);
  assert.strictEqual(declined.drawOffer, null);
});

test('tic-tac-toe and connect four find the winner', () => {
  const ttt = Games.replay('ttt', [0, 3, 1, 4, 2].map((cell, i) => ({ p: i % 2, m: { cell } })));
  assert.strictEqual(ttt.status.winner, 0);
  assert.deepStrictEqual(ttt.status.line, [0, 1, 2]);
  const c4 = Games.replay('c4', [3, 3, 4, 4, 5, 5, 6].map((col, i) => ({ p: i % 2, m: { col } })));
  assert.strictEqual(c4.status.winner, 0);
  assert.throws(() => Games.replay('c4', [0, 0, 0, 0, 0, 0, 0].map((col, i) => ({ p: i % 2, m: { col } }))), /full/);
});

test('moves are written in standard chess notation', () => {
  const play = (moves) => Games.replay('chess', moves.map(([from, to, promo], i) => ({ p: i % 2, m: { from, to, promo } }))).state.log;
  assert.deepStrictEqual(play([['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]), ['f3', 'e5', 'g4', 'Qh4#']);
  assert.deepStrictEqual(
    play([['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5'], ['g8', 'f6'], ['g1', 'f3'], ['f6', 'd5'], ['f1', 'c4'], ['b8', 'c6'], ['e1', 'g1']]),
    ['e4', 'd5', 'exd5', 'Nf6', 'Nf3', 'Nxd5', 'Bc4', 'Nc6', 'O-O'],
  );
  // Two knights can reach d2: the file is added to tell them apart.
  const st = chess.fromFen('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
  const next = chess.apply({ ...st, log: [] }, { from: 'b1', to: 'd2' }, 0);
  assert.deepStrictEqual(next.log, ['Nbd2']);
});
