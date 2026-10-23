'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Tetris, W, H } = require('../src/shared/tetris');

// Fills a row except for the given holes.
function row(g, y, holes = []) {
  for (let x = 0; x < W; x++) g.board[y * W + x] = holes.includes(x) ? null : 'G';
}

test('7-bag: every bag has each piece once, and equal seeds give equal pieces', () => {
  const a = new Tetris(42);
  const b = new Tetris(42);
  assert.deepStrictEqual(a.queue.slice(0, 14), b.queue.slice(0, 14));
  assert.deepStrictEqual(a.queue.slice(0, 7).sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
  assert.deepStrictEqual(a.queue.slice(7, 14).sort(), ['I', 'J', 'L', 'O', 'S', 'T', 'Z']);
});

test('pieces spawn, move, fall and lock; a full line clears', () => {
  const g = new Tetris(1);
  row(g, H - 1, [0, 1, 2, 3]);
  g.spawn('I');
  assert.ok(g.move(-3) && !g.move(-1), 'stops at the wall');
  const r = g.hardDrop();
  assert.strictEqual(r.lines, 1);
  assert.ok(g.board.every((c) => !c), 'board empty again');
  assert.ok(r.perfect, 'perfect clear');
  assert.strictEqual(r.attack, 10, 'a single is worth 0, the perfect clear 10');
});

test('SRS wall kick lets a T rotate against the wall', () => {
  const g = new Tetris(1);
  g.spawn('T');
  g.rotate(1); // point right
  while (g.move(-1)) { /* to the left wall */ }
  assert.ok(g.rotate(-1), 'kicks off the wall');
  assert.ok(g.cells().every(([x]) => x >= 0));
});

test('T-spin double sends 4 lines, and back-to-back adds one', () => {
  const g = new Tetris(1);
  // Classic T-spin double slot at the bottom left.
  row(g, H - 1, [1]);
  row(g, H - 2, [0, 1, 2]);
  g.board[(H - 3) * W + 0] = 'G';
  g.active = { type: 'T', rot: 2, x: 0, y: H - 3 };
  // Pretend the T just rotated into the slot.
  g.lastAction = 'rotate';
  g.lastKick = 0;
  assert.strictEqual(g.tspin(), 'full');
  const r = g.lock();
  assert.strictEqual(r.lines, 2);
  assert.strictEqual(r.spin, 'full');
  assert.strictEqual(r.attack, 4);
  // A quad straight after gets the back-to-back bonus (4 + 1, +1 combo).
  for (let y = H - 4; y < H; y++) row(g, y, [9]);
  g.board[(H - 6) * W + 4] = 'G'; // stays behind, so this is not a perfect clear
  g.spawn('I');
  g.rotate(1);
  while (g.move(1)) { /* to the right wall */ }
  const q = g.hardDrop();
  assert.strictEqual(q.lines, 4);
  assert.strictEqual(q.attack, 4 + 1 + 0);
});

test('incoming garbage is cancelled by attacks, otherwise it rises with one hole', () => {
  const g = new Tetris(7);
  g.receive(3);
  assert.strictEqual(g.pendingGarbage(), 3);
  g.spawn('O');
  const r = g.hardDrop();
  assert.strictEqual(r.risen, 3);
  const bottom = g.board.slice((H - 1) * W);
  assert.strictEqual(bottom.filter((c) => c === 'G').length, W - 1);
  // A double (1 line attack) cancels one of two incoming lines.
  const h = new Tetris(7);
  h.receive(2);
  row(h, H - 1, [0, 1]);
  row(h, H - 2, [0, 1]);
  h.board[(H - 4) * W + 5] = 'G'; // stays behind, so this is not a perfect clear
  h.spawn('O');
  while (h.move(-1)) { /* left */ }
  const d = h.hardDrop();
  assert.strictEqual(d.lines, 2);
  assert.strictEqual(d.attack, 1);
  assert.strictEqual(d.sent, 0);
  assert.strictEqual(h.pendingGarbage(), 1);
});

test('topping out ends the game', () => {
  const g = new Tetris(3);
  for (let y = 0; y < H; y++) row(g, y, [y % W]);
  assert.strictEqual(g.spawn('O'), false);
  assert.ok(g.dead);
});
