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
  sim.obstacles = []; // tests place their own
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
  run(sim, 0.12); // 180 degrees take about 0.09 s (turn rate 1.2)
  assert.ok(Math.abs(Math.abs(a.face) - Math.PI) < 0.01, 'faces the target');
  assert.ok(a.x < -1, 'then walks');
  // A fireball behind: turn, 0.2 s cast point, then the fireball.
  a.face = 0; a.cd = {};
  sim.input('p0', { cast: 0, x: -1000, y: 0 });
  run(sim, 0.07);
  assert.ok(!sim.projectiles.some((b) => b.k === 'fireball'), 'still turning or winding up');
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

// ---------------------------------------------------------------- Warlock Brawl spells added later
const give = (p, slot, key, level = 1) => { p.spells[slot] = { key, level }; p.cd = {}; p.face = 0; };
const castAt = (sim, id, slot, x, y) => sim.input(id, { cast: slot, x, y });

test('Twin: two orbs on mirrored arcs meet at the target and hit there', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 600; b.y = 0;
  give(a, 1, 'twin');
  castAt(sim, 'p0', 1, 600, 0);
  run(sim, 0.25);
  const orbs = sim.projectiles.filter((q) => q.k === 'twin');
  assert.strictEqual(orbs.length, 2);
  assert.ok(orbs[0].y * orbs[1].y < 0, 'one above, one below the line');
  run(sim, 1.2);
  assert.ok(b.hp <= 1000 - 44 * 2 + 5, `both orbs hit (hp ${b.hp})`);
});

test('Drain: damages, slows, and its life flies back to heal the caster', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 400; b.y = 0;
  a.hp = 500;
  give(a, 3, 'drain');
  castAt(sim, 'p0', 3, 400, 0);
  run(sim, 0.9);
  assert.ok(b.hp < 1000 - 50, 'target took damage');
  assert.ok(b.mods.drained, 'target slowed');
  assert.ok(sim.speed(b) < 210, 'slower');
  run(sim, 1.5);
  assert.ok(a.hp > 560, `caster healed (${a.hp})`);
});

test('Recharge: a hit comes back to reset its cooldown and grows the next one', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 300; b.y = 0;
  give(a, 3, 'recharge');
  castAt(sim, 'p0', 3, 300, 0);
  run(sim, 0.6);
  assert.strictEqual(a.recharge, 1, 'one hit in a row');
  run(sim, 1.5);
  assert.strictEqual(a.cd[3] || 0, 0, 'cooldown reset by the returning spark');
});

test('Splitter: casts without turning and bursts into 8 bolts', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; a.face = Math.PI; b.x = 2000; b.y = 2000;
  give(a, 4, 'splitter');
  a.face = Math.PI;
  castAt(sim, 'p0', 4, 600, 0);
  sim.step();
  assert.ok(sim.projectiles.some((q) => q.k === 'splitter'), 'fired at once, facing away');
  run(sim, 1.6);
  const kids = sim.projectiles.filter((q) => q.k === 'splitChild').length;
  assert.ok(kids >= 6, `children spawned (${kids})`);
});

test('Snowball: carries warlocks along, chills them and bursts at the end', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 150; b.y = 0;
  give(a, 4, 'snowball');
  castAt(sim, 'p0', 4, 600, 0);
  run(sim, 1.0);
  assert.ok(b.x > 300, `pushed along (${Math.round(b.x)})`);
  run(sim, 1.5);
  assert.ok(b.hp < 1000 - 30, 'chill and burst damage');
});

test('Grip: the target cannot walk and takes a third of the knockback', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 400; b.y = 0;
  give(a, 6, 'grip');
  castAt(sim, 'p0', 6, 400, 0);
  run(sim, 0.7);
  assert.ok(b.mods.gripped, 'gripped');
  sim.input('p1', { move: [1000, 0] });
  const x0 = b.x;
  run(sim, 0.5);
  assert.ok(Math.abs(b.x - x0) < 2, 'cannot walk');
  b.vx = 0;
  sim.damage(b, a, 70, 1, 0, 1);
  assert.ok(Math.abs(b.vx - 700 * 0.33) < 1, 'knockback cut to a third');
});

test('Warpzone slows enemy spells inside it, not the caster\'s own', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = -800; a.y = 0; b.x = 800; b.y = 0;
  give(b, 6, 'warpzone');
  castAt(sim, 'p1', 6, 300, 0);
  run(sim, 0.3);
  assert.strictEqual(sim.zones.length, 1);
  sim.projectiles.push({ id: 999, k: 'fireball', owner: 'p0', x: 200, y: 0, vx: 1000, vy: 0, r: 25, life: 1, dmg: 70, kb: 1, hits: [], age: 0 });
  sim.step();
  const fb = sim.projectiles.find((q) => q.id === 999);
  assert.ok(fb.x < 200 + 1000 * W.TICK * 0.5, 'slowed to 40%');
});

test('Magnetize pulls other players\' spells towards the magnetized warlock', () => {
  const sim = arena(3);
  const [a, b] = sim.pawns;
  b.x = 0; b.y = 0; a.x = -2000; a.y = -2000;
  b.mods.magnet = { t: 3, sign: 1 };
  sim.projectiles.push({ id: 998, k: 'fireball', owner: 'p2', x: -200, y: 150, vx: 1000, vy: 0, r: 25, life: 1, dmg: 70, kb: 1, hits: [], age: 0 });
  run(sim, 0.12);
  const fb = sim.projectiles.find((q) => q.id === 998);
  assert.ok(!fb || fb.vy < -50, 'bent towards the magnetized warlock');
});

