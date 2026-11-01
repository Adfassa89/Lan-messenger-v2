'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PW = require('../src/shared/pudgewars');

// Two Pudges facing each other across the river, straight into the fight.
function arena(n = 2, opts = {}) {
  const sim = new PW.Sim(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, team: i % 2 })), opts);
  sim.phase = 'fight';
  sim.runeAcc = -1000; // tests spawn their own runes
  return sim;
}
const run = (sim, seconds) => { for (let i = 0; i < Math.round(seconds / PW.TICK); i++) sim.step(); };
const place = (p, x, y, face = 0) => { p.x = x; p.y = y; p.face = face; };

test('Pudges start on their own side and cannot walk across the river', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  assert.ok(a.x < 0 && b.x > 0);
  assert.strictEqual(a.hp, 930 + 30 * 20);
  sim.input(a.id, { move: [1000, 0] });
  run(sim, 8);
  assert.ok(a.x <= -(PW.RIVER + PW.RADIUS) + 0.01, `stopped at the river bank, x=${a.x}`);
});

test('a hook deals 250 pure damage and drags the enemy back across the river', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  place(a, -300, 600, 0);
  place(b, 700, 600, Math.PI);
  sim.input(a.id, { cast: 'hook', x: 700, y: 600 });
  run(sim, 1.6);
  assert.ok(b.hp <= sim.maxHp(b) - 240, `hit: ${b.hp}`);
  run(sim, 2);
  assert.ok(b.x < 0, `dragged to the Radiant side: ${b.x}`);
  assert.ok(!b.mods.hooked);
  assert.strictEqual(a.hookOut, false);
  assert.strictEqual(sim.hooks.length, 0);
});

test('only one hook at a time, and a 3 s cooldown', () => {
  const sim = arena();
  const [a] = sim.pawns;
  place(a, -300, 0, 0);
  sim.input(a.id, { cast: 'hook', x: 500, y: 0 });
  run(sim, 0.4);
  assert.strictEqual(sim.hooks.length, 1);
  sim.input(a.id, { cast: 'hook', x: 500, y: 0 });
  run(sim, 0.4);
  assert.strictEqual(sim.hooks.length, 1);
  assert.ok(a.cd.hook > 0);
});

test('hooks bounce off the rock in the middle of the river', () => {
  const sim = arena();
  const [a] = sim.pawns;
  place(a, -300, -50);
  sim.input(a.id, { cast: 'hook', x: 500, y: -50 });
  run(sim, 0.6);
  assert.ok(sim.hooks[0].dx < 0);
});

test('hooks bounce off the arena wall and come back along their path', () => {
  const sim = arena();
  const [a] = sim.pawns;
  place(a, -300, 1300, Math.PI / 2);
  sim.input(a.id, { cast: 'hook', x: -300, y: 2000 });
  run(sim, 1.2);
  const h = sim.hooks[0];
  assert.ok(h.bounces >= 1 && h.dy < 0, 'bounced off the top wall');
  run(sim, 4);
  assert.strictEqual(sim.hooks.length, 0, 'reeled back in');
});

test('hooking a Pudge that is already hooked is a headshot (+2 score)', () => {
  const sim = arena(3);
  const [a, b, c] = sim.pawns; // a and c are Radiant, b is Dire
  sim.firstBlood = true;
  b.mods.hooked = { by: c.id };
  place(a, -300, 600);
  place(b, 400, 600);
  sim.input(a.id, { cast: 'hook', x: 400, y: 600 });
  run(sim, 1.3);
  assert.ok(b.dead);
  assert.strictEqual(sim.score[0], 2);
});

test('first blood is worth +4 on top of the kill', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  sim.damage(b, a, 99999);
  assert.strictEqual(sim.score[0], 5);
  assert.strictEqual(a.kills, 1);
  assert.ok(b.dead);
  run(sim, PW.RESPAWN + 0.1);
  assert.ok(!b.dead, 'back after 7 s');
});

test('the first team to the target score wins', () => {
  const sim = arena(2, { target: 6 });
  const [a, b] = sim.pawns;
  sim.damage(b, a, 99999); // 5 (first blood)
  run(sim, 8);
  sim.damage(b, a, 99999); // 6
  assert.strictEqual(sim.phase, 'over');
});

test('ally hooks pull without damage', () => {
  const sim = arena(3);
  const [a, , c] = sim.pawns;
  place(a, -1000, 0);
  place(c, -500, 0);
  const hp = c.hp;
  sim.input(a.id, { cast: 'hook', x: -500, y: 0 });
  run(sim, 0.8);
  assert.ok(c.mods.hooked);
  assert.ok(c.hp >= hp);
});

test('levels give ability points that upgrade the hook', () => {
  const sim = arena();
  const [a] = sim.pawns;
  sim.addXp(a, 200);
  assert.strictEqual(a.level, 3);
  assert.strictEqual(a.points, 2);
  sim.input(a.id, { upgrade: 'range' });
  sim.input(a.id, { upgrade: 'damage' });
  const st = sim.hookStats(a);
  assert.strictEqual(st.range, 1500 + 175);
  assert.strictEqual(st.damage, 250 + 35);
  assert.strictEqual(a.points, 0);
  assert.strictEqual(sim.upgrade(a, 'speed'), false);
});

