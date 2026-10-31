'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../src/shared/warlock');

// Two warlocks, straight into the fight.
function arena(n = 2) {
  const sim = new W.Sim(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), { rounds: 3 });
  sim.start();
  sim.toFight();
  for (const p of sim.pawns) p.mods = {}; // skip the 2 s spawn protection
  return sim;
}
const run = (sim, seconds) => { for (let i = 0; i < seconds / W.TICK; i++) sim.step(); };

test('knockback follows Warlock Brawl: damage x 10, growing with damage taken', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  sim.damage(b, a, 70, 1, 0, 1);
  assert.strictEqual(Math.round(b.vx), 700); // 70 damage, no damage points yet
  b.vx = 0;
  sim.damage(b, a, 70, 1, 0, 1); // now 70 damage points: x1.07
  assert.strictEqual(Math.round(b.vx), Math.round(70 * 10 * 1.07));
  b.vx = 0;
  b.dp = 0;
  sim.damage(b, a, 150, 1, 0, 1); // above 100: sqrt(100 x 150)
  assert.strictEqual(Math.round(b.vx), Math.round(Math.sqrt(15000) * 10));
  // Friction: 0.96 per 0.035 s tick, about 69 % lost per second.
  b.vx = 1000;
  b.move = null;
  sim.stepPawns(W.TICK);
  assert.strictEqual(Math.round(b.vx), 960);
});

test('lava burns 100 per second, the platform shrinks every 10 s, last one standing scores', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  assert.strictEqual(sim.layer, 15); // 13 + 2 players
  b.x = 2500; // in the lava
  b.y = 0;
  const hp = b.hp;
  run(sim, 1);
  assert.ok(Math.abs(hp + 5 - b.hp - 100) < 6, `lava damage ${hp - b.hp}`); // regen 5/s
  assert.ok(b.dp >= 45 && b.dp <= 55, 'lava adds half its damage as damage points');
  run(sim, 9.2);
  assert.strictEqual(sim.layer, 14);
  for (let i = 0; i < 400 && !b.dead; i++) sim.step();
  assert.ok(b.dead, 'burned to death');
  assert.strictEqual(sim.phase, 'roundEnd');
  assert.strictEqual(a.score, 1);
});

test('fireball flies 1000 range, hits and knocks back; scourge hurts the caster too', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 500; b.y = 0;
  sim.input('p0', { cast: 0, x: 500, y: 0 });
  run(sim, 0.8);
  assert.ok(b.hp < 1000 - 60 && b.vx > 0, 'fireball hit');
  a.x = 0; b.x = 200; b.vx = 0;
  const hpA = a.hp;
  sim.input('p0', { cast: 7, x: 0, y: 0 });
  run(sim, 1);
  assert.ok(a.hp <= hpA - 90, 'scourge costs the caster 100');
  assert.ok(b.vx > 0, 'scourge pushes');
});

test('shop: one spell per column, upgrades cost more, items add health', () => {
  const sim = new W.Sim([{ id: 'p0', name: 'A' }, { id: 'p1', name: 'B' }]);
  sim.start();
  const a = sim.pawn('p0');
  assert.strictEqual(a.cash, 30);
  assert.ok(sim.buy('p0', 'lightning')); // 11
  assert.ok(!sim.buy('p0', 'homing')); // same column
  assert.ok(sim.buy('p0', 'lightning')); // upgrade 8
  assert.strictEqual(a.spells[1].level, 2);
  assert.ok(sim.buy('p0', 'ring')); // 4
  assert.strictEqual(a.cash, 30 - 11 - 8 - 4);
  assert.strictEqual(sim.maxHp(a), 1100);
  assert.ok(!sim.buy('p0', 'teleport')); // 12 > 7 left
});

test('teleport, swap and shield work like the original', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 400; b.y = 0;
  a.spells[2] = { key: 'teleport', level: 1 };
  sim.input('p0', { cast: 2, x: -2000, y: 0 });
  run(sim, 0.3); // turns round first (Dota turn rate), then blinks
  assert.strictEqual(Math.round(a.x), -770); // level 1 range
  a.x = 0;
  a.cd = {};
  a.spells[2] = { key: 'swap', level: 1 };
  sim.input('p0', { cast: 2, x: 400, y: 0 });
  run(sim, 0.4);
  assert.ok(a.x > 300 && b.x < 100, 'positions swapped');
  // A shield turns a fireball back to its caster.
  a.x = 0; b.x = 500; a.cd = {}; b.cd = {};
  b.spells[5] = { key: 'shield', level: 1 };
  sim.input('p1', { cast: 5, x: 0, y: 0 });
  sim.input('p0', { cast: 0, x: 500, y: 0 });
  const hpB = b.hp;
  run(sim, 1.2);
  assert.ok(b.hp >= hpB - 1, 'shielded warlock unhurt');
  assert.ok(a.hp < 1000 - 40, 'the fireball came back');
});

test('Dota turning: walk and cast only once facing the target', () => {
  const sim = arena();
  const [a] = sim.pawns;
  a.x = 0; a.y = 0; a.face = 0; a.mods = {};
  sim.input('p0', { move: [-1000, 0] }); // straight behind
  sim.step();
  assert.strictEqual(Math.round(a.x), 0, 'turns on the spot first');
  run(sim, 0.2); // 180 degrees take about 0.175 s
  assert.ok(Math.abs(Math.abs(a.face) - Math.PI) < 0.01, 'faces the target');
  assert.ok(a.x < -1, 'then walks');
  // A fireball behind: turn, 0.2 s cast point, then the fireball.
  a.face = 0; a.cd = {};
  sim.input('p0', { cast: 0, x: -1000, y: 0 });
  run(sim, 0.12);
  assert.ok(!sim.projectiles.some((b) => b.k === 'fireball'), 'still turning');
  run(sim, 0.4);
  assert.ok(sim.projectiles.some((b) => b.k === 'fireball' && b.vx < 0), 'fireball flies backwards');
});

test('a whole match: shop, rounds, scores and the final winner', () => {
  const sim = new W.Sim([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rounds: 2 });
  sim.start();
  sim.setReady('a');
  sim.setReady('b'); // everyone ready: the shop closes after 3 s
  const events = [];
  for (let i = 0; i < 4000 && sim.phase !== 'over'; i++) {
    if (sim.phase === 'fight' && !sim.pawn('b').mods.spawnShield) { sim.pawn('b').x = 4000; } // B keeps ending up in the lava
    sim.step();
    events.push(...sim.snapshot().fx.map((e) => e.e));
  }
  assert.strictEqual(sim.phase, 'over');
  assert.strictEqual(sim.pawn('a').score, 2);
  assert.strictEqual(sim.pawn('a').cash, 30 + 10 * 2);
  assert.ok(events.includes('fight') && events.includes('death') && events.includes('roundEnd') && events.includes('over'));
});