test('Rockpillar and obstacles: block spells, bounce warlocks, explode at 0 HP', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 900; b.y = 0;
  give(a, 6, 'rockpillar');
  castAt(sim, 'p0', 6, 450, 0);
  run(sim, 0.3);
  assert.strictEqual(sim.obstacles.length, 1, 'pillar raised');
  give(a, 0, 'fireball');
  castAt(sim, 'p0', 0, 900, 0);
  run(sim, 1.2);
  assert.strictEqual(b.hp, 1000, 'fireball stopped by the pillar');
  assert.ok(sim.obstacles[0].hp < 400, 'pillar damaged');
  run(sim, 4);
  assert.strictEqual(sim.obstacles.length, 0, 'pillar gone after 4 s');
  // A warlock flying into an obstacle bounces off at half speed.
  const o = sim.addObstacle(300, 0, 60, 0);
  a.x = 0; a.y = 0; a.vx = 1000; a.vy = 0;
  run(sim, 0.3);
  assert.ok(a.vx < 0, 'bounced back');
  // Breaking it explodes.
  b.x = 400; b.y = 0; b.vx = 0;
  sim.damageObstacle(o, 400, a);
  assert.strictEqual(sim.obstacles.length, 0);
  assert.ok(b.hp < 1000 && b.vx > 0, 'explosion pushes nearby warlocks');
});

test('Alteration swaps the warlock with an incoming enemy spell', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 600; b.y = 0;
  give(a, 5, 'alteration');
  castAt(sim, 'p0', 5, 0, 0);
  assert.ok(a.mods.alteration, 'active at once');
  sim.projectiles.push({ id: 997, k: 'fireball', owner: 'p1', x: 250, y: 0, vx: -1000, vy: 0, r: 25, life: 1, dmg: 70, kb: 1, hits: [], age: 0 });
  run(sim, 0.2);
  assert.ok(a.x > 100, `warlock moved to the spell (${Math.round(a.x)})`);
  assert.strictEqual(a.hp, 1000, 'not hit');
});

test('Every round places 2 – 8 obstacles within ±1000 in one style', () => {
  const sim = new W.Sim([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { rounds: 3, seed: 7 });
  sim.start();
  assert.ok(sim.obstacles.length >= 2 && sim.obstacles.length <= 8);
  assert.ok(sim.obstacles.every((o) => Math.abs(o.x) <= 1000 && Math.abs(o.y) <= 1000 && o.hp === 400));
  const snap = sim.snapshot();
  assert.strictEqual(snap.o.length, sim.obstacles.length);
});

// ---------------------------------------------------------------- modes and teams
const four = (opts) => {
  const sim = new W.Sim(['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })), { seed: 3, ...opts });
  sim.start();
  sim.toFight();
  for (const p of sim.pawns) p.mods = {};
  sim.obstacles = [];
  return sim;
};

test('Shuffle teams: 4 players become 2 teams of 2; team mates spawn side by side', () => {
  const sim = four({ teams: 'shuffle' });
  const counts = {};
  for (const p of sim.pawns) counts[p.team] = (counts[p.team] || 0) + 1;
  assert.deepStrictEqual(Object.values(counts).sort(), [2, 2]);
  const [p, q] = sim.pawns.filter((x) => x.team === sim.pawns[0].team);
  assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 500, 'mates close together');
});

test('Team mates: spells pass through, Drain heals, the round ends when one team is left', () => {
  const sim = four({ teams: 'lobby', lobbyTeams: { a: 0, b: 0, c: 1, d: 1 } });
  const [a, b, c, d] = sim.pawns;
  a.x = 0; a.y = 0; b.x = 300; b.y = 0; c.x = 2000; c.y = 2000; d.x = -2000; d.y = 2000;
  sim.projectiles.push({ id: 900, k: 'fireball', owner: 'a', x: 100, y: 0, vx: 1000, vy: 0, r: 25, life: 1, dmg: 70, kb: 1, hits: [], age: 0 });
  run(sim, 0.4);
  assert.strictEqual(b.hp, 1000, 'no friendly fire');
  b.hp = 600;
  sim.projectiles.push({ id: 901, k: 'drain', owner: 'a', x: 100, y: 0, vx: 700, vy: 0, r: 24.5, life: 1, turnAt: 0, turned: true, dmg: 60, dur: 4, hits: [], age: 0 });
  run(sim, 0.4);
  assert.ok(b.hp >= 660, `ally healed (${Math.round(b.hp)})`);
  sim.kill(c);
  sim.kill(d);
  sim.step();
  assert.strictEqual(sim.phase, 'roundEnd');
  assert.strictEqual(a.score, 1);
  assert.strictEqual(b.score, 1, 'every winning team member scores');
  assert.strictEqual(c.score, 0);
});

test('Deathmatch: kills score for the team, respawn after 10 s, shop open, 60 s rounds', () => {
  const sim = four({ mode: 'dm', teams: 'ffa', win: 'score', target: 3 });
  const [a, b] = sim.pawns;
  assert.ok(Math.abs(sim.phaseLeft - 60) < 0.1, '60 s round');
  b.lastHit = { id: 'a', t: sim.time };
  sim.kill(b);
  assert.strictEqual(a.score, 1);
  assert.strictEqual(a.kills, 1);
  run(sim, 5);
  assert.ok(b.dead, 'still waiting');
  run(sim, 5.2);
  assert.ok(!b.dead && b.mods.spawnShield, 'respawned with protection');
  assert.ok(sim.buy('a', 'lightning'), 'shop works during the fight');
  const round = sim.round;
  run(sim, 50);
  assert.strictEqual(sim.round, round + 1, 'next round without a shop break');
  assert.strictEqual(sim.phase, 'fight');
  a.score = 3;
  run(sim, 61);
  assert.strictEqual(sim.phase, 'over', 'first to 3 wins at the end of a round');
});