test('passive gold and buying items that level up when bought again', () => {
  const sim = arena();
  const [a] = sim.pawns;
  run(sim, 10.05);
  assert.strictEqual(a.gold, 25);
  a.gold = 1000;
  sim.input(a.id, { buy: 'lycan_paw' });
  sim.input(a.id, { buy: 'lycan_paw' });
  assert.strictEqual(a.items[0].level, 2);
  assert.strictEqual(a.gold, 0);
  assert.strictEqual(sim.speed(a), 325 + 75);
  a.gold = 300;
  sim.input(a.id, { buy: 'tome_health' });
  assert.strictEqual(sim.maxHp(a), 1530 + 100);
});

test('cleaver damages and slows', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  place(a, -300, 0);
  place(b, 300, 0);
  sim.input(a.id, { cast: 'cleaver', x: 300, y: 0 });
  run(sim, 1);
  assert.ok(b.mods.cleaved);
  assert.ok(sim.speed(b) < 325);
});

test("Tiny's Arm throws a nearby Pudge across the river", () => {
  const sim = arena(3);
  const [a, , c] = sim.pawns;
  a.gold = 500;
  sim.buy(a, 'tiny_arm');
  place(a, -400, 0);
  place(c, -450, 0);
  sim.input(a.id, { cast: 'i0', x: 600, y: 0 });
  run(sim, 2);
  assert.ok(c.x > 0, `landed on the Dire side: ${c.x}`);
});

test('Techies barrel goes off when an enemy walks near it', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  sim.mines.push({ id: 99, team: 0, owner: a.id, x: 500, y: 0, level: 1, armed: 0 });
  place(b, 700, 0);
  const hp = b.hp;
  run(sim, 0.1);
  assert.strictEqual(sim.mines.length, 0);
  assert.ok(b.hp < hp - 400);
});

test('hooking a gold rune gives 500 gold', () => {
  const sim = arena();
  const [a] = sim.pawns;
  sim.runes.push({ id: 50, type: 'gold', x: 0, y: 230, held: null });
  place(a, -400, 600);
  sim.input(a.id, { cast: 'hook', x: 0, y: 600 });
  run(sim, 1);
  assert.strictEqual(a.gold, 500);
});

test('a hook bounces off an Earthshaker totem and damages an enemy one', () => {
  const sim = arena();
  const [a] = sim.pawns;
  sim.barriers.push({ id: 7, team: 1, owner: 'p1', x: 0, y: 400, r: 80, hp: 750, mx: 750 });
  place(a, -300, 400);
  sim.input(a.id, { cast: 'hook', x: 0, y: 400 });
  run(sim, 1);
  assert.ok(sim.barriers[0].hp < 750);
  assert.ok(sim.hooks.length === 0 || sim.hooks[0].bounces >= 1);
});

test('snapshots are plain JSON', () => {
  const sim = arena();
  sim.input('p0', { cast: 'hook', x: 400, y: 0 });
  run(sim, 0.5);
  const s = JSON.parse(JSON.stringify(sim.snapshot()));
  assert.strictEqual(s.p.length, 2);
  assert.ok(Array.isArray(s.h));
});

test('spike plate: spikes come up 0.65 s after someone steps on it', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  const spike = PW.TRAPS.find((t) => t.kind === 'spike' && t.x > 0);
  place(b, spike.x, spike.y);
  const hp = b.hp;
  run(sim, 0.4);
  assert.strictEqual(b.hp >= hp - 5, true, 'not yet');
  run(sim, 0.4);
  assert.ok(b.hp < hp - 500, `hit: ${b.hp}`);
  assert.ok(b.mods.stun);
  void a;
});

test('fire statue breathes a wave along its lane; credit goes to an enemy who set it off', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  const fire = PW.TRAPS.find((t) => t.kind === 'fire' && t.x > 0); // on the Dire side
  sim.firstBlood = true;
  b.hp = 300;
  place(b, fire.x - 200, fire.y);
  place(a, fire.x, fire.y); // a Radiant Pudge (thrown over) steps on the plate
  run(sim, 1);
  assert.ok(b.dead);
  assert.strictEqual(a.kills, 1);
});

test('venom slows and keeps hurting', () => {
  const sim = arena();
  const [, b] = sim.pawns;
  const venom = PW.TRAPS.find((t) => t.kind === 'venom' && t.x > 0);
  place(b, venom.x, venom.y);
  run(sim, 0.8);
  assert.ok(b.mods.venom);
  assert.strictEqual(sim.speed(b), 325 * 0.5);
  const hp = b.hp;
  run(sim, 3.1);
  assert.ok(b.hp < hp - 80);
});

test('the pendulum kills whoever is dragged through it', () => {
  const sim = arena();
  const [a, b] = sim.pawns;
  const pend = PW.TRAPS.find((t) => t.kind === 'pendulum' && t.y > 0);
  place(a, pend.x, pend.y); // Radiant steps on the bank plate
  run(sim, 0.1);
  b.mods.hooked = { by: a.id };
  let died = false;
  for (let i = 0; i < 60 && !died; i++) { place(b, sim.bladeX(sim.traps[pend.id]), pend.py); run(sim, 0.05); died = b.dead; }
  assert.ok(died);
});
