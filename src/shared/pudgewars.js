'use strict';
// Pudge Wars: two teams of Pudges on either side of a river hook each other
// across it. Re-implemented from the open-source Dota 2 custom game
// (github.com/CaioBrighenti/PudgeWars, version 7.28): hook.lua, runes.lua,
// events.lua, constants.lua, abilities.lua and the npc_*_custom.txt files.
// Values marked "approx." could not be read from that code.
//
// One PC (whoever opened the game) runs this simulation; the others send
// their inputs and draw the snapshots it sends back.
(function init(root) {
  const TICK = 1 / 30; // the hook code runs at 30 steps a second
  // Arena (hook.lua LaunchHook): hooks bounce off walls at x = ±1472, y = ±1600
  // and off a circle of radius 150 around (0, -50) in the middle of the river.
  const WALL_X = 1472;
  const WALL_Y = 1600;
  const WALK_X = 1440; // Tiny's Arm refuses targets beyond this (abilities.lua)
  const WALK_Y = 1560;
  const RIVER = 200; // |x| < 200 is the river: no walking across it
  const CENTER = { x: 0, y: -50, r: 150 };
  const RADIUS = 24; // a Pudge's collision radius (Dota hero hull)
  const MOVE_SPEED = 325;
  const TURN_SPEED = Math.PI / 0.15; // Pudge turn rate 0.7 (approx. 0.15 s for 180°)
  const FACE_TOLERANCE = (11.5 * Math.PI) / 180;
  const RESPAWN = 7; // FIXED_RESPAWN_TIME
  const GOLD_TICK = 10; // GOLD_TICK_TIME
  const GOLD_PER_TICK = 25;
  const RUNE_EVERY = 30;
  const XP_TABLE = [0, 50, 200, 450, 800, 1100, 1700, 2400, 3100, 3900, 4500, 5000, 6500, 8000, 9000, 10500, 11000, 12000, 13500, 15000, 16500, 18000, 20000, 21000, 22000, 23000, 25000, 27000, 29000, 31000, 34000, 37000, 40000, 43000, 46000, 49000, 54000, 58000, 62000, 66000, 70000, 74000];
  const TEAM_NAMES = ['Radiant', 'Dire'];
  const COLORS = ['#4385ff', '#aaffc3', '#820096', '#ffea00', '#ff9900', '#beff00', '#ff0000', '#008080', '#fffac8', '#9a9a9a'];

  // Meat Hook (pudge_wars_custom_hook) and its four upgrades, 10 levels each,
  // one ability point per level gained.
  const HOOK = { damage: 250, range: 1500, speed: 800, radius: 100, cd: 3, cast: 0.3 };
  const UPGRADES = { damage: 35, range: 175, speed: 70, radius: 15 };
  const UPGRADE_MAX = 10;
  // Butcher's Cleaver (pudge_wars_cleaver).
  const CLEAVER = { damage: 100, slow: 0.25, duration: 3, range: 900, speed: 1000, radius: 100, cd: 12, cast: 0.3 };
  const ATTACK = { damage: 70, range: 150, point: 0.5, bat: 1.7 };

  // Shop (shops.txt, npc_items_custom.txt). Items upgrade by buying them again,
  // up to level 5, for the same price (filters.lua).
  const ITEMS = {
    tiny_arm: { name: "Tiny's Arm", cost: 500, max: 5, active: true, cd: [10, 9, 8, 7, 6], range: [1000, 1500, 2000, 2500, 3000], grab: 250, damage: 200, stun: 2 },
    grapple: { name: 'Grappling Hook', cost: 200, max: 5, active: true, cd: [10, 9, 8, 7, 6], range: 2300, speed: 1000, radius: 40, pull: 1600 },
    lycan_paw: { name: "Lycan's Paw", cost: 500, max: 5, speed: [50, 75, 100, 125, 150], pct: 0.12, attackSpeed: 30 },
    naix_jaw: { name: "Naix's Jaw", cost: 450, max: 5, lifesteal: [20, 25, 30, 35, 40] },
    lantern: { name: "Barathrum's Lantern", cost: 650, max: 5, pct: [25, 30, 35, 40, 45] },
    mine: { name: 'Techies Explosive Barrel', cost: 600, max: 5, active: true, cd: [30], channel: 1.5, damage: [500, 575, 650, 725, 800], radius: 300, range: 100 },
    claw: { name: "Strygwyr's Claw", cost: 650, max: 5, pct: [10, 15, 20, 25, 30], cap: 200, linger: 3 },
    turbine: { name: 'Ricochet Turbine', cost: 350, max: 5, perBounce: [0.1, 0.2, 0.3, 0.4, 0.5] },
    totem: { name: 'Earthshaker Totem', cost: 400, max: 5, active: true, cd: [40], range: 1200, hp: [750, 900, 1050, 1200, 1350], radius: 80 },
    tome_wisdom: { name: 'Tome of Wisdom', cost: 200, consumable: true },
    tome_damage: { name: 'Tome of Damage', cost: 150, consumable: true, damage: 25, max: 10 },
    tome_health: { name: 'Tome of Health', cost: 125, consumable: true, hp: 100 },
    salve: { name: 'Instant Greater Salve', cost: 50, active: true, cd: [50], heal: 400 }, // heal approx.
  };
  const RUNES = ['haste', 'gold', 'shield', 'fire', 'dynamite', 'lightning'];

  const len = (x, y) => Math.hypot(x, y);
  function norm(x, y) {
    const l = Math.hypot(x, y);
    return l > 1e-6 ? [x / l, y / l] : [1, 0];
  }
  const lv = (arr, level) => (Array.isArray(arr) ? arr[Math.min(arr.length, Math.max(1, level)) - 1] : arr);
  // Dota armour: damage taken multiplier.
  const armorMul = (a) => 1 - (0.052 * a) / (0.9 + 0.048 * Math.abs(a));

  class Sim {
    // players: [{ id, name, team }]; options: { target (score to win), seed }
    constructor(players, { target = 50, seed = 1 } = {}) {
      this.target = target;
      this.rand = mulberry(seed);
      this.time = 0;
      this.phase = 'pre'; // pre | fight | over
      this.phaseLeft = 5;
      this.nextId = 1;
      this.score = [0, 0];
      this.firstBlood = false;
      this.goldAcc = 0;
      this.runeAcc = RUNE_EVERY - 10;
      this.effects = [];
      this.hooks = [];
      this.cleavers = [];
      this.grapples = [];
      this.mines = [];
      this.barriers = [];
      this.runes = [];
      this.pawns = players.map((p, i) => ({
        id: p.id, name: p.name, team: p.team === 1 ? 1 : p.team === 0 ? 0 : i % 2, color: COLORS[i % COLORS.length],
        x: 0, y: 0, face: 0, z: 0, hp: 1, level: 1, xp: 0, gold: 0, kills: 0, deaths: 0, dmgTomes: 0, hpTomes: 0,
        dead: false, left: false, respawnAt: 0, move: null, attack: null, attackCd: 0, swing: 0, casting: null,
        cd: {}, items: [], up: { damage: 0, range: 0, speed: 0, radius: 0 }, points: 0, mods: {}, lastHit: null, hookOut: false,
      }));
      for (const p of this.pawns) { this.spawn(p); p.hp = this.maxHp(p); }
    }

    pawn(id) { return this.pawns.find((p) => p.id === id); }
    alive() { return this.pawns.filter((p) => !p.dead && !p.left); }
    fx(e) { this.effects.push(e); }
    side(team) { return team === 0 ? -1 : 1; } // Radiant on the left (x < 0), Dire on the right

    // ---------------------------------------------------------------- stats
    str(p) { return 30 + 3 * (p.level - 1); }
    maxHp(p) { return 930 + this.str(p) * 20 + p.hpTomes * ITEMS.tome_health.hp; }
    regen(p) { return 2 + this.str(p) * 0.1; } // base Pudge regen + strength (approx.)
    item(p, key) { return p.items.find((it) => it.key === key); }
    speed(p) {
      if (p.mods.slowRune) return Math.min(150, MOVE_SPEED);
      if (p.mods.haste) return 550;
      const paw = this.item(p, 'lycan_paw');
      let s = MOVE_SPEED + (paw ? lv(ITEMS.lycan_paw.speed, paw.level) : 0);
      if (paw && paw.level >= 5) s *= 1 + ITEMS.lycan_paw.pct;
      if (p.mods.cleaved) s *= 1 - CLEAVER.slow;
      return s;
    }
    hookStats(p) {
      let speed = HOOK.speed + UPGRADES.speed * p.up.speed;
      if (p.mods.slowRune) speed -= 300;
      if (p.mods.haste) speed += 400;
      return {
        damage: HOOK.damage + UPGRADES.damage * p.up.damage,
        range: HOOK.range + UPGRADES.range * p.up.range,
        speed: Math.max(100, speed),
        radius: HOOK.radius + UPGRADES.radius * p.up.radius,
      };
    }
    attackDamage(p) { return ATTACK.damage + ITEMS.tome_damage.damage * p.dmgTomes; }

    // ---------------------------------------------------------------- flow
    spawn(p) {
      const mates = this.pawns.filter((q) => q.team === p.team && !q.left);
      const i = mates.indexOf(p);
      const n = mates.length;
      p.x = this.side(p.team) * 1250;
      p.y = n > 1 ? -500 + (1000 * i) / (n - 1) : 0;
      p.face = p.team === 0 ? 0 : Math.PI;
      p.z = 0;
      p.dead = false;
      p.hp = this.maxHp(p);
      p.move = null;
      p.attack = null;
      p.casting = null;
      p.mods = {};
      p.hookOut = false;
    }

    step() {
      const dt = TICK;
      this.time += dt;
      if (this.phase === 'pre') {
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) { this.phase = 'fight'; this.fx({ e: 'start' }); }
        return;
      }
      if (this.phase !== 'fight') return;
      // Passive gold: 25 every 10 s.
      this.goldAcc += dt;
      if (this.goldAcc >= GOLD_TICK) {
        this.goldAcc -= GOLD_TICK;
        for (const p of this.pawns) p.gold += GOLD_PER_TICK;
      }
      // A rune every 30 s, walking up the river.
      this.runeAcc += dt;
      if (this.runeAcc >= RUNE_EVERY) {
        this.runeAcc -= RUNE_EVERY;
        this.runes.push({ id: this.nextId++, type: RUNES[Math.floor(this.rand() * RUNES.length)], x: 0, y: -1700, held: null });
        this.fx({ e: 'runeSpawn' });
      }
      for (const r of this.runes) if (!r.held) r.y += 450 * dt;
      this.runes = this.runes.filter((r) => r.held || r.y < 2000);
      for (const p of this.pawns) if (p.dead && !p.left && this.time >= p.respawnAt) { this.spawn(p); this.fx({ e: 'respawn', id: p.id }); }
      this.stepPawns(dt);
      this.stepHooks(dt);
      this.stepCleavers(dt);
      this.stepGrapples(dt);
      this.stepMines(dt);
      this.collide();
    }

    // ---------------------------------------------------------------- input
    input(id, inp) {
      const p = this.pawn(id);
      if (!p || p.left || this.phase === 'over') return;
      if (inp.buy) return void this.buy(p, String(inp.buy));
      if (inp.upgrade) return void this.upgrade(p, String(inp.upgrade));
      if (p.dead || p.mods.hooked || p.mods.tossed || p.mods.stun || p.mods.grappling) return;
      if (inp.move) {
        p.move = [Number(inp.move[0]) || 0, Number(inp.move[1]) || 0];
        p.attack = null;
        p.casting = null;
      } else if (inp.attack) {
        const t = this.pawn(inp.attack);
        if (t && t.team !== p.team && !t.dead) { p.attack = t.id; p.move = null; p.casting = null; }
      } else if (inp.stop) {
        p.move = null;
        p.attack = null;
        p.casting = null;
      } else if (inp.cast) {
        this.cast(p, String(inp.cast), Number(inp.x) || 0, Number(inp.y) || 0);
      }
    }

    // Spells: 'hook', 'cleaver', or an item slot 'i0'..'i5'.
    cast(p, what, tx, ty) {
      if (this.phase !== 'fight' || p.mods.silenced) return;
      let key = what;
      let it = null;
      if (what[0] === 'i') {
        it = p.items[Number(what.slice(1))];
        if (!it || !ITEMS[it.key].active) return;
        key = it.key;
        if ((it.cd || 0) > 0) return;
      } else if (!['hook', 'cleaver'].includes(what) || (p.cd[what] || 0) > 0) return;
      if (key === 'hook' && p.hookOut) return; // one hook at a time
      if (key === 'salve') { this.fire(p, key, it, tx, ty); return; }
      const cast = key === 'hook' ? HOOK.cast : key === 'cleaver' ? CLEAVER.cast : key === 'mine' ? 0.1 : 0.3;
      p.casting = { key, slot: what, tx, ty, t: cast, total: cast, turning: true };
      p.move = null;
      p.attack = null;
    }

    fire(p, key, it, tx, ty) {
      const [dx, dy] = norm(tx - p.x, ty - p.y);
      this.fx({ e: 'cast', k: key, id: p.id, x: p.x, y: p.y });
      if (key === 'hook') {
        const st = this.hookStats(p);
        p.cd.hook = HOOK.cd;
        p.hookOut = true;
        this.hooks.push({
          id: this.nextId++, owner: p.id, x: p.x + dx * 75, y: p.y + dy * 75, dx, dy, ...st, out: st.range / st.speed,
          phase: 'out', corners: [], hooked: null, dropped: false, bounces: 0, rebounce: 0, fire: !!p.mods.fire,
          lightning: !!p.mods.lightning, rupture: 0, ruptureT: 0,
        });
        return;
      }
      if (key === 'cleaver') {
        p.cd.cleaver = CLEAVER.cd;
        this.cleavers.push({ id: this.nextId++, owner: p.id, x: p.x, y: p.y, vx: dx * CLEAVER.speed, vy: dy * CLEAVER.speed, life: CLEAVER.range / CLEAVER.speed });
        return;
      }
      const def = ITEMS[key];
      if (it) it.cd = lv(def.cd, it.level);
      if (key === 'salve') {
        p.hp = Math.min(this.maxHp(p), p.hp + def.heal);
        this.fx({ e: 'heal', id: p.id, n: def.heal });
      } else if (key === 'grapple') {
        this.grapples.push({ id: this.nextId++, owner: p.id, x: p.x, y: p.y, dx, dy, left: def.range, phase: 'out' });
      } else if (key === 'tiny_arm') {
        // Throws the nearest Pudge or mine next to you to the target point.
        const range = lv(def.range, it.level);
        const d = Math.min(len(tx - p.x, ty - p.y), range);
        const px = Math.max(-WALK_X, Math.min(WALK_X, p.x + dx * d));
        const py = Math.max(-WALK_Y, Math.min(WALK_Y, p.y + dy * d));
        let best = null;
        let bd = def.grab;
        for (const q of this.alive()) {
          if (q === p || q.mods.tossed) continue;
          const dd = len(q.x - p.x, q.y - p.y);
          if (dd <= bd) { bd = dd; best = { kind: 'pawn', o: q }; }
        }
        for (const m of this.mines) {
          const dd = len(m.x - p.x, m.y - p.y);
          if (dd <= bd) { bd = dd; best = { kind: 'mine', o: m }; }
        }
        if (!best) { it.cd = 0; return; } // nothing to throw: no cooldown
        const o = best.o;
        o.toss = { x0: o.x, y0: o.y, x1: px, y1: py, t: 0, dur: 1.3, by: p.id, level: it.level };
        if (best.kind === 'pawn') {
          o.mods.tossed = true;
          o.move = null; o.attack = null; o.casting = null;
        }
        this.fx({ e: 'toss', id: best.kind === 'pawn' ? o.id : null, x: o.x, y: o.y });
      } else if (key === 'mine') {
        // Channel 1.5 s, then the barrel is planted next to you.
        p.mods.channel = { t: def.channel, x: p.x + dx * Math.min(def.range, len(tx - p.x, ty - p.y)), y: p.y + dy * Math.min(def.range, len(tx - p.x, ty - p.y)), level: it.level };
      } else if (key === 'totem') {
        const d = Math.min(len(tx - p.x, ty - p.y), def.range);
        const hp = lv(def.hp, it.level);
        this.barriers.push({ id: this.nextId++, team: p.team, owner: p.id, x: p.x + dx * d, y: p.y + dy * d, r: def.radius, hp, mx: hp });
        this.fx({ e: 'totem', x: p.x + dx * d, y: p.y + dy * d });
      }
    }

    // ---------------------------------------------------------------- shop and upgrades
    buy(p, key) {
      const def = ITEMS[key];
      if (!def || p.gold < def.cost || p.left) return false;
      if (def.consumable) {
        if (key === 'tome_damage' && p.dmgTomes >= def.max) return false;
        p.gold -= def.cost;
        if (key === 'tome_wisdom') this.addXp(p, (XP_TABLE[p.level] ?? XP_TABLE[XP_TABLE.length - 1]) - (XP_TABLE[p.level - 1] ?? 0));
        if (key === 'tome_damage') p.dmgTomes++;
        if (key === 'tome_health') { p.hpTomes++; p.hp += def.hp; }
        this.fx({ e: 'buy', id: p.id, k: key });
        return true;
      }
      const have = this.item(p, key);
      if (have) {
        if (have.level >= (def.max || 1)) return false;
        p.gold -= def.cost;
        have.level++;
      } else {
        if (p.items.length >= 6) return false;
        p.gold -= def.cost;
        p.items.push({ key, level: 1, cd: 0 });
      }
      this.fx({ e: 'buy', id: p.id, k: key });
      return true;
    }

    upgrade(p, what) {
      if (!(what in p.up) || p.points < 1 || p.up[what] >= UPGRADE_MAX) return false;
      p.points--;
      p.up[what]++;
      return true;
    }

    addXp(p, n) {
      p.xp += n;
      while (p.level < XP_TABLE.length && p.xp >= XP_TABLE[p.level]) {
        const before = this.maxHp(p);
        p.level++;
        p.points++;
        p.hp += this.maxHp(p) - before;
        this.fx({ e: 'level', id: p.id, lv: p.level });
      }
    }

    // ---------------------------------------------------------------- damage
    damage(t, src, amount, { pure = true, headshot = false } = {}) {
      if (t.dead || this.phase !== 'fight') return;
      const dmg = pure ? amount : amount * armorMul(-1.42);
      t.hp -= dmg;
      if (src && src.id !== t.id) t.lastHit = { id: src.id, t: this.time };
      if (dmg >= 1) this.fx({ e: 'hit', id: t.id, n: Math.round(dmg), x: t.x, y: t.y });
      if (t.hp <= 0) this.kill(t, src, headshot);
    }

    kill(t, src, headshot) {
      t.dead = true;
      t.hp = 0;
      t.deaths++;
      t.respawnAt = this.time + RESPAWN;
      t.mods = {};
      t.move = null;
      t.attack = null;
      t.casting = null;
      for (const h of this.hooks) if (h.hooked && h.hooked.id === t.id) { h.hooked = null; h.dropped = true; }
      let killer = src && src.id !== t.id ? src : t.lastHit && this.time - t.lastHit.t < 10 ? this.pawn(t.lastHit.id) : null;
      if (killer && killer.id === t.id) killer = null;
      const enemyKill = killer && killer.team !== t.team;
      if (enemyKill) {
        // events.lua: +1, +2 for a headshot, +4 for first blood.
        let sc = headshot ? 2 : 1;
        if (!this.firstBlood) { sc += 4; this.firstBlood = true; this.fx({ e: 'firstBlood', id: killer.id }); }
        this.score[killer.team] += sc;
        killer.kills++;
        killer.gold += 110 + 8 * t.level; // Dota hero kill bounty (approx.)
        this.addXp(killer, Math.round(40 + 0.14 * t.xp)); // Dota hero kill XP (approx.)
      }
      this.fx({ e: 'death', id: t.id, by: killer ? killer.id : null, x: t.x, y: t.y, headshot: !!headshot, deny: !!(killer && killer.team === t.team) });
      if (this.score[0] >= this.target || this.score[1] >= this.target) {
        this.phase = 'over';
        this.fx({ e: 'over', team: this.score[0] >= this.target ? 0 : 1 });
      }
    }

    // ---------------------------------------------------------------- pawns
    turn(p, want, dt) {
      let d = want - p.face;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const step = TURN_SPEED * dt;
      if (Math.abs(d) <= step) p.face = want;
      else p.face += Math.sign(d) * step;
      p.face = Math.atan2(Math.sin(p.face), Math.cos(p.face));
      return Math.abs(d) <= FACE_TOLERANCE;
    }

    stepPawns(dt) {
      for (const p of this.pawns) {
        for (const it of p.items) if (it.cd > 0) it.cd = Math.max(0, it.cd - dt);
        for (const k of Object.keys(p.cd)) p.cd[k] = Math.max(0, p.cd[k] - dt);
      }
      for (const p of this.alive()) {
        for (const [k, m] of Object.entries(p.mods)) {
          if (m && typeof m === 'object' && m.t !== undefined) {
            m.t -= dt;
            if (m.t <= 0) {
              delete p.mods[k];
              if (k === 'dynamite') this.dynamite(p);
              if (k === 'channel') {
                const it = this.item(p, 'mine');
                this.mines.push({ id: this.nextId++, team: p.team, owner: p.id, x: m.x, y: m.y, level: m.level, armed: 0.5 });
                this.fx({ e: 'mine', x: m.x, y: m.y });
                if (it) it.cd = lv(ITEMS.mine.cd, it.level);
              }
            }
          }
        }
        p.hp = Math.min(this.maxHp(p), p.hp + this.regen(p) * dt);
        // Shield rune: burns enemy Pudges within 400 (15 every 0.1 s).
        if (p.mods.shield) {
          p.mods.shield.tick = (p.mods.shield.tick || 0) + dt;
          while (p.mods.shield.tick >= 0.1) {
            p.mods.shield.tick -= 0.1;
            for (const q of this.alive()) if (q.team !== p.team && len(q.x - p.x, q.y - p.y) <= 400) this.damage(q, p, 15);
          }
        }
        if (p.toss) { this.stepToss(p, dt); continue; }
        if (p.mods.hooked || p.mods.grappling || p.mods.stun || p.mods.channel) continue;
        // Cast: turn to face, then the cast point.
        if (p.casting) {
          const c = p.casting;
          if (c.turning && (c.key === 'salve' || this.turn(p, Math.atan2(c.ty - p.y, c.tx - p.x), dt))) c.turning = false;
          if (!c.turning) {
            c.t -= dt;
            if (c.t <= 0) {
              p.casting = null;
              const it = c.slot[0] === 'i' ? p.items[Number(c.slot.slice(1))] : null;
              if (c.key === 'hook' && p.hookOut) { /* refund: a hook is still out */ } else this.fire(p, c.key, it, c.tx, c.ty);
            }
          }
          continue;
        }
        // Attack order: walk into melee range, swing (attack point 0.5, 1.7 s per attack).
        if (p.attack) {
          const t = this.pawn(p.attack);
          if (!t || t.dead || t.mods.tossed) { p.attack = null; continue; }
          const d = len(t.x - p.x, t.y - p.y);
          if (d <= ATTACK.range + 2 * RADIUS) {
            if (this.turn(p, Math.atan2(t.y - p.y, t.x - p.x), dt) && p.attackCd <= 0) {
              p.swing += dt;
              if (p.swing >= ATTACK.point) {
                p.swing = 0;
                const paw = this.item(p, 'lycan_paw');
                p.attackCd = ATTACK.bat / (paw ? 1 + ITEMS.lycan_paw.attackSpeed / 100 : 1) - ATTACK.point;
                this.damage(t, p, this.attackDamage(p), { pure: false });
                this.fx({ e: 'attack', id: p.id, t: t.id });
              }
            }
            p.attackCd -= dt;
            continue;
          }
          p.swing = 0;
          p.attackCd -= dt;
          this.walkTo(p, t.x, t.y, dt);
          continue;
        }
        p.attackCd -= dt;
        if (p.move) {
          if (this.walkTo(p, p.move[0], p.move[1], dt)) p.move = null;
        }
      }
    }

    // Walks towards a point on your side of the river; true when there.
    walkTo(p, tx, ty, dt) {
      const dx = tx - p.x;
      const dy = ty - p.y;
      const d = len(dx, dy);
      const sp = this.speed(p) * dt;
      if (d <= sp) { p.x = tx; p.y = ty; this.keepOnSide(p); return true; }
      if (this.turn(p, Math.atan2(dy, dx), dt)) {
        p.x += (dx / d) * sp;
        p.y += (dy / d) * sp;
        this.keepOnSide(p);
      }
      return false;
    }

    // The river cannot be walked across; the arena edge stops everyone.
    keepOnSide(p) {
      const s = p.x < 0 ? -1 : 1;
      if (Math.abs(p.x) < RIVER + RADIUS) p.x = s * (RIVER + RADIUS);
      p.x = Math.max(-WALK_X, Math.min(WALK_X, p.x));
      p.y = Math.max(-WALK_Y, Math.min(WALK_Y, p.y));
    }

    stepToss(p, dt) {
      const o = p.toss;
      o.t += dt;
      const k = Math.min(1, o.t / o.dur);
      p.x = o.x0 + (o.x1 - o.x0) * k;
      p.y = o.y0 + (o.y1 - o.y0) * k;
      p.z = Math.sin(k * Math.PI) * 500;
      if (k >= 1) this.land(p, o);
    }

    land(o, toss) {
      delete o.toss;
      if (o.mods) delete o.mods.tossed;
      o.z = 0;
      if (o.mods) this.keepOnSide(o);
      this.fx({ e: 'land', x: o.x, y: o.y });
      // Level 5: 200 damage and a 2 s stun where it lands.
      if (toss.level >= 5) {
        const by = this.pawn(toss.by);
        for (const q of this.alive()) {
          if (by && q.team === by.team) continue;
          if (len(q.x - o.x, q.y - o.y) <= 200) {
            this.damage(q, by, ITEMS.tiny_arm.damage, { pure: false });
            if (!q.dead) q.mods.stun = { t: ITEMS.tiny_arm.stun };
          }
        }
      }
    }

    // ---------------------------------------------------------------- the hook
    hookTargets(h) {
      const owner = this.pawn(h.owner);
      const hit = h.radius / 2;
      const out = [];
      for (const q of this.alive()) {
        if (q.id === h.owner || q.mods.tossed) continue;
        if (len(q.x - h.x, q.y - h.y) <= hit + RADIUS) out.push({ kind: 'pawn', o: q });
      }
      for (const b of this.barriers) if (len(b.x - h.x, b.y - h.y) <= hit + b.r) out.push({ kind: 'barrier', o: b });
      for (const m of this.mines) if (!m.hooked && len(m.x - h.x, m.y - h.y) <= hit + 20) out.push({ kind: 'mine', o: m });
      for (const r of this.runes) if (!r.held && len(r.x - h.x, r.y - h.y) <= hit + 40) out.push({ kind: 'rune', o: r });
      return { owner, out };
    }

    // findEntity in hook.lua: what the hook catches or bounces off.
    hookCatch(h, forward) {
      const { owner, out } = this.hookTargets(h);
      if (!owner) return;
      for (const { kind, o } of out) {
        if (kind === 'pawn') {
          if (o.mods.shield) { if (forward) this.bounceOff(h, o.x, o.y); continue; }
          h.phase = 'back';
          if (o.mods.hooked && o.team !== owner.team) {
            this.fx({ e: 'headshot', id: o.id, by: owner.id });
            this.damage(o, owner, 9000, { headshot: true });
          } else if (o.mods.hooked) {
            this.fx({ e: 'deny', id: o.id, by: owner.id });
            this.damage(o, owner, 9000);
          } else {
            let dmg = h.damage;
            const lantern = this.item(owner, 'lantern');
            if (lantern) dmg += (h.speed * lv(ITEMS.lantern.pct, lantern.level)) / 100;
            const turbine = this.item(owner, 'turbine');
            if (turbine) dmg += lv(ITEMS.turbine.perBounce, turbine.level) * h.bounces * h.damage;
            o.mods.hooked = { by: owner.id };
            o.move = null; o.attack = null; o.casting = null;
            h.hooked = { kind: 'pawn', id: o.id };
            if (o.team !== owner.team) {
              const jaw = this.item(owner, 'naix_jaw');
              if (jaw) owner.hp = Math.min(this.maxHp(owner), owner.hp + (h.damage * lv(ITEMS.naix_jaw.lifesteal, jaw.level)) / 100);
              const claw = this.item(owner, 'claw');
              if (claw) h.rupture = claw.level;
              this.fx({ e: 'hooked', id: o.id, by: owner.id, x: o.x, y: o.y });
              this.damage(o, owner, dmg);
              if (h.lightning) this.lightning(owner, o.x, o.y);
            } else this.fx({ e: 'hooked', id: o.id, by: owner.id, ally: 1, x: o.x, y: o.y });
            if (o.dead) { h.hooked = null; h.dropped = true; }
          }
          return;
        }
        if (kind === 'barrier') {
          if (!forward) continue;
          this.bounceOff(h, o.x, o.y);
          if (o.team !== owner.team) this.hitBarrier(o, h.damage);
          return;
        }
        if (kind === 'mine') {
          h.phase = 'back';
          h.hooked = { kind: 'mine', id: o.id };
          o.hooked = h.id;
          return;
        }
        if (kind === 'rune') {
          h.phase = 'back';
          h.hooked = { kind: 'rune', id: o.id };
          o.held = h.id;
          this.runeHooked(owner, o.type);
          return;
        }
      }
    }

    bounceOff(h, cx, cy) {
      if (h.rebounce > 0) return;
      h.rebounce = 10 * TICK;
      const [nx, ny] = norm(h.x - cx, h.y - cy);
      const dot = h.dx * nx + h.dy * ny;
      if (dot < 0) { h.dx -= 2 * dot * nx; h.dy -= 2 * dot * ny; }
      h.bounces++;
      h.corners.push([h.x, h.y]);
      this.fx({ e: 'bounce', x: h.x, y: h.y });
    }

    hitBarrier(b, dmg) {
      b.hp -= dmg;
      this.fx({ e: 'barrierHit', id: b.id, x: b.x, y: b.y });
      if (b.hp <= 0) { this.barriers = this.barriers.filter((q) => q !== b); this.fx({ e: 'barrierBreak', x: b.x, y: b.y }); }
    }

    stepHooks(dt) {
      for (const h of this.hooks) {
        const owner = this.pawn(h.owner);
        h.rebounce -= dt;
        if (!owner || owner.dead || owner.left) { h.done = true; continue; }
        if (h.phase === 'out') {
          h.x += h.dx * h.speed * dt;
          h.y += h.dy * h.speed * dt;
          h.out -= dt;
          // Walls and the centre circle.
          let bounced = false;
          if ((h.x > WALL_X && h.dx > 0) || (h.x < -WALL_X && h.dx < 0)) { h.dx = -h.dx; bounced = true; }
          if ((h.y > WALL_Y && h.dy > 0) || (h.y < -WALL_Y && h.dy < 0)) { h.dy = -h.dy; bounced = true; }
          if (bounced) { h.bounces++; h.corners.push([h.x, h.y]); this.fx({ e: 'bounce', x: h.x, y: h.y }); }
          if (len(h.x - CENTER.x, h.y - CENTER.y) < CENTER.r) this.bounceOff(h, CENTER.x, CENTER.y);
          if (!h.hooked) this.hookCatch(h, true);
          if (h.out <= 0 && h.phase === 'out') h.phase = 'back';
        } else {
          // Reels back along its own path (through the bounce corners) to Pudge.
          const target = h.corners.length ? h.corners[h.corners.length - 1] : [owner.x, owner.y];
          const [ux, uy] = norm(target[0] - h.x, target[1] - h.y);
          const d = len(target[0] - h.x, target[1] - h.y);
          const step = h.speed * dt;
          if (d <= step) {
            h.x = target[0];
            h.y = target[1];
            if (h.corners.length) h.corners.pop();
          } else {
            h.x += ux * step;
            h.y += uy * step;
          }
          if (!h.hooked && !h.dropped) this.hookCatch(h, false);
          if (!h.corners.length && len(owner.x - h.x, owner.y - h.y) < 100) h.done = true;
        }
        // The catch rides on the hook head.
        if (h.hooked) this.dragHooked(h, owner, dt);
        // Fire rune: the hook burns enemies along its way (125 per second within 200).
        if (h.fire) for (const q of this.alive()) if (q.team !== owner.team && len(q.x - h.x, q.y - h.y) <= 200) this.damage(q, owner, 125 * dt);
      }
      for (const h of this.hooks) {
        if (!h.done) continue;
        const owner = this.pawn(h.owner);
        if (owner) owner.hookOut = false;
        if (h.hooked) this.release(h, owner);
      }
      this.hooks = this.hooks.filter((h) => !h.done);
    }

    dragHooked(h, owner, dt) {
      const { kind, id } = h.hooked;
      if (kind === 'pawn') {
        const o = this.pawn(id);
        if (!o || o.dead) { h.hooked = null; h.dropped = true; return; }
        const moved = len(h.x - o.x, h.y - o.y);
        o.x = h.x;
        o.y = h.y;
        // Strygwyr's Claw: the pulled enemy bleeds for the distance moved.
        if (h.rupture && o.team !== owner.team) this.rupture(o, owner, moved, h.rupture, dt);
        if (len(owner.x - o.x, owner.y - o.y) < 150) this.release(h, owner);
      } else if (kind === 'mine') {
        const m = this.mines.find((q) => q.id === id);
        if (!m) { h.hooked = null; return; }
        m.x = h.x; m.y = h.y;
        if (len(owner.x - m.x, owner.y - m.y) < 150) this.release(h, owner);
      } else if (kind === 'rune') {
        const r = this.runes.find((q) => q.id === id);
        if (r) { r.x = h.x; r.y = h.y; }
        if (!r || len(owner.x - h.x, owner.y - h.y) < 150) this.release(h, owner);
      }
    }

    rupture(o, owner, moved, level, dt) {
      o.ruptureAcc = (o.ruptureAcc || 0) + (moved * lv(ITEMS.claw.pct, level)) / 100;
      o.ruptureT = (o.ruptureT || 0) + dt;
      if (o.ruptureT >= 0.25) {
        o.ruptureT = 0;
        const n = Math.min(ITEMS.claw.cap, o.ruptureAcc);
        o.ruptureAcc = 0;
        if (n > 0) this.damage(o, owner, n);
      }
    }

    release(h, owner) {
      if (!h.hooked) return;
      const { kind, id } = h.hooked;
      h.hooked = null;
      h.dropped = true;
      if (kind === 'pawn') {
        const o = this.pawn(id);
        if (!o) return;
        delete o.mods.hooked;
        // Dropped next to the hooker, on dry land (FindClearSpaceForUnit).
        if (Math.abs(o.x) < RIVER + RADIUS && owner) o.x = (owner.x < 0 ? -1 : 1) * (RIVER + RADIUS);
        this.keepOnSide(o);
        const claw = owner && this.item(owner, 'claw');
        if (claw && claw.level >= 5 && o.team !== owner.team) o.mods.bleed = { t: ITEMS.claw.linger, by: owner.id, lx: o.x, ly: o.y };
        this.fx({ e: 'drop', id: o.id });
      } else if (kind === 'rune') {
        this.runes = this.runes.filter((r) => r.id !== id);
      } else if (kind === 'mine') {
        const m = this.mines.find((q) => q.id === id);
        if (m) { delete m.hooked; m.armed = 0.3; }
      }
    }

    // ---------------------------------------------------------------- runes (runes.lua)
    runeHooked(p, type) {
      this.fx({ e: 'rune', type, id: p.id });
      this.addXp(p, 50);
      if (type === 'haste') {
        for (const q of this.alive()) {
          if (q === p) q.mods.haste = { t: 15 };
          else q.mods.slowRune = { t: 15 };
        }
      } else if (type === 'gold') {
        p.gold += 500;
      } else if (type === 'shield') {
        p.mods.shield = { t: 12 };
      } else if (type === 'fire') {
        p.mods.fire = { t: 24 };
      } else if (type === 'dynamite') {
        p.mods.silenced = { t: 10 };
        p.mods.dynamite = { t: 10 };
      } else if (type === 'lightning') {
        p.mods.lightning = { t: 15 }; // approx.: lasts 15 s
      }
    }

    // Dynamite rune: after 10 s every enemy Pudge within 400 dies, then you do.
    dynamite(p) {
      this.fx({ e: 'dynamite', x: p.x, y: p.y });
      for (const q of this.alive()) if (q.team !== p.team && len(q.x - p.x, q.y - p.y) <= 400) this.damage(q, p, 100000);
      if (!p.dead) this.damage(p, null, 100000);
    }

    // Lightning rune: a hit calls down a lightning strike (approx.: 200 damage within 250, 0.5 s stun).
    lightning(owner, x, y) {
      this.fx({ e: 'lightning', x, y });
      for (const q of this.alive()) {
        if (q.team === owner.team || len(q.x - x, q.y - y) > 250) continue;
        this.damage(q, owner, 200, { pure: false });
        if (!q.dead) q.mods.stun = { t: 0.5 };
      }
    }

    // ---------------------------------------------------------------- cleaver, grapple, mines
    stepCleavers(dt) {
      for (const c of this.cleavers) {
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.life -= dt;
        const owner = this.pawn(c.owner);
        for (const q of this.alive()) {
          if (!owner || q.team === owner.team || len(q.x - c.x, q.y - c.y) > CLEAVER.radius / 2 + RADIUS) continue;
          this.damage(q, owner, CLEAVER.damage, { pure: false });
          if (!q.dead) q.mods.cleaved = { t: CLEAVER.duration };
          this.fx({ e: 'cleave', id: q.id, x: q.x, y: q.y });
          c.life = 0;
          break;
        }
        if (Math.abs(c.x) > WALL_X || Math.abs(c.y) > WALL_Y) c.life = 0;
      }
      this.cleavers = this.cleavers.filter((c) => c.life > 0);
    }

    // Grappling Hook: latches onto the first unit, barrier, obstacle or wall and
    // pulls you there – the only way to cross the river on foot (approx.).
    stepGrapples(dt) {
      for (const g of this.grapples) {
        const p = this.pawn(g.owner);
        if (!p || p.dead) { g.done = true; continue; }
        if (g.phase === 'out') {
          const st = ITEMS.grapple.speed * dt;
          g.x += g.dx * st;
          g.y += g.dy * st;
          g.left -= st;
          let hit = Math.abs(g.x) >= WALL_X || Math.abs(g.y) >= WALL_Y || len(g.x - CENTER.x, g.y - CENTER.y) <= CENTER.r;
          for (const b of this.barriers) if (len(b.x - g.x, b.y - g.y) <= b.r + ITEMS.grapple.radius) hit = true;
          for (const q of this.alive()) if (q !== p && len(q.x - g.x, q.y - g.y) <= RADIUS + ITEMS.grapple.radius) hit = true;
          if (hit) {
            g.phase = 'pull';
            g.x = Math.max(-WALK_X, Math.min(WALK_X, g.x));
            g.y = Math.max(-WALK_Y, Math.min(WALK_Y, g.y));
            p.mods.grappling = true;
            p.move = null; p.attack = null; p.casting = null;
            this.fx({ e: 'latch', x: g.x, y: g.y });
          } else if (g.left <= 0) g.phase = 'back';
        } else if (g.phase === 'back') {
          const [ux, uy] = norm(p.x - g.x, p.y - g.y);
          g.x += ux * ITEMS.grapple.speed * 2 * dt;
          g.y += uy * ITEMS.grapple.speed * 2 * dt;
          if (len(p.x - g.x, p.y - g.y) < 60) g.done = true;
        } else {
          const d = len(g.x - p.x, g.y - p.y);
          const st = ITEMS.grapple.pull * dt;
          if (d <= st + 60) {
            delete p.mods.grappling;
            this.keepOnSide(p);
            g.done = true;
          } else {
            p.x += ((g.x - p.x) / d) * st;
            p.y += ((g.y - p.y) / d) * st;
            p.face = Math.atan2(g.y - p.y, g.x - p.x);
          }
        }
      }
      this.grapples = this.grapples.filter((g) => !g.done);
    }

    stepMines(dt) {
      for (const m of this.mines) {
        if (m.toss) {
          m.toss.t += dt;
          const k = Math.min(1, m.toss.t / m.toss.dur);
          m.x = m.toss.x0 + (m.toss.x1 - m.toss.x0) * k;
          m.y = m.toss.y0 + (m.toss.y1 - m.toss.y0) * k;
          if (k >= 1) delete m.toss;
          continue;
        }
        if (m.hooked) continue;
        if (m.armed > 0) { m.armed -= dt; continue; }
        // Goes off when an enemy Pudge comes within 300.
        if (this.alive().some((q) => q.team !== m.team && len(q.x - m.x, q.y - m.y) <= ITEMS.mine.radius)) {
          m.done = true;
          const owner = this.pawn(m.owner);
          this.fx({ e: 'mineBoom', x: m.x, y: m.y });
          for (const q of this.alive()) if (q.team !== m.team && len(q.x - m.x, q.y - m.y) <= ITEMS.mine.radius) this.damage(q, owner, lv(ITEMS.mine.damage, m.level), { pure: false });
        }
      }
      this.mines = this.mines.filter((m) => !m.done);
      // Strygwyr's Claw level 5: the bleeding goes on for 3 s after the drop.
      for (const p of this.alive()) {
        const b = p.mods.bleed;
        if (!b) continue;
        const moved = len(p.x - b.lx, p.y - b.ly);
        b.lx = p.x; b.ly = p.y;
        const owner = this.pawn(b.by);
        if (owner) this.rupture(p, owner, moved, 5, dt);
      }
    }

    // Pudges push each other apart (not while flying).
    collide() {
      const a = this.alive().filter((p) => !p.mods.hooked && !p.mods.tossed && !p.mods.grappling);
      for (let i = 0; i < a.length; i++) {
        for (let j = i + 1; j < a.length; j++) {
          const p = a[i];
          const q = a[j];
          const d = len(q.x - p.x, q.y - p.y);
          if (d >= 2 * RADIUS || d < 1e-6) continue;
          const push = (2 * RADIUS - d) / 2;
          const nx = (q.x - p.x) / d;
          const ny = (q.y - p.y) / d;
          p.x -= nx * push; p.y -= ny * push;
          q.x += nx * push; q.y += ny * push;
        }
      }
    }

    leave(id) {
      const p = this.pawn(id);
      if (!p) return;
      p.left = true;
      p.dead = true;
    }

    // ---------------------------------------------------------------- network
    snapshot() {
      const r1 = (v) => Math.round(v * 10) / 10;
      const r0 = Math.round;
      const snap = {
        t: r1(this.time), ph: this.phase, left: r1(Math.max(0, this.phaseLeft)), score: this.score, target: this.target,
        rune: r1(RUNE_EVERY - this.runeAcc),
        p: this.pawns.map((p) => ({
          id: p.id, tm: p.team, x: r1(p.x), y: r1(p.y), z: r0(p.z), f: Math.round(p.face * 100) / 100, hp: r0(p.hp), mx: this.maxHp(p),
          lv: p.level, xp: p.xp, nx: XP_TABLE[p.level] ?? null, px: XP_TABLE[p.level - 1] ?? 0, g: p.gold, k: p.kills, dd: p.deaths,
          d: p.dead ? 1 : 0, l: p.left ? 1 : 0, rs: p.dead ? Math.max(0, Math.ceil(p.respawnAt - this.time)) : 0,
          cast: p.casting && !p.casting.turning ? 1 : 0, cs: p.casting && !p.casting.turning ? p.casting.key : '',
          cp: p.casting && !p.casting.turning && p.casting.total ? r1(1 - p.casting.t / p.casting.total) : 0,
          mv: p.move || p.attack ? 1 : 0, at: p.attack && p.swing > 0 ? 1 : 0,
          m: Object.keys(p.mods).filter((k) => p.mods[k]),
          cd: { hook: r1(p.cd.hook || 0), cleaver: r1(p.cd.cleaver || 0) },
          it: p.items.map((it) => [it.key, it.level, r1(it.cd || 0)]),
          up: [p.up.damage, p.up.range, p.up.speed, p.up.radius], pts: p.points, dt: p.dmgTomes, ht: p.hpTomes,
          hk: p.hookOut ? 1 : 0,
        })),
        h: this.hooks.map((h) => [h.id, h.owner, r1(h.x), r1(h.y), h.radius, h.hooked ? h.hooked.id : 0, h.corners.map(([x, y]) => [r0(x), r0(y)]), h.fire ? 1 : 0, h.phase === 'out' ? 1 : 0]),
        c: this.cleavers.map((c) => [c.id, r1(c.x), r1(c.y), r1(c.vx), r1(c.vy)]),
        g: this.grapples.map((g) => [g.id, g.owner, r1(g.x), r1(g.y), g.phase]),
        mi: this.mines.map((m) => [m.id, m.team, r1(m.x), r1(m.y), m.armed > 0 ? 1 : 0]),
        b: this.barriers.map((b) => [b.id, b.team, r1(b.x), r1(b.y), b.r, r0(b.hp), b.mx]),
        r: this.runes.map((r) => [r.id, r.type, r1(r.x), r1(r.y)]),
        fx: this.effects,
      };
      this.effects = [];
      return snap;
    }
  }

  function mulberry(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PudgeWars = {
    Sim, TICK, HOOK, UPGRADES, UPGRADE_MAX, CLEAVER, ITEMS, RUNES, TEAM_NAMES, COLORS, XP_TABLE,
    WALL_X, WALL_Y, WALK_X, WALK_Y, RIVER, CENTER, RADIUS, RESPAWN, lv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PudgeWars;
  else root.PudgeWars = PudgeWars;
}(typeof window !== 'undefined' ? window : globalThis));
