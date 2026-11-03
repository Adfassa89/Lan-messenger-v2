'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/shared/tanks');
const L = require('../src/shared/tank-levels');
const { TILE } = L;

const two = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const run = (g, seconds) => { for (let i = 0; i < Math.round(seconds / T.TICK); i++) g.step(); };
// An empty field (only the base), so tests control everything.
function blank(g) {
  for (let y = 0; y < 26; y++) for (let x = 0; x < 26; x++) if (g.grid[y][x] !== TILE.BASE) g.grid[y][x] = TILE.EMPTY;
  g.queue = [];
  g.tanks = g.tanks.filter((t) => t.owner);
  for (const t of g.tanks) t.spawning = 0;
}

test('there are 50 co-op levels and 3 versus arenas, all playable', () => {
  assert.strictEqual(L.COOP.length, 50);
  assert.strictEqual(L.VERSUS.length, 3);
  for (let i = 0; i < 50; i++) {
    const b = L.build(L.COOP[i], 'coop');
    for (const g of L.GATES.concat(L.PLAYER_START)) assert.ok(L.reachable(b.grid, g, [12, 21]), `level ${i + 1} gate ${g}`);
  }
});

test('levels get harder: more enemies and tougher tanks', () => {
  const a = L.waveFor(1);
  const b = L.waveFor(50);
  assert.ok(b.count > a.count && b.atOnce >= a.atOnce);
  assert.ok(b.mix.heavy > a.mix.heavy && b.mix.rocket > a.mix.rocket);
});

test('a tank drives, stops at walls and snaps to the grid when turning', () => {
  const g = new T.Game(two, { level: 1 });
  blank(g);
  const t = g.players[0].tank;
  t.x = 8; t.y = 10.4; t.dir = 0;
  g.grid[7][8] = TILE.STEEL;
  g.input('a', { dir: 0 });
  run(g, 2);
  assert.strictEqual(Math.round(t.y * 10) / 10, 8); // stopped under the steel block
  g.input('a', { dir: 1 });
  g.step();
  assert.strictEqual(t.y, 8);
  assert.ok(t.x > 8);
});

test('shells break bricks but not steel, unless fully powered', () => {
  const g = new T.Game(two, { level: 1 });
  blank(g);
  const t = g.players[0].tank;
  t.x = 4; t.y = 12; t.dir = 0;
  g.grid[8][4] = TILE.BRICK; g.grid[8][5] = TILE.BRICK;
  g.grid[4][4] = TILE.STEEL; g.grid[4][5] = TILE.STEEL;
  g.input('a', { fire: true });
  run(g, 1.5);
  g.input('a', { fire: false });
  assert.strictEqual(g.grid[8][4], TILE.EMPTY);
  assert.strictEqual(g.grid[4][4], TILE.STEEL);
  g.players[0].power = 3;
  g.input('a', { fire: true });
  run(g, 1);
  assert.strictEqual(g.grid[4][4], TILE.EMPTY);
});

test('killing every enemy clears the level and the next one starts', () => {
  const g = new T.Game(two, { level: 3 });
  blank(g);
  const e = g.addTank('scout', 8, 4, 9, { spawning: 0 });
  g.enemiesLeft = 1;
  const t = g.players[0].tank;
  t.x = 8; t.y = 12; t.dir = 0;
  g.input('a', { fire: true });
  run(g, 1);
  assert.ok(!e.alive);
  assert.strictEqual(g.players[0].kills.scout, 1);
  assert.strictEqual(g.phase, 'clear');
  run(g, 6);
  assert.strictEqual(g.level, 4);
  assert.strictEqual(g.phase, 'play');
});

test('the base takes several hits and your own shells cannot hurt it', () => {
  const g = new T.Game(two, { level: 1 });
  blank(g);
  const t = g.players[0].tank;
  t.x = 12; t.y = 18; t.dir = 2;
  g.input('a', { fire: true });
  run(g, 3);
  assert.ok(g.bases[0].alive);
  g.input('a', { fire: false });
  const e = g.addTank('trooper', 12, 18, 9, { spawning: 0, dir: 2 });
  g.tanks = g.tanks.filter((x) => x !== t);
  g.players[0].tank = null;
  g.players[0].respawnAt = 0;
  g.freeze = 99; // it stays put and only the test fires
  for (let i = 0; i < 4; i++) { e.fireCd = 0; g.fire(e); run(g, 0.6); }
  assert.ok(!g.bases[0].alive);
  assert.strictEqual(g.over.reason, 'base');
});

