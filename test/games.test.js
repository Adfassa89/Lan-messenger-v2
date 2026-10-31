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

const ck = Games.RULES.checkers;
const num = (n) => {
  // square number (1-32) -> board index
  for (let s = 0; s < 64; s++) if (((s >> 3) + (s & 7)) % 2 === 0 && ck.number(s) === n) return s;
  throw new Error(`no square ${n}`);
};

test('checkers: opening moves, forced captures and multi-jumps', () => {
  assert.strictEqual(ck.legalMoves(ck.init()).length, 7);
  const st = { board: new Array(64).fill(null), turn: 0, quiet: 0, log: [] };
  st.board[num(10)] = 'b';
  st.board[num(1)] = 'b';
  st.board[num(14)] = 'r';
  st.board[num(23)] = 'r';
  // The capture is compulsory, and the man must keep jumping: 10x19x28.
  const moves = ck.legalMoves(st);
  assert.deepStrictEqual(moves.map((m) => m.map(ck.number)), [[10, 19, 28]]);
  assert.throws(() => ck.apply(st, { path: [num(1), num(5)] }, 0), /Illegal/);
  const next = ck.apply(st, { path: moves[0] }, 0);
  assert.deepStrictEqual(next.log, ['10x19x28']);
  assert.strictEqual(next.board.filter((p) => p && p.toLowerCase() === 'r').length, 0);
  assert.deepStrictEqual(ck.status(next), { over: true, winner: 0, reason: 'blocked' });
});

test('checkers: men are crowned on the far row and kings move backwards', () => {
  const st = { board: new Array(64).fill(null), turn: 0, quiet: 0, log: [] };
  st.board[num(25)] = 'b';
  st.board[num(8)] = 'r';
  const next = ck.apply(st, { path: [num(25), num(29)] }, 0);
  assert.strictEqual(next.board[num(29)], 'B');
  assert.throws(() => ck.apply(next, { path: [num(29), num(25)] }, 0), /turn/);
  const after = ck.apply(next, { path: [num(8), num(4)] }, 1);
  assert.ok(ck.legalMoves(after).some((m) => m[0] === num(29) && m[1] === num(25)), 'king can move back');
});

test('tetris battle stores who was knocked out', () => {
  const r = Games.replay('tetris', [{ p: 1, m: { ko: true } }]);
  assert.deepStrictEqual(r.status, { over: true, winner: 0, reason: 'ko' });
  assert.throws(() => Games.replay('tetris', [{ p: 1, m: { ko: true } }, { p: 0, m: { ko: true } }]));
});

test('chess clocks: first moves are free, increments are added, time-outs end the game', () => {
  const opts = { clock: { base: 60000, inc: 2000 } };
  const mv = (p, from, to, t) => ({ p, m: { from, to }, t });
  const moves = [mv(0, 'e2', 'e4', 9999), mv(1, 'e7', 'e5', 9999), mv(0, 'g1', 'f3', 5000), mv(1, 'b8', 'c6', 61000)];
  const r = Games.replay('chess', moves, opts);
  // White: 60 + 2 (free first move) - 5 + 2. Black: 60 + 2 - 61 + 2.
  assert.deepStrictEqual(r.clock.left, [59000, 3000]);
  assert.strictEqual(r.clock.running, 0);
  const out = Games.replay('chess', moves.concat({ p: 1, m: { timeout: true } }), opts);
  assert.deepStrictEqual([out.status.over, out.status.winner, out.status.reason], [true, 1, 'timeout']);
  assert.throws(() => Games.replay('chess', [{ p: 0, m: { timeout: true } }]), /no clock/);
  assert.strictEqual(Games.cleanClock({ base: 5, inc: 0 }), null);
  assert.strictEqual(Games.replay('chess', moves).clock, null);
});

test('checkers can be played with a clock too', () => {
  const opts = { clock: { base: 180000, inc: 2000 } };
  const C = Games.RULES.checkers;
  const first = C.legalMoves(C.init())[0];
  const r = Games.replay('checkers', [{ p: 0, m: { path: first }, t: 5000 }], opts);
  assert.deepStrictEqual(r.clock.left, [182000, 180000]); // first move free, +2 s
  assert.strictEqual(r.clock.running, null); // black has not moved yet
  const out = Games.replay('checkers', [{ p: 0, m: { path: first } }, { p: 0, m: { timeout: true } }], opts);
  assert.deepStrictEqual([out.status.winner, out.status.reason], [0, 'timeout']);
  assert.strictEqual(Games.replay('ttt', [], opts).clock, null); // only chess and checkers have clocks
});

test('tetris matches are best of 1, 3, 5, 7 or 9', () => {
  const ko = (p) => ({ p, m: { ko: true } });
  // Best of 5: first to three knockouts.
  const opts = { bestOf: 5 };
  let r = Games.replay('tetris', [ko(1), ko(0), ko(1)], opts);
  assert.deepStrictEqual([r.state.wins, r.status.over], [[2, 1], false]);
  r = Games.replay('tetris', [ko(1), ko(0), ko(1), ko(0), ko(1)], opts);
  assert.deepStrictEqual([r.status.over, r.status.winner], [true, 0]);
  assert.throws(() => Games.replay('tetris', [ko(1), ko(1), ko(1), ko(0)], opts), /over/);
  // Leaving gives up the whole match.
  r = Games.replay('tetris', [ko(0), { p: 1, m: { forfeit: true } }], { bestOf: 9 });
  assert.deepStrictEqual([r.status.over, r.status.winner, r.state.wins], [true, 0, [5, 1]]);
  // Anything else counts as best of 1.
  assert.strictEqual(Games.replay('tetris', [ko(0)], { bestOf: 4 }).status.over, true);
});
