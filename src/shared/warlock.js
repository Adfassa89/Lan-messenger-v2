'use strict';
// Warlock: a real-time arena game for group chats, after the Warcraft 3 map
// "Warlock" and its Dota 2 port "Warlock Brawl". Knock the other warlocks
// into the lava; the last one standing wins the round.
//
// The numbers follow Warlock Brawl's open-source code (github.com/warlockbrawl):
// tick 0.035 s, friction 0.96 per tick, 1000 HP, 5 HP/s regeneration,
// move speed 210, knockback = damage x 10 x (1 + damage points / 1000)
// (above 100 damage: sqrt(100 x damage)), lava 100 damage per second in
// 0.25 s steps, 192-unit tiles, one ring of the platform sinks every 10 s,
// 30 s shop, 30 gold to start and 10 per round, spell values per level.
// Marked "approx." where the original's code could not be read.
//
// One PC (whoever opened the arena) runs this simulation; the others send
// their inputs and draw the snapshots it sends back.
(function init(root) {
  const TICK = 0.035;
  const FRICTION = 0.96;
  const MAX_HP = 1000;
  const REGEN = 5;
  const MOVE_SPEED = 210;
  const RADIUS = 30;
  const KB_DMG_TO_VELOCITY = 10;
  const TILE = 192;
  const LAYER_RADIUS = 100;
  const SHRINK_PERIOD = 10;
  const LAVA_DPS = 100;
  const LAVA_PERIOD = 0.25;
  const LAVA_DP_FACTOR = 0.5;
  const SHOP_TIME = 30;
  const ROUND_START_SHIELD = 2;
  const CASH_START = 30;
  const CASH_ROUND = 10;
  const CAST_POINT = 0.2;
  const COLORS = ['#e8443a', '#3a7be8', '#2fbf71', '#f2c230', '#a35ce8', '#f2862e', '#2fc6c9', '#e85ca8', '#9aa13a', '#8a8f99'];

  const lv = (arr, level) => arr[Math.min(arr.length, Math.max(1, level)) - 1];
  const steps = (a, step, n = 7) => Array.from({ length: n }, (_, i) => +(a + step * i).toFixed(2));

  // ------------------------------------------------------------------ spells
  // slot 0 = Fireball (Q), 1..6 = spell columns (W E R D F G), 7 = Scourge (X).
  const SPELLS = {
    fireball: { name: 'Fireball', icon: '🔥', col: 0, cd: [4.8], dmg: steps(70, 7), range: 1000, speed: 1000, radius: 25, cast: CAST_POINT, buy: 7, up: [7, 7, 7, 7, 7, 7] },
    scourge: { name: 'Scourge', icon: '💢', col: 7, cd: [3.0], dmg: [100, 110, 120], radius: 250, cast: 0.9, buy: 7, up: [7, 7], max: 3 },
    lightning: { name: 'Lightning', icon: '⚡', col: 1, cd: [16.5, 15.5, 15, 14.5, 14, 13.5, 13], dmg: steps(70, 8), range: 600, kb: 0.92, cast: CAST_POINT, buy: 11, up: [8, 9, 10, 11, 12, 13] },
    homing: { name: 'Homing', icon: '🔮', col: 1, cd: [16.5, 14.5, 13, 12, 11, 10, 9], dmg: steps(70, 10), speed: 1000, radius: 30, life: 4.5, cast: CAST_POINT, buy: 11, up: [8, 9, 10, 11, 12, 13] },
    boomerang: { name: 'Boomerang', icon: '🪃', col: 1, cd: [16, 13.9, 12.5, 11.7, 11, 10.3, 9.6], dmg: steps(70, 6), range: 800, radius: 38, kb: 0.95, cast: CAST_POINT, buy: 11, up: [7, 8, 9, 10, 11, 12] },
    teleport: { name: 'Teleport', icon: '✨', col: 2, cd: [16, 13.5, 11.5, 10, 9, 8, 7], range: steps(770, 70), cast: 0, buy: 12, up: [6, 7, 8, 9, 10, 11] },
    thrust: { name: 'Thrust', icon: '💨', col: 2, cd: [16.5, 14.5, 13, 12, 11, 10, 9], dmg: steps(50, 5), range: 900, speed: 1300, radius: 60, kb: 1.2, cast: 0, buy: 11, up: [6, 7, 8, 9, 10, 11] },
    swap: { name: 'Swap', icon: '🔄', col: 2, cd: [15.8, 13.3, 11.3, 9.8, 8.8, 7.8, 7.0], speed: 1983, radius: 40, life: 0.4706, cast: 0, buy: 11, up: [6, 7, 8, 9, 10, 11] },
    cluster: { name: 'Cluster', icon: '🎇', col: 3, cd: steps(15.5, -0.75), dmg: steps(33, 3), range: 672, speed: 844, radius: 22, kb: 0.65, cast: CAST_POINT, buy: 14, up: [6, 7, 8, 9, 10, 11] },
    bouncer: { name: 'Bouncer', icon: '🟢', col: 3, cd: [19, 18, 17, 16, 15, 14, 13], dmg: steps(54, 8), speed: 900, radius: 38, kb: 1.2, cast: CAST_POINT, buy: 14, up: [6, 7, 8, 9, 10, 11] },
    meteor: { name: 'Meteor', icon: '☄️', col: 4, cd: steps(20, -0.5), dmg: steps(110, 10), dmgMin: 40, radius: [225, 240, 255, 269, 282, 294, 304], range: 1000, delay: 1.15, cast: CAST_POINT, buy: 14, up: [6, 7, 8, 9, 10, 11] },
    windwalk: { name: 'Windwalk', icon: '👻', col: 4, cd: [29, 26, 23.5, 21, 19.5, 18.5, 17.5], dmg: steps(54, 6), duration: 2.6, bonus: 200, cast: 0, buy: 14, up: [6, 7, 8, 9, 10, 11] },
    shield: { name: 'Shield', icon: '🛡️', col: 5, cd: [14, 13, 12, 11, 10, 9, 8], duration: 1.2, radius: steps(200, 10), cast: 0, buy: 12, up: [6, 7, 8, 9, 10, 11] },
    rush: { name: 'Rush', icon: '🏃', col: 5, cd: [21, 20, 19, 18, 17, 16, 15], duration: steps(6, 0.5), absorb: steps(50, 20), cast: 0, buy: 12, up: [6, 7, 8, 9, 10, 11] },
    gravity: { name: 'Gravity', icon: '🌀', col: 6, cd: steps(21, -0.5), strength: steps(500, 30), dps: [20, 33.33, 46.67, 60, 73.33, 86.67, 100], speed: 450, life: 2, cast: CAST_POINT, buy: 12, up: [7, 8, 9, 10, 11, 12] },
    link: { name: 'Link', icon: '⛓️', col: 6, cd: [17, 15, 13, 11, 9, 7, 7], dmg: steps(12, 8), range: 860, speed: 950, radius: 35, pull: 1550, hold: 2.5, cast: CAST_POINT, buy: 12, up: [6, 7, 8, 9, 10, 11] },
  };
  const COLUMN_SPELLS = [[], ['lightning', 'homing', 'boomerang'], ['teleport', 'thrust', 'swap'], ['cluster', 'bouncer'], ['meteor', 'windwalk'], ['shield', 'rush'], ['gravity', 'link']];
  const ITEMS = {
    ring: { name: 'Ring of Health', icon: '💍', buy: 4, max: 5, hp: [100, 190, 270, 340, 400] },
    cape: { name: 'Cape', icon: '🧥', buy: 3, max: 3, regen: [1.5, 2.5, 3.5] },
    armor: { name: 'Armor', icon: '🦺', buy: 6, max: 3, kbRed: [0.12, 0.18, 0.22] },
    boots: { name: 'Boots', icon: '👢', buy: 5, max: 3, speed: [18, 29, 40] },
  };

  // ------------------------------------------------------------------ helpers
  const len = (x, y) => Math.hypot(x, y);
  function norm(x, y) {
    const l = Math.hypot(x, y);
    return l > 1e-6 ? [x / l, y / l] : [1, 0];
  }

  class Sim {
    // players: [{ id, name }]; options: { rounds }
    constructor(players, { rounds = 11, seed = 1 } = {}) {
      this.rounds = rounds;
      this.round = 0;
      this.rand = mulberry(seed);
      this.time = 0;
      this.phase = 'lobby'; // shop | fight | roundEnd | over
      this.phaseLeft = 0;
      this.nextId = 1;
      this.projectiles = [];
      this.effects = []; // pending one-off events for the clients
      this.pawns = players.map((p, i) => ({
        id: p.id, name: p.name, color: COLORS[i % COLORS.length], score: 0, cash: CASH_START, kills: 0, dmgDone: 0,
        spells: { 0: { key: 'fireball', level: 1 }, 7: { key: 'scourge', level: 1 } }, items: {},
        x: 0, y: 0, vx: 0, vy: 0, face: 0, hp: MAX_HP, dp: 0, dead: true, left: false,
        move: null, cd: {}, casting: null, mods: {}, lastHit: null,
      }));
      this.layer = 0;
      this.lavaAcc = 0;
      this.shrinkAcc = 0;
    }

    pawn(id) { return this.pawns.find((p) => p.id === id); }
    alive() { return this.pawns.filter((p) => !p.dead && !p.left); }
    fx(e) { this.effects.push(e); }

    // ---------------------------------------------------------------- arena
    tileExists(gx, gy) { return Math.hypot(gx * TILE, gy * TILE) <= this.layer * LAYER_RADIUS; }
    onLava(x, y) { return !this.tileExists(Math.floor(x / TILE + 0.5), Math.floor(y / TILE + 0.5)); }
    platformRadius() { return this.layer * LAYER_RADIUS; }

    // ---------------------------------------------------------------- flow
    start() { this.toShop(); }

    toShop() {
      this.phase = 'shop';
      this.phaseLeft = SHOP_TIME;
      this.layer = 13 + this.pawns.length + 1;
      this.projectiles = [];
      for (const p of this.pawns) {
        p.ready = false;
        if (!p.left) this.respawn(p, true);
      }
      this.fx({ e: 'shop' });
    }

    toFight() {
      this.round++;
      this.phase = 'fight';
      this.layer = 13 + this.pawns.length;
      this.shrinkAcc = 0;
      this.projectiles = [];
      const active = this.pawns.filter((p) => !p.left);
      active.forEach((p, i) => {
        const a = (2 * Math.PI * i) / active.length;
        const r = (13 + this.pawns.length) * 100 - 600;
        this.respawn(p, false);
        p.x = r * Math.cos(a);
        p.y = r * Math.sin(a);
        p.face = Math.atan2(-p.y, -p.x);
        p.mods.spawnShield = ROUND_START_SHIELD;
      });
      this.fx({ e: 'fight', round: this.round });
    }

    respawn(p, inShop) {
      p.dead = false;
      p.hp = this.maxHp(p);
      p.dp = 0;
      p.vx = p.vy = 0;
      p.move = null;
      p.casting = null;
      p.mods = {};
      p.cd = {};
      p.lastHit = null;
      if (inShop) { p.x = 0; p.y = 0; }
    }

    maxHp(p) { return MAX_HP + (p.items.ring ? lv(ITEMS.ring.hp, p.items.ring) : 0); }
    regen(p) { return REGEN + (p.items.cape ? lv(ITEMS.cape.regen, p.items.cape) : 0); }
    speed(p) {
      let s = MOVE_SPEED + (p.items.boots ? lv(ITEMS.boots.speed, p.items.boots) : 0);
      if (p.mods.windwalk) s += SPELLS.windwalk.bonus;
      if (p.mods.rush) s += 35 + p.mods.rush.bonus;
      return s;
    }

    // ---------------------------------------------------------------- shop
    // Everyone ready: the shop closes after 3 more seconds.
    setReady(id) {
      const p = this.pawn(id);
      if (!p || this.phase !== 'shop') return;
      p.ready = true;
      if (this.pawns.every((q) => q.ready || q.left)) this.phaseLeft = Math.min(this.phaseLeft, 3);
    }

    buy(id, what) {
      const p = this.pawn(id);
      if (!p || this.phase !== 'shop') return false;
      if (SPELLS[what]) {
        const def = SPELLS[what];
        const cur = p.spells[def.col];
        if (cur && cur.key === what) {
          const max = def.max || 7;
          if (cur.level >= max) return false;
          const cost = def.up[cur.level - 1];
          if (p.cash < cost) return false;
          p.cash -= cost;
          cur.level++;
          return true;
        }
        if (cur) return false; // one spell per column
        if (p.cash < def.buy) return false;
        p.cash -= def.buy;
        p.spells[def.col] = { key: what, level: 1 };
        return true;
      }
      if (ITEMS[what]) {
        const def = ITEMS[what];
        const level = p.items[what] || 0;
        const count = Object.keys(p.items).length + 2; // Fireball and Scourge take item slots too
        if (level >= def.max || (!level && count >= 6) || p.cash < def.buy) return false;
        p.cash -= def.buy;
        p.items[what] = level + 1;
        p.hp = this.maxHp(p);
        return true;
      }
      return false;
    }

    // ---------------------------------------------------------------- input
    input(id, inp) {
      const p = this.pawn(id);
      if (!p || p.dead || p.left || this.phase !== 'fight') return;
      if (inp.move) {
        p.move = [Number(inp.move[0]) || 0, Number(inp.move[1]) || 0];
        if (p.casting && p.casting.t > 0) p.casting = null; // moving cancels a cast in progress
      } else if (inp.stop) {
        p.move = null;
        p.casting = null;
      } else if (inp.cast !== undefined) {
        this.cast(p, Number(inp.cast), Number(inp.x) || 0, Number(inp.y) || 0);
      }
    }

    cast(p, slot, tx, ty) {
      const s = p.spells[slot];
      if (!s || p.casting) return;
      const def = SPELLS[s.key];
      if ((p.cd[slot] || 0) > 0) return;
      p.face = Math.atan2(ty - p.y, tx - p.x);
      if (def.cast > 0) {
        p.casting = { slot, tx, ty, t: def.cast };
        p.move = null;
      } else {
        this.fire(p, slot, tx, ty);
      }
    }

    fire(p, slot, tx, ty) {
      const s = p.spells[slot];
      if (!s) return;
      const def = SPELLS[s.key];
      const L = s.level;
      p.cd[slot] = lv(def.cd, L);
      if (p.mods.windwalk) delete p.mods.windwalk; // casting breaks invisibility
      const [dx, dy] = norm(tx - p.x, ty - p.y);
      const dist = len(tx - p.x, ty - p.y);
      const proj = (o) => this.projectiles.push({ id: this.nextId++, owner: p.id, age: 0, hits: [], ...o });
      this.fx({ e: 'cast', k: s.key, id: p.id, x: p.x, y: p.y });
      switch (s.key) {
        case 'fireball':
          proj({ k: 'fireball', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: def.range / def.speed, dmg: lv(def.dmg, L), kb: 1 });
          break;
        case 'scourge': {
          const dmg = lv(def.dmg, L);
          this.damageArea(p, p.x, p.y, def.radius, { amount: dmg, kbMin: 0.75, kbMax: 1 });
          p.hp = Math.max(1, p.hp - (L === 1 ? dmg : 100));
          this.fx({ e: 'scourge', x: p.x, y: p.y, r: def.radius });
          break;
        }
        case 'lightning': {
          // Instant beam: hits the first enemy along the line.
          const range = def.range;
          let best = null;
          for (const o of this.alive()) {
            if (o.id === p.id) continue;
            const along = (o.x - p.x) * dx + (o.y - p.y) * dy;
            if (along < 0 || along > range + RADIUS) continue;
            const off = Math.abs((o.x - p.x) * dy - (o.y - p.y) * dx);
            if (off <= 25 + RADIUS && (!best || along < best.along)) best = { o, along };
          }
          const end = best ? best.along : range;
          this.fx({ e: 'bolt', x1: p.x, y1: p.y, x2: p.x + dx * end, y2: p.y + dy * end });
          if (best) this.damage(best.o, p, lv(def.dmg, L), dx, dy, def.kb);
          break;
        }
        case 'homing': {
          let target = null;
          let bd = Infinity;
          for (const o of this.alive()) {
            if (o.id === p.id) continue;
            const d = len(o.x - tx, o.y - ty);
            if (d < bd) { bd = d; target = o.id; }
          }
          proj({ k: 'homing', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * 800, vy: dy * 800, r: def.radius, life: def.life, dmg: lv(def.dmg, L), kb: 1, target, speed: def.speed });
          break;
        }
        case 'boomerang': {
          const d = Math.max(300, Math.min(dist, def.range));
          proj({ k: 'boomerang', x: p.x + dx * 40, y: p.y + dy * 40, dirx: dx, diry: dy, d, phase: 'out', t: 0, vx: dx * 1500 + -dy * 300, vy: dy * 1500 + dx * 300, r: def.radius, life: 6, dmg: lv(def.dmg, L), kb: def.kb });
          break;
        }
        case 'teleport': {
          const r = Math.min(dist, lv(def.range, L));
          this.fx({ e: 'blink', x1: p.x, y1: p.y, x2: p.x + dx * r, y2: p.y + dy * r });
          p.x += dx * r;
          p.y += dy * r;
          p.vx *= 0.8;
          p.vy *= 0.8;
          p.move = null;
          break;
        }
        case 'thrust': {
          const d = Math.min(dist, def.range);
          p.vx = dx * def.speed * 0.77;
          p.vy = dy * def.speed * 0.77;
          p.mods.thrust = { t: 0.09 + d / def.speed, dx, dy, dmg: lv(def.dmg, L) };
          p.move = null;
          break;
        }
        case 'swap':
          proj({ k: 'swap', x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: Math.min(dist / def.speed, def.life), any: true });
          break;
        case 'cluster':
          for (const a of [-0.18, -0.06, 0.06, 0.18]) {
            const c = Math.cos(a);
            const sn = Math.sin(a);
            const ux = dx * c - dy * sn;
            const uy = dx * sn + dy * c;
            proj({ k: 'cluster', x: p.x + ux * 40, y: p.y + uy * 40, vx: ux * def.speed, vy: uy * def.speed, r: def.radius, life: def.range / def.speed, dmg: lv(def.dmg, L), kb: def.kb });
          }
          break;
        case 'bouncer':
          proj({ k: 'bouncer', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: 1, dmg: lv(def.dmg, L), kb: def.kb, prev: null });
          break;
        case 'meteor': {
          const d = Math.min(dist, def.range);
          proj({ k: 'meteor', x: p.x + dx * d, y: p.y + dy * d, vx: 0, vy: 0, r: lv(def.radius, L), life: def.delay, dmg: lv(def.dmg, L), dmgMin: def.dmgMin, ghost: true });
          break;
        }
        case 'windwalk':
          p.mods.windwalk = { t: def.duration, dmg: lv(def.dmg, L) };
          break;
        case 'shield':
          p.mods.shield = { t: def.duration, r: lv(def.radius, L) };
          break;
        case 'rush':
          p.mods.rush = { t: lv(def.duration, L), absorb: lv(def.absorb, L), bonus: 0 };
          break;
        case 'gravity':
          proj({ k: 'gravity', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: 25, life: def.life, strength: lv(def.strength, L), dps: lv(def.dps, L), ghost: true, tick: 0 });
          break;
        case 'link':
          proj({ k: 'link', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: def.range / def.speed, dmg: lv(def.dmg, L), any: true });
          break;
        default:
          break;
      }
    }

    // ---------------------------------------------------------------- damage
    damage(target, src, amount, nx, ny, kbFactor = 1, { vuln = 1, noKb = false } = {}) {
      if (target.dead || target.mods.spawnShield) return;
      let dmg = amount;
      if (target.mods.rush && src && src.id !== target.id) {
        const absorbed = Math.min(target.mods.rush.absorb, dmg * 0.5);
        target.mods.rush.absorb -= absorbed;
        target.mods.rush.bonus += 1.5 * absorbed;
        dmg -= absorbed;
      }
      target.hp -= dmg;
      if (src && src.id !== target.id) {
        target.lastHit = { id: src.id, t: this.time };
        src.dmgDone += dmg;
      }
      if (!noKb) {
        const kbRed = target.items.armor ? lv(ITEMS.armor.kbRed, target.items.armor) : 0;
        const k = dmg > 100 ? Math.sqrt(100 * dmg) : dmg;
        const kb = Math.max(0, 1 - kbRed) * k * KB_DMG_TO_VELOCITY * (1 + target.dp / 1000) * kbFactor;
        target.vx += nx * kb;
        target.vy += ny * kb;
      }
      // Damage points: each hit makes the next knockback stronger.
      target.dp += dmg * vuln;
      if (src) this.fx({ e: 'hit', id: target.id, x: target.x, y: target.y, n: Math.round(dmg) });
      if (target.hp <= 0) this.kill(target);
    }

    // Damage that falls off from the centre (meteor, scourge, explosions).
    damageArea(src, x, y, r, { amount, amountMin = amount, kbMin = 1, kbMax = 1 }) {
      for (const o of this.alive()) {
        if (src && o.id === src.id) continue;
        const d = len(o.x - x, o.y - y);
        if (d > r + RADIUS) continue;
        const f = Math.min(1, d / r);
        const [nx, ny] = norm(o.x - x, o.y - y);
        this.damage(o, src, amount + (amountMin - amount) * f, nx, ny, kbMax + (kbMin - kbMax) * f);
      }
    }

    kill(p) {
      p.dead = true;
      p.hp = 0;
      p.vx = p.vy = 0;
      p.mods = {};
      const killer = p.lastHit && this.time - p.lastHit.t < 8 ? this.pawn(p.lastHit.id) : null;
      if (killer && killer.id !== p.id) killer.kills++;
      this.fx({ e: 'death', id: p.id, x: p.x, y: p.y, by: killer ? killer.id : null });
    }

    // ---------------------------------------------------------------- tick
    step() {
      const dt = TICK;
      this.time += dt;
      this.phaseLeft -= dt;
      if (this.phase === 'shop') {
        if (this.phaseLeft <= 0) this.toFight();
        return;
      }
      if (this.phase === 'roundEnd') {
        if (this.phaseLeft <= 0) {
          if (this.round >= this.rounds) this.finish();
          else this.toShop();
        }
        return;
      }
      if (this.phase !== 'fight') return;

      // The platform shrinks one ring every 10 seconds.
      this.shrinkAcc += dt;
      if (this.shrinkAcc >= SHRINK_PERIOD && this.layer > 1) {
        this.shrinkAcc -= SHRINK_PERIOD;
        this.layer--;
        this.fx({ e: 'shrink', layer: this.layer });
      }
      this.stepPawns(dt);
      this.stepProjectiles(dt);
      this.collidePawns();
      // Lava: 100 damage per second, in quarter-second steps.
      this.lavaAcc += dt;
      if (this.lavaAcc >= LAVA_PERIOD) {
        this.lavaAcc -= LAVA_PERIOD;
        for (const p of this.alive()) {
          if (this.onLava(p.x, p.y) && !p.mods.spawnShield) {
            this.damage(p, null, LAVA_DPS * LAVA_PERIOD, 0, 0, 1, { vuln: LAVA_DP_FACTOR, noKb: true });
            if (!p.dead) this.fx({ e: 'burn', id: p.id });
          }
        }
      }
      // Last warlock standing wins the round.
      const alive = this.alive();
      if (alive.length <= 1) {
        const winner = alive[0] || null;
        if (winner) winner.score++;
        for (const p of this.pawns) p.cash += CASH_ROUND;
        this.phase = 'roundEnd';
        this.phaseLeft = 3;
        this.fx({ e: 'roundEnd', round: this.round, winner: winner ? winner.id : null });
      }
    }

    stepPawns(dt) {
      for (const p of this.alive()) {
        for (const k of Object.keys(p.cd)) p.cd[k] = Math.max(0, p.cd[k] - dt);
        for (const [k, m] of Object.entries(p.mods)) {
          if (typeof m === 'number') {
            p.mods[k] = m - dt;
            if (p.mods[k] <= 0) delete p.mods[k];
          } else if (m && m.t !== undefined) {
            m.t -= dt;
            if (m.t <= 0) {
              if (k === 'thrust') { p.vx *= 0.2; p.vy *= 0.2; }
              delete p.mods[k];
            }
          }
        }
        if (p.casting) {
          p.casting.t -= dt;
          if (p.casting.t <= 0) {
            const c = p.casting;
            p.casting = null;
            this.fire(p, c.slot, c.tx, c.ty);
          }
        }
        p.hp = Math.min(this.maxHp(p), p.hp + this.regen(p) * dt);
        // Knockback velocity fades; walking is added on top.
        p.vx *= FRICTION;
        p.vy *= FRICTION;
        if (p.mods.thrust) {
          p.vx += p.mods.thrust.dx * 1733.33 * dt;
          p.vy += p.mods.thrust.dy * 1733.33 * dt;
        }
        let wx = 0;
        let wy = 0;
        if (p.move && !p.casting && !p.mods.thrust) {
          const dx = p.move[0] - p.x;
          const dy = p.move[1] - p.y;
          const d = len(dx, dy);
          const sp = this.speed(p);
          if (d < sp * dt) {
            p.move = null;
          } else {
            wx = (dx / d) * sp;
            wy = (dy / d) * sp;
            p.face = Math.atan2(dy, dx);
          }
        }
        p.x += (p.vx + wx) * dt;
        p.y += (p.vy + wy) * dt;
        // The whole arena is fenced at 5910 units.
        const r = len(p.x, p.y);
        if (r > 5910) {
          p.x *= 5910 / r;
          p.y *= 5910 / r;
        }
      }
    }

    collidePawns() {
      const a = this.alive();
      for (let i = 0; i < a.length; i++) {
        for (let j = i + 1; j < a.length; j++) {
          const p = a[i];
          const q = a[j];
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d = len(dx, dy);
          if (d >= 2 * RADIUS || d < 1e-6) continue;
          const [nx, ny] = [dx / d, dy / d];
          // Thrust hits: damage scaled by speed, knockback 1.2, thrust ends.
          for (const [s, t, sx, sy] of [[p, q, nx, ny], [q, p, -nx, -ny]]) {
            if (!s.mods.thrust) continue;
            if (t.mods.shield) {
              s.vx = -s.vx;
              s.vy = -s.vy;
              delete s.mods.thrust;
              continue;
            }
            const v2 = s.vx * s.vx + s.vy * s.vy;
            let f = v2 / (1300 * 1300);
            f = f < 0.8 ? f / 0.8 : 1;
            const dmg = s.mods.thrust.dmg * f;
            delete s.mods.thrust;
            s.vx = 0;
            s.vy = 0;
            this.damage(t, s, dmg, sx, sy, 1.2);
          }
          // Windwalk hits: damage, knockback 1, invisibility ends.
          for (const [s, t, sx, sy] of [[p, q, nx, ny], [q, p, -nx, -ny]]) {
            if (!s.mods.windwalk) continue;
            const dmg = s.mods.windwalk.dmg;
            delete s.mods.windwalk;
            this.damage(t, s, dmg, sx, sy, 1);
          }
          // Warlocks bump: elastic push (elasticity 0.5) and separation.
          const rel = (p.vx - q.vx) * nx + (p.vy - q.vy) * ny;
          if (rel > 0) {
            const imp = 0.5 * rel * (1 + 0.5);
            p.vx -= imp * nx;
            p.vy -= imp * ny;
            q.vx += imp * nx;
            q.vy += imp * ny;
          }
          const push = (2 * RADIUS - d) / 2;
          p.x -= nx * push;
          p.y -= ny * push;
          q.x += nx * push;
          q.y += ny * push;
        }
      }
    }

    stepProjectiles(dt) {
      const keep = [];
      for (const b of this.projectiles) {
        b.age += dt;
        const owner = this.pawn(b.owner);
        let gone = false;
        // Movement per kind.
        if (b.k === 'homing') {
          const t = this.pawn(b.target);
          if (!t || t.dead || t.id === b.owner) {
            let bd = Infinity;
            b.target = null;
            for (const o of this.alive()) {
              if (o.id === b.owner) continue;
              const d = len(o.x - b.x, o.y - b.y);
              if (d < bd) { bd = d; b.target = o.id; }
            }
          }
          const tt = this.pawn(b.target);
          if (tt) {
            const [ux, uy] = norm(tt.x - b.x, tt.y - b.y);
            b.vx = 0.97 * b.vx + 0.03 * ux * b.speed;
            b.vy = 0.97 * b.vy + 0.03 * uy * b.speed;
          }
        } else if (b.k === 'boomerang') {
          b.t += dt;
          if (b.phase === 'out') {
            const par = -(1500 * 1500) / (2 * b.d);
            const t1 = (2 * b.d) / 1500;
            b.vx += b.dirx * par * dt + b.diry * (600 / t1) * dt;
            b.vy += b.diry * par * dt - b.dirx * (600 / t1) * dt;
            if (b.t >= t1 + 0.15) b.phase = 'back';
          } else if (owner && !owner.dead) {
            const [ux, uy] = norm(owner.x - b.x, owner.y - b.y);
            const cx = ux * 1000 - b.vx;
            const cy = uy * 1000 - b.vy;
            const cl = len(cx, cy);
            const m = Math.min(cl, 3000 * dt) / (cl || 1);
            b.vx += cx * m;
            b.vy += cy * m;
            if (len(owner.x - b.x, owner.y - b.y) < 75) gone = true;
          } else {
            gone = true;
          }
        } else if (b.k === 'gravity') {
          // Pulls enemies (and other spells) towards it and burns those close by.
          for (const o of this.alive()) {
            if (o.id === b.owner) continue;
            const d = len(o.x - b.x, o.y - b.y);
            if (d < 550) {
              const [ux, uy] = norm(b.x - o.x, b.y - o.y);
              const a = b.strength * (1 - (d * d) / (550 * 550));
              o.vx += ux * a * dt;
              o.vy += uy * a * dt;
            }
          }
          for (const q of this.projectiles) {
            if (q === b || ['meteor', 'gravity', 'link'].includes(q.k)) continue;
            const d = len(q.x - b.x, q.y - b.y);
            if (d < 600) {
              const [ux, uy] = norm(b.x - q.x, b.y - q.y);
              const a = 1650 * (1.5 - (d * d) / (600 * 600));
              q.vx += ux * a * dt;
              q.vy += uy * a * dt;
            }
          }
          b.tick += dt;
          if (b.tick >= 0.2) {
            b.tick -= 0.2;
            for (const o of this.alive()) {
              if (o.id !== b.owner && len(o.x - b.x, o.y - b.y) <= 250) this.damage(o, owner, b.dps * 0.2, 0, 0, 1, { noKb: true });
            }
          }
        } else if (b.k === 'linked') {
          // An active link pulls the target towards the caster (approx.: 2.5 s).
          const t = this.pawn(b.target);
          if (!owner || owner.dead || !t || t.dead) gone = true;
          else {
            const [ux, uy] = norm(owner.x - t.x, owner.y - t.y);
            t.vx += ux * 1550 * dt;
            t.vy += uy * 1550 * dt;
            if (b.enemy) this.damage(t, owner, b.dmg * dt / 2.5, 0, 0, 1, { noKb: true });
            b.x = t.x;
            b.y = t.y;
          }
        }
        if (b.k !== 'linked') {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
        }
        b.life -= dt;

        // Shields turn enemy spells around and make them the shield owner's.
        if (!b.ghost && b.k !== 'swap' && b.k !== 'linked') {
          for (const o of this.alive()) {
            if (!o.mods.shield || o.id === b.owner || b.shielded === o.id) continue;
            const d = len(b.x - o.x, b.y - o.y);
            if (d <= o.mods.shield.r) {
              const [nx, ny] = norm(b.x - o.x, b.y - o.y);
              const dot = b.vx * -nx + b.vy * -ny;
              if (dot > 0) {
                b.vx += 2 * dot * nx;
                b.vy += 2 * dot * ny;
              }
              if (b.k !== 'boomerang' && b.k !== 'link') b.owner = o.id;
              if (b.k === 'homing') b.target = null;
              if (b.k === 'boomerang') b.phase = 'back';
              b.shielded = o.id;
              b.life = Math.max(b.life, 0.5);
              this.fx({ e: 'reflect', x: b.x, y: b.y });
            }
          }
        }

        // Hits on warlocks.
        if (!gone && !b.ghost && b.k !== 'linked') {
          for (const o of this.alive()) {
            if (o.id === b.owner && !(b.k === 'bouncer' && b.prev)) continue;
            if (b.hits.includes(o.id) && b.k !== 'bouncer') continue;
            if (b.k === 'bouncer' && b.prev === o.id) continue;
            if (len(o.x - b.x, o.y - b.y) > b.r + RADIUS) continue;
            const [nx, ny] = norm(b.vx, b.vy);
            if (b.k === 'swap') {
              if (owner && o.id !== owner.id) {
                const sx = owner.x;
                const sy = owner.y;
                owner.x = o.x;
                owner.y = o.y;
                o.x = sx;
                o.y = sy;
                owner.move = null;
                this.fx({ e: 'swap', x1: owner.x, y1: owner.y, x2: o.x, y2: o.y });
                b.swapped = true;
                gone = true;
              }
              break;
            }
            if (b.k === 'link') {
              this.projectiles.push({ id: this.nextId++, k: 'linked', owner: b.owner, target: o.id, x: o.x, y: o.y, vx: 0, vy: 0, r: 0, life: SPELLS.link.hold, dmg: b.dmg, enemy: true, hits: [], age: 0 });
              this.fx({ e: 'link', x: o.x, y: o.y });
              gone = true;
              break;
            }
            this.damage(o, owner, b.dmg, nx, ny, b.kb);
            this.fx({ e: 'boom', k: b.k, x: b.x, y: b.y });
            b.hits.push(o.id);
            if (b.k === 'bouncer') {
              b.dmg *= 0.7;
              b.prev = o.id;
              if (b.dmg < 10) { gone = true; break; }
              // Next target: the closest other warlock.
              let next = null;
              let bd = Infinity;
              for (const q of this.alive()) {
                if (q.id === o.id) continue;
                const d = len(q.x - b.x, q.y - b.y);
                if (d < bd) { bd = d; next = q; }
              }
              if (!next) { gone = true; break; }
              const [ux, uy] = norm(next.x - b.x, next.y - b.y);
              b.vx = ux * 900;
              b.vy = uy * 900;
              b.life = 1;
            } else if (b.k === 'boomerang') {
              const k = 500 / Math.max(1, len(b.vx, b.vy));
              b.vx = -b.vx * k;
              b.vy = -b.vy * k;
              b.phase = 'back';
            } else {
              gone = true;
            }
            break;
          }
        }

        // Spells hitting spells: both explode (not meteors, gravity or links).
        if (!gone && !b.ghost && b.k !== 'linked' && b.k !== 'swap') {
          for (const q of this.projectiles) {
            if (q === b || q.ghost || q.dead || q.k === 'linked' || q.k === 'swap' || q.owner === b.owner) continue;
            if (len(q.x - b.x, q.y - b.y) <= b.r + q.r) {
              q.dead = true;
              gone = true;
              this.fx({ e: 'boom', k: 'clash', x: (b.x + q.x) / 2, y: (b.y + q.y) / 2 });
              break;
            }
          }
        }

        if (b.life <= 0 && !gone) {
          gone = true;
          if (b.k === 'meteor') {
            this.damageArea(owner, b.x, b.y, b.r, { amount: b.dmg, amountMin: b.dmgMin });
            this.fx({ e: 'meteor', x: b.x, y: b.y, r: b.r });
          } else if (b.k === 'swap' && owner && !b.swapped) {
            // A miss still moves the caster to the end of the swap path.
            this.fx({ e: 'swap', x1: owner.x, y1: owner.y, x2: b.x, y2: b.y });
            owner.x = b.x;
            owner.y = b.y;
            owner.move = null;
          }
        }
        if (!gone && !b.dead) keep.push(b);
      }
      this.projectiles = keep;
    }

    finish() {
      this.phase = 'over';
      const order = this.pawns.slice().sort((a, b) => b.score - a.score || b.kills - a.kills || b.dmgDone - a.dmgDone);
      this.fx({ e: 'over', winner: order[0] ? order[0].id : null });
    }

    leave(id) {
      const p = this.pawn(id);
      if (!p) return;
      p.left = true;
      if (!p.dead) this.kill(p);
    }

    // ---------------------------------------------------------------- network
    snapshot() {
      const r1 = (v) => Math.round(v * 10) / 10;
      const snap = {
        t: r1(this.time), ph: this.phase, left: Math.max(0, r1(this.phaseLeft)), round: this.round, rounds: this.rounds, layer: this.layer,
        shrink: r1(SHRINK_PERIOD - this.shrinkAcc),
        p: this.pawns.map((p) => ({
          id: p.id, x: r1(p.x), y: r1(p.y), f: r1(p.face), hp: Math.round(p.hp), mx: this.maxHp(p), dp: Math.round(p.dp), d: p.dead ? 1 : 0, l: p.left ? 1 : 0,
          sc: p.score, k: p.kills, c: p.cash, cast: p.casting ? 1 : 0,
          m: Object.keys(p.mods).filter((k) => p.mods[k]),
          sh: p.mods.shield ? p.mods.shield.r : 0,
          cd: Object.fromEntries(Object.entries(p.cd).filter(([, v]) => v > 0).map(([k, v]) => [k, r1(v)])),
          sp: Object.fromEntries(Object.entries(p.spells).map(([k, v]) => [k, [v.key, v.level]])),
          it: p.items,
        })),
        b: this.projectiles.map((b) => [b.k, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.r, b.owner, b.k === 'linked' ? b.target : b.life > 0 ? r1(b.life) : 0]),
        fx: this.effects,
      };
      this.effects = [];
      return snap;
    }
  }

  // Small seeded random generator.
  function mulberry(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const Warlock = {
    Sim, SPELLS, ITEMS, COLUMN_SPELLS, COLORS, TICK, TILE, LAYER_RADIUS, RADIUS, MAX_HP, SHOP_TIME, SHRINK_PERIOD, lv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Warlock;
  else root.Warlock = Warlock;
}(typeof window !== 'undefined' ? window : globalThis));