test('lives run out, then the game is over', () => {
  const g = new T.Game(two, { level: 1 });
  blank(g);
  for (const p of g.players) p.lives = 1;
  for (const p of g.players) g.killTank(p.tank, null);
  run(g, 0.2);
  assert.strictEqual(g.over.reason, 'lives');
});

test('power-ups: shield blocks a hit, freeze stops enemies, airstrike destroys them', () => {
  const g = new T.Game(two, { level: 1 });
  blank(g);
  const p = g.players[0];
  g.applyPower(p, 'shield');
  g.hitTank(p.tank, { owner: null });
  assert.ok(p.tank.alive);
  const e = g.addTank('trooper', 2, 2, 9, { spawning: 0 });
  g.applyPower(p, 'freeze');
  const x0 = e.x; const y0 = e.y;
  run(g, 2);
  assert.strictEqual(e.x, x0); assert.strictEqual(e.y, y0);
  g.applyPower(p, 'airstrike');
  assert.ok(!e.alive);
  g.applyPower(p, 'fortify');
  assert.strictEqual(g.grid[23][11], TILE.STEEL);
  run(g, 16);
  assert.strictEqual(g.grid[23][11], TILE.BRICK);
});

test('ricochet shells bounce off steel once', () => {
  const g = new T.Game(two, { level: 1 });
  blank(g);
  const t = g.players[0].tank;
  t.x = 4; t.y = 12; t.dir = 0;
  t.ricochet = 10;
  t.fireCd = 0;
  g.grid[6][4] = TILE.STEEL; g.grid[6][5] = TILE.STEEL;
  g.fire(t);
  run(g, 0.4);
  const b = g.bullets[0];
  assert.ok(b && b.dir === 2, 'came back');
});

test('versus: bases on both sides, walls can be built, destroying a base wins', () => {
  const g = new T.Game(two, { mode: 'versus', arena: 0 });
  assert.strictEqual(g.bases.length, 2);
  blank(g);
  const p = g.players[0];
  p.tank.x = 6; p.tank.y = 6; p.tank.dir = 1;
  const before = p.walls;
  g.input('a', { build: true });
  g.step();
  assert.strictEqual(g.grid[6][8], TILE.BRICK);
  assert.strictEqual(p.walls, before - 1);
  // A kill scores a point and the other player comes back after a while.
  const q = g.players[1];
  g.killTank(q.tank, 'a');
  assert.strictEqual(p.score, 1);
  run(g, 3.5);
  assert.ok(q.tank);
  // Player A hits B's base six times.
  for (let i = 0; i < 6; i++) { g.destroyBase(24, 12, { team: 0 }); g.time += 0.5; }
  assert.strictEqual(g.over.winner, 'a');
});

test('versus: when time runs out the most kills win', () => {
  const g = new T.Game(two, { mode: 'versus', arena: 1, minutes: 1 });
  blank(g);
  g.players[1].score = 2;
  run(g, 61);
  assert.strictEqual(g.over.reason, 'time');
  assert.strictEqual(g.over.winner, 'b');
});

test('a full game runs without errors and snapshots stay small', () => {
  for (const mode of ['coop', 'versus']) {
    const g = new T.Game(two, { mode, level: 20, seed: 7 });
    for (let i = 0; i < 30 * 90 && !g.over; i++) {
      if (i % 15 === 0) for (const p of g.players) g.input(p.id, { dir: (i / 15 + p.slot) % 4, fire: true });
      g.step();
      if (i % 30 === 0) assert.ok(JSON.stringify(g.snapshot(false)).length < 6000);
    }
    assert.ok(JSON.stringify(g.snapshot(true)).length < 8000);
  }
});
