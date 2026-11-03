'use strict';
// Tank (Танк тулаан): an original top-down tank game for two players.
//  - Co-op: both players defend their base against waves of enemy tanks,
//    50 levels (shared/tank-levels.js), each a little harder.
//  - Versus: each player defends their own base and attacks the other's;
//    neutral drones roam and attack whoever is closest, power-ups appear in
//    the middle, and players can build brick walls.
// The field is 26 x 26 blocks; a tank is 2 x 2 blocks. One PC (the host) runs
// this simulation and sends snapshots; the other sends its input.
(function init(root) {
  const L = typeof module !== 'undefined' && module.exports ? require('./tank-levels') : root.TankLevels;
  const { SIZE, TILE } = L;
  const TICK = 1 / 30;
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // up, right, down, left
  const KINDS = {
    player: { speed: 4.2, hp: 1, fire: 0.3, shot: 13, score: 0 },
    scout: { speed: 5.6, hp: 1, fire: 0.9, shot: 11, score: 100 },
    trooper: { speed: 3.4, hp: 1, fire: 1.3, shot: 17, score: 200 },
    heavy: { speed: 2.6, hp: 4, fire: 1.0, shot: 12, score: 400 },
    rocket: { speed: 3.0, hp: 2, fire: 0.55, shot: 9, score: 300, rocket: true },
    drone: { speed: 4.6, hp: 1, fire: 1.0, shot: 12, score: 100 },
  };
  const POWERS = ['shield', 'power', 'rapid', 'ricochet', 'freeze', 'fortify', 'airstrike', 'life'];
  const SOLID = new Set([TILE.BRICK, TILE.STEEL, TILE.WATER, TILE.BASE]);

  function mulberry(a) {
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Game {
    // players: [{ id, name }] (two); opts: { mode: 'coop' | 'versus', level (1 – 50), arena (0 – 2), seed, minutes }
    constructor(players, opts = {}) {
      this.mode = opts.mode === 'versus' ? 'versus' : 'coop';
      this.rand = mulberry(opts.seed || 1);
      this.players = players.slice(0, 2).map((p, i) => ({
        id: p.id, name: p.name, slot: i, lives: this.mode === 'coop' ? 3 : 99, score: 0, kills: {}, power: 0, rapid: false,
        tank: null, respawnAt: 0, input: { dir: -1, fire: false, build: false }, walls: 10, wallCd: 0, wallAcc: 0,
      }));
      this.minutes = Number(opts.minutes) || 5;
      this.arena = Math.max(0, Math.min(L.VERSUS.length - 1, Number(opts.arena) || 0));
      this.level = Math.max(1, Math.min(50, Number(opts.level) || 1));
      this.time = 0;
      this.nextId = 1;
      this.events = [];
      this.over = null;
      this.gridVersion = 0;
      this.loadLevel();
    }

    fx(e) { this.events.push(e); }
    takeEvents() { const e = this.events; this.events = []; return e; }

    // ---------------------------------------------------------------- level
    loadLevel() {
      const map = this.mode === 'coop' ? L.COOP[this.level - 1] : L.VERSUS[this.arena];
      const b = L.build(map, this.mode);
      this.grid = b.grid;
      this.pads = b.pads;
      this.bases = b.bases.map((x) => ({ ...x, alive: true, hp: this.mode === 'coop' ? 4 : 6, max: this.mode === 'coop' ? 4 : 6, hitAt: -9 }));
      this.gridVersion++;
      this.tanks = [];
      this.bullets = [];
      this.powerups = [];
      this.phase = 'play'; // play | clear | over
      this.phaseLeft = 0;
      this.levelTime = 0;
      this.freeze = 0;
      this.fortify = 0;
      this.spawnCd = 1;
      this.gate = 0;
      if (this.mode === 'coop') {
        const w = L.waveFor(this.level);
        this.wave = w;
        // The order the enemies come in, from the level's mix; every 7th carries a power-up.
        const kinds = [];
        for (let i = 0; i < w.count; i++) {
          let r = this.rand();
          let kind = 'trooper';
          for (const [k, p] of Object.entries(w.mix)) { if (r < p) { kind = k; break; } r -= p; }
          kinds.push({ kind, carrier: i % 7 === 3 });
        }
        this.queue = kinds;
        this.enemiesLeft = w.count;
      } else {
        this.queue = [];
        this.enemiesLeft = 0;
        this.droneCd = 15;
        this.powerCd = 12;
        this.endsAt = this.minutes * 60;
        this.sudden = false;
      }
      for (const p of this.players) {
        p.tank = null;
        if (p.lives > 0) this.spawnPlayer(p, 0.6);
      }
      this.fx({ e: 'level', level: this.level, mode: this.mode });
    }

    startOf(p) {
      if (this.mode === 'coop') return L.PLAYER_START[p.slot];
      return p.slot === 0 ? [4, 12] : [20, 12];
    }

    spawnPlayer(p, shield = 3) {
      const [x, y] = this.startOf(p);
      p.tank = this.addTank(p.slot === 0 ? 'player' : 'player', x, y, this.mode === 'coop' ? 0 : p.slot, { owner: p.id, dir: this.mode === 'coop' ? 0 : p.slot === 0 ? 1 : 3, shield, spawning: 0.6 });
      p.tank.slot = p.slot;
    }

    addTank(kind, x, y, team, extra = {}) {
      const k = KINDS[kind];
      const t = {
        id: this.nextId++, kind, team, x, y, dir: 2, moving: false, hp: k.hp, fireCd: 0.4, think: 0, shield: 0, spawning: 1,
        slide: 0, teleCd: 0, carrier: false, ricochet: 0, alive: true, ...extra,
      };
      this.tanks.push(t);
      return t;
    }

    // ---------------------------------------------------------------- input
    input(id, inp) {
      const p = this.players.find((q) => q.id === id);
      if (!p) return;
      if (inp.dir !== undefined) p.input.dir = [0, 1, 2, 3].includes(inp.dir) ? inp.dir : -1;
      if (inp.fire !== undefined) p.input.fire = !!inp.fire;
      if (inp.build) p.input.build = true;
    }

    // ---------------------------------------------------------------- step
    step() {
      const dt = TICK;
      this.time += dt;
      if (this.over) return;
      if (this.phase === 'clear') {
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) {
          if (this.level >= 50) { this.finish('won'); return; }
          this.level++;
          // A bonus life every 5 levels, and anyone out of lives comes back with one.
          for (const p of this.players) { if (this.level % 5 === 1) p.lives++; if (p.lives <= 0) p.lives = 1; }
          this.loadLevel();
        }
        return;
      }
      this.levelTime += dt;
      this.freeze = Math.max(0, this.freeze - dt);
      if (this.fortify > 0) {
        this.fortify -= dt;
        if (this.fortify <= 0) this.setBaseRing(TILE.BRICK);
      }
      // Players: respawn, input.
      for (const p of this.players) {
        if (!p.tank && p.respawnAt && this.time >= p.respawnAt && p.lives > 0) { p.respawnAt = 0; this.spawnPlayer(p); }
        if (this.mode === 'versus') {
          p.wallCd = Math.max(0, p.wallCd - dt);
          p.wallAcc += dt;
          if (p.wallAcc >= 10) { p.wallAcc = 0; p.walls = Math.min(10, p.walls + 1); }
          if (p.input.build && p.tank) this.build(p);
        }
        p.input.build = false;
      }
      if (this.mode === 'coop') this.spawnEnemies(dt);
      else this.versusExtras(dt);
      for (const t of this.tanks) this.stepTank(t, dt);
      this.stepBullets(dt);
      this.stepPowerups(dt);
      this.tanks = this.tanks.filter((t) => t.alive);
      this.checkEnd();
    }

    spawnEnemies(dt) {
      this.spawnCd -= dt;
      const enemies = this.tanks.filter((t) => t.team === 9);
      if (!this.queue.length || enemies.length >= this.wave.atOnce || this.spawnCd > 0) return;
      for (let k = 0; k < 3; k++) {
        const [x, y] = L.GATES[(this.gate + k) % 3];
        if (this.tanks.some((t) => overlap(t.x, t.y, 2, x, y, 2))) continue;
        this.gate = (this.gate + k + 1) % 3;
        const next = this.queue.shift();
        const t = this.addTank(next.kind, x, y, 9, { dir: 2, carrier: next.carrier, spawning: 1 });
        t.speedMul = this.wave.speed;
        this.spawnCd = Math.max(0.8, 2.2 - this.level * 0.025);
        this.fx({ e: 'spawn', id: t.id, x, y });
        return;
      }
    }

    versusExtras(dt) {
      this.endsAt -= dt;
      if (this.endsAt <= 0 && !this.sudden) {
        const [a, b] = this.players;
        if (a.score === b.score) { this.sudden = true; this.fx({ e: 'sudden' }); } else this.finish('time');
      }
      // Neutral drones from the top and bottom gates.
      this.droneCd -= dt;
      if (this.droneCd <= 0 && this.tanks.filter((t) => t.team === 8).length < 2) {
        const [x, y] = this.rand() < 0.5 ? [12, 0] : [12, 24];
        if (!this.tanks.some((t) => overlap(t.x, t.y, 2, x, y, 2))) {
          const t = this.addTank('drone', x, y, 8, { dir: y === 0 ? 2 : 0, carrier: true, spawning: 1 });
          this.fx({ e: 'spawn', id: t.id, x, y });
          this.droneCd = 20;
        }
      }
      // Power-ups in the middle every so often.
      this.powerCd -= dt;
      if (this.powerCd <= 0) { this.powerCd = 18; this.dropPowerup(true); }
    }

    // ---------------------------------------------------------------- tanks
    stepTank(t, dt) {
      if (!t.alive) return;
      t.fireCd -= dt;
      t.shield = Math.max(0, t.shield - dt);
      t.ricochet = Math.max(0, t.ricochet - dt);
      t.teleCd = Math.max(0, t.teleCd - dt);
      if (t.spawning > 0) { t.spawning -= dt; return; }
      let want = -1;
      let fire = false;
      if (t.owner) {
        const p = this.players.find((q) => q.id === t.owner);
        want = p.input.dir;
        fire = p.input.fire;
      } else {
        if ((t.team === 9 && this.freeze > 0)) { t.moving = false; return; }
        ({ want, fire } = this.think(t, dt));
      }
      const k = KINDS[t.kind];
      const onIce = this.onIce(t);
      if (want >= 0) {
        if (want !== t.dir) {
          // Turning onto the other axis snaps to the block grid, so corridors are easy to enter.
          if ((want % 2) !== (t.dir % 2)) { if (want % 2 === 0) t.x = Math.round(t.x); else t.y = Math.round(t.y); }
          t.dir = want;
        }
        t.slide = onIce ? 0.35 : 0;
        this.move(t, k.speed * (t.speedMul || 1) * dt);
        t.moving = true;
      } else if (t.slide > 0) {
        t.slide -= dt;
        this.move(t, k.speed * dt * 0.8);
        t.moving = true;
      } else t.moving = false;
      if (fire) this.fire(t);
      this.teleport(t);
    }

    onIce(t) {
      const cx = Math.floor(t.x + 1);
      const cy = Math.floor(t.y + 1);
      return this.grid[cy] && this.grid[cy][cx] === TILE.ICE;
    }

    blockedAt(x, y, self) {
      if (x < 0 || y < 0 || x > SIZE - 2 || y > SIZE - 2) return true;
      for (let j = Math.floor(y + 1e-6); j < Math.ceil(y + 2 - 1e-6); j++) {
        for (let i = Math.floor(x + 1e-6); i < Math.ceil(x + 2 - 1e-6); i++) if (SOLID.has(this.grid[j][i])) return true;
      }
      for (const o of this.tanks) {
        if (o === self || !o.alive) continue;
        // Tanks already overlapping (a spawn) may separate.
        if (overlap(o.x, o.y, 2, x, y, 2) && !overlap(o.x, o.y, 2, self.x, self.y, 2)) return true;
      }
      return false;
    }

    move(t, dist) {
      const [dx, dy] = DIRS[t.dir];
      const steps = Math.ceil(dist / 0.1);
      for (let s = 0; s < steps; s++) {
        const d = Math.min(0.1, dist - s * 0.1);
        const nx = t.x + dx * d;
        const ny = t.y + dy * d;
        if (this.blockedAt(nx, ny, t)) { t.bumped = true; return false; }
        t.x = nx;
        t.y = ny;
      }
      t.bumped = false;
      return true;
    }

    teleport(t) {
      if (t.teleCd > 0) return;
      for (const pad of this.pads) {
        for (const [from, to] of [[pad.a, pad.b], [pad.b, pad.a]]) {
          if (Math.abs(t.x - from[0]) < 0.4 && Math.abs(t.y - from[1]) < 0.4 && !this.tanks.some((o) => o !== t && overlap(o.x, o.y, 2, to[0], to[1], 2))) {
            this.fx({ e: 'tele', x: t.x, y: t.y, x2: to[0], y2: to[1] });
            t.x = to[0];
            t.y = to[1];
            t.teleCd = 1.2;
            return;
          }
        }
      }
    }

    // Enemy and drone brains: wander, head for a target, shoot.
    think(t, dt) {
      t.think -= dt;
      const k = KINDS[t.kind];
      const fireRate = k.fire * (this.wave ? this.wave.fire : 1);
      let fire = this.rand() < fireRate * dt;
      // Aim: a player or the base straight ahead makes them shoot.
      const target = this.targetFor(t);
      if (target) {
        const cx = t.x + 1;
        const cy = t.y + 1;
        const [dx, dy] = DIRS[t.dir];
        const along = (target.x - cx) * dx + (target.y - cy) * dy;
        const across = Math.abs((target.x - cx) * dy) + Math.abs((target.y - cy) * dx);
        if (along > 0 && across < 1.2 && this.rand() < 2.2 * fireRate * dt) fire = true;
      }
      if (t.think <= 0 || t.bumped) {
        t.think = 0.5 + this.rand() * 1.4;
        const chase = target && this.rand() < (t.kind === 'scout' ? 0.35 : t.kind === 'heavy' ? 0.65 : 0.5);
        if (chase) {
          const ddx = target.x - (t.x + 1);
          const ddy = target.y - (t.y + 1);
          t.dir = Math.abs(ddx) > Math.abs(ddy) && this.rand() < 0.7 ? (ddx > 0 ? 1 : 3) : (ddy > 0 ? 2 : 0);
        } else {
          // Mostly downwards for enemies (towards the base), otherwise any way.
          const r = this.rand();
          t.dir = t.team === 9 ? (r < 0.4 ? 2 : r < 0.6 ? 1 : r < 0.8 ? 3 : 0) : Math.floor(r * 4);
        }
        if (t.bumped && this.rand() < 0.5) fire = true; // shoot the wall in the way
      }
      return { want: t.dir, fire };
    }

    targetFor(t) {
      const players = this.players.map((p) => p.tank).filter((x) => x && x.alive);
      if (t.team === 9) {
        const base = this.bases[0];
        // Heavies and rockets are after the base more often than the players.
        if (!players.length || ((t.kind === 'heavy' || t.kind === 'rocket') && t.id % 3 !== 0)) return { x: base.x + 1, y: base.y + 1 };
        const p = nearest(t, players);
        return p ? { x: p.x + 1, y: p.y + 1 } : { x: base.x + 1, y: base.y + 1 };
      }
      const p = nearest(t, players);
      return p ? { x: p.x + 1, y: p.y + 1 } : null;
    }

    fire(t) {
      if (t.fireCd > 0) return;
      const k = KINDS[t.kind];
      const p = t.owner ? this.players.find((q) => q.id === t.owner) : null;
      const power = p ? p.power : t.kind === 'heavy' ? 1 : 0;
      const max = p && p.power >= 2 ? 2 : 1;
      if (this.bullets.filter((b) => b.tank === t.id).length >= max) return;
      t.fireCd = (p && p.rapid ? k.fire * 0.5 : k.fire) * (p ? 1 : 1 + this.rand());
      const [dx, dy] = DIRS[t.dir];
      const b = {
        id: this.nextId++, tank: t.id, team: t.team, owner: t.owner || null, x: t.x + 1 + dx * 1.1, y: t.y + 1 + dy * 1.1, dir: t.dir,
        speed: k.shot + (power >= 1 ? 6 : 0), power, rocket: !!k.rocket, bounces: t.ricochet > 0 ? 1 : 0,
      };
      this.bullets.push(b);
      this.fx({ e: 'fire', id: t.id, kind: t.kind, x: b.x, y: b.y, dir: t.dir });
    }

    // ---------------------------------------------------------------- bullets
    stepBullets(dt) {
      for (const b of this.bullets) {
        if (b.dead) continue;
        const dist = b.speed * dt;
        const steps = Math.ceil(dist / 0.2);
        for (let s = 0; s < steps && !b.dead; s++) {
          const [dx, dy] = DIRS[b.dir];
          b.x += dx * 0.2;
          b.y += dy * 0.2;
          this.bulletHit(b);
        }
      }
      // Shells from opposite sides cancel each other out.
      for (let i = 0; i < this.bullets.length; i++) {
        const a = this.bullets[i];
        if (a.dead) continue;
        for (let j = i + 1; j < this.bullets.length; j++) {
          const c = this.bullets[j];
          if (c.dead || c.team === a.team) continue;
          if (Math.abs(a.x - c.x) < 0.5 && Math.abs(a.y - c.y) < 0.5) { a.dead = c.dead = true; this.fx({ e: 'clash', x: a.x, y: a.y }); }
        }
      }
      this.bullets = this.bullets.filter((b) => !b.dead);
    }

    bulletHit(b) {
      // The edge of the field.
      if (b.x < 0 || b.y < 0 || b.x > SIZE || b.y > SIZE) {
        if (b.bounces > 0) { b.bounces--; b.dir = (b.dir + 2) % 4; b.x = clamp(b.x, 0.1, SIZE - 0.1); b.y = clamp(b.y, 0.1, SIZE - 0.1); this.fx({ e: 'bounce', x: b.x, y: b.y }); return; }
        b.dead = true;
        this.fx({ e: 'wall', x: clamp(b.x, 0, SIZE), y: clamp(b.y, 0, SIZE), steel: true });
        return;
      }
      // Tanks.
      for (const t of this.tanks) {
        if (!t.alive || t.id === b.tank || t.spawning > 0) continue;
        if (!(b.x > t.x && b.x < t.x + 2 && b.y > t.y && b.y < t.y + 2)) continue;
        if (this.mode === 'coop' && t.team === b.team) continue; // no friendly fire in co-op
        if (t.team === 8 && b.team === 8) continue;
        b.dead = true;
        if (b.rocket) { this.explode(b); return; }
        this.hitTank(t, b);
        return;
      }
      // The blocks under the shell's front: the one it is in and its neighbour across.
      const [dx, dy] = DIRS[b.dir];
      const cells = [];
      const fx = Math.floor(b.x - (dx < 0 ? 0.001 : 0));
      const fy = Math.floor(b.y - (dy < 0 ? 0.001 : 0));
      if (dx !== 0) { cells.push([fx, Math.floor(b.y - 0.5)], [fx, Math.floor(b.y)]); } else { cells.push([Math.floor(b.x - 0.5), fy], [Math.floor(b.x), fy]); }
      let hit = false;
      let steel = false;
      for (const [cx, cy] of cells) {
        if (cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE) continue;
        const v = this.grid[cy][cx];
        if (v === TILE.BRICK) { this.grid[cy][cx] = TILE.EMPTY; hit = true; }
        else if (v === TILE.STEEL) { if (b.power >= 3) { this.grid[cy][cx] = TILE.EMPTY; hit = true; } else steel = true; }
        else if (v === TILE.BASE) { this.destroyBase(cx, cy, b); hit = true; }
      }
      if (hit || steel) {
        if (hit) this.gridVersion++;
        if (b.rocket) { b.dead = true; this.explode(b); return; }
        if (steel && !hit && b.bounces > 0) { b.bounces--; b.dir = (b.dir + 2) % 4; this.fx({ e: 'bounce', x: b.x, y: b.y }); return; }
        b.dead = true;
        this.fx({ e: 'wall', x: b.x, y: b.y, steel: steel && !hit });
      }
    }

    // Rocket shells blow a hole: bricks within 1.5 blocks, and tanks nearby.
    explode(b) {
      for (let j = Math.floor(b.y - 2); j <= Math.floor(b.y + 2); j++) {
        for (let i = Math.floor(b.x - 2); i <= Math.floor(b.x + 2); i++) {
          if (i < 0 || j < 0 || i >= SIZE || j >= SIZE) continue;
          if (Math.hypot(i + 0.5 - b.x, j + 0.5 - b.y) > 1.6) continue;
          if (this.grid[j][i] === TILE.BRICK) this.grid[j][i] = TILE.EMPTY;
          if (this.grid[j][i] === TILE.BASE) this.destroyBase(i, j, b);
        }
      }
      this.gridVersion++;
      for (const t of this.tanks) {
        if (!t.alive || t.spawning > 0 || t.team === b.team) continue;
        if (Math.hypot(t.x + 1 - b.x, t.y + 1 - b.y) < 2) this.hitTank(t, b);
      }
      this.fx({ e: 'boom', x: b.x, y: b.y, big: true });
    }

    hitTank(t, b) {
      if (t.shield > 0) { this.fx({ e: 'shieldHit', id: t.id, x: b.x, y: b.y }); return; }
      if (t.carrier && t.team !== 0 && t.team !== 1) { t.carrier = false; this.dropPowerup(false); }
      t.hp--;
      if (t.hp > 0) { this.fx({ e: 'armor', id: t.id, x: b.x, y: b.y, hp: t.hp }); return; }
      this.killTank(t, b.owner);
    }

    killTank(t, by) {
      t.alive = false;
      this.fx({ e: 'boom', x: t.x + 1, y: t.y + 1, id: t.id, kind: t.kind });
      const killer = by ? this.players.find((p) => p.id === by) : null;
      if (t.owner) {
        const p = this.players.find((q) => q.id === t.owner);
        p.tank = null;
        p.power = 0;
        p.rapid = false;
        if (this.mode === 'coop') p.lives--;
        if (p.lives > 0) p.respawnAt = this.time + (this.mode === 'coop' ? 2 : 3);
        if (this.mode === 'versus' && killer && killer !== p) {
          killer.score++;
          if (this.sudden) this.finish('sudden', killer.id);
        }
        return;
      }
      if (t.team === 9) this.enemiesLeft--;
      if (killer) {
        killer.kills[t.kind] = (killer.kills[t.kind] || 0) + 1;
        if (this.mode === 'coop') killer.score += KINDS[t.kind].score;
      }
    }

    destroyBase(cx, cy, b) {
      const base = this.bases.find((x) => cx >= x.x && cx < x.x + 2 && cy >= x.y && cy < x.y + 2);
      if (!base || !base.alive) return;
      // Your own shells never hurt your own base; it takes a few hits to fall.
      if (b.team === base.team) return;
      if (this.time - base.hitAt < 0.15) return; // one rocket blast counts once
      base.hitAt = this.time;
      base.hp--;
      if (base.hp > 0) { this.fx({ e: 'baseHit', x: base.x + 1, y: base.y + 1, team: base.team, hp: base.hp }); return; }
      base.alive = false;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) this.grid[base.y + dy][base.x + dx] = TILE.EMPTY;
      this.gridVersion++;
      this.fx({ e: 'baseDown', x: base.x + 1, y: base.y + 1, team: base.team });
      if (this.mode === 'coop') this.finish('base');
      else {
        const winner = this.players.find((p) => p.slot !== base.team);
        this.finish('base', winner && winner.id);
      }
    }

    // Fortify: the base's ring turns to steel for a while.
    setBaseRing(v) {
      if (this.mode !== 'coop') return;
      for (let i = 11; i <= 14; i++) this.grid[23][i] = v;
      for (const y of [24, 25]) { this.grid[y][11] = v; this.grid[y][14] = v; }
      this.gridVersion++;
    }

    // ---------------------------------------------------------------- power-ups
    dropPowerup(center) {
      for (let k = 0; k < 40; k++) {
        const x = center ? 9 + Math.floor(this.rand() * 7) : 1 + Math.floor(this.rand() * 22);
        const y = center ? 9 + Math.floor(this.rand() * 7) : 2 + Math.floor(this.rand() * 18);
        const free = [0, 1].every((dy) => [0, 1].every((dx) => this.grid[y + dy][x + dx] !== TILE.WATER && this.grid[y + dy][x + dx] !== TILE.BASE));
        if (!free) continue;
        let types = POWERS;
        if (this.mode === 'versus') types = POWERS.filter((p) => !['fortify', 'airstrike', 'life', 'freeze'].includes(p)).concat(['freeze']);
        const type = types[Math.floor(this.rand() * types.length)];
        this.powerups.push({ id: this.nextId++, type, x, y, left: 15 });
        this.fx({ e: 'powerup', type, x, y });
        return;
      }
    }

    stepPowerups(dt) {
      for (const pu of this.powerups) {
        pu.left -= dt;
        for (const p of this.players) {
          const t = p.tank;
          if (!t || !t.alive || !overlap(t.x, t.y, 2, pu.x, pu.y, 2)) continue;
          pu.left = 0;
          this.applyPower(p, pu.type);
          break;
        }
      }
      this.powerups = this.powerups.filter((pu) => pu.left > 0);
    }

    applyPower(p, type) {
      const t = p.tank;
      this.fx({ e: 'got', type, id: t.id, slot: p.slot });
      if (type === 'shield') t.shield = 10;
      else if (type === 'power') p.power = Math.min(3, p.power + 1);
      else if (type === 'rapid') p.rapid = true;
      else if (type === 'ricochet') t.ricochet = 15;
      else if (type === 'life') p.lives++;
      else if (type === 'freeze') {
        if (this.mode === 'coop') this.freeze = 8;
        else { const other = this.players.find((q) => q !== p); if (other && other.tank) other.tank.spawning = 3; }
      } else if (type === 'fortify') { this.fortify = 15; this.setBaseRing(TILE.STEEL); }
      else if (type === 'airstrike') {
        for (const e of this.tanks) if (e.alive && e.team === 9 && e.spawning <= 0) this.killTank(e, p.id);
        this.fx({ e: 'airstrike' });
      }
    }

    // Versus: put a brick wall in front of your tank.
    build(p) {
      const t = p.tank;
      if (p.wallCd > 0 || p.walls <= 0) return;
      const [dx, dy] = DIRS[t.dir];
      const x = Math.round(t.x + dx * 2);
      const y = Math.round(t.y + dy * 2);
      if (x < 0 || y < 0 || x > SIZE - 2 || y > SIZE - 2) return;
      for (let j = y; j < y + 2; j++) for (let i = x; i < x + 2; i++) if (this.grid[j][i] !== TILE.EMPTY && this.grid[j][i] !== TILE.BUSH) return;
      if (this.tanks.some((o) => o.alive && overlap(o.x, o.y, 2, x, y, 2))) return;
      for (let j = y; j < y + 2; j++) for (let i = x; i < x + 2; i++) this.grid[j][i] = TILE.BRICK;
      p.walls--;
      p.wallCd = 1.5;
      this.gridVersion++;
      this.fx({ e: 'build', x, y });
    }

    // ---------------------------------------------------------------- end
    checkEnd() {
      if (this.over || this.phase !== 'play') return;
      if (this.mode === 'coop') {
        if (this.players.every((p) => p.lives <= 0 && !p.tank)) { this.finish('lives'); return; }
        if (this.enemiesLeft <= 0 && !this.queue.length) {
          this.phase = 'clear';
          this.phaseLeft = 5;
          this.fx({ e: 'clear', level: this.level });
        }
      }
    }

    finish(reason, winner = null) {
      if (this.over) return;
      this.phase = 'over';
      if (this.mode === 'versus' && !winner) {
        const [a, b] = this.players;
        winner = a.score === b.score ? null : (a.score > b.score ? a : b).id;
      }
      this.over = { reason, winner, level: this.level };
      this.fx({ e: 'over', reason, winner });
    }

    leave(id) {
      if (this.over) return;
      const other = this.players.find((p) => p.id !== id);
      this.finish('left', this.mode === 'versus' && other ? other.id : null);
    }

    // ---------------------------------------------------------------- network
    snapshot(withGrid) {
      const r2 = (v) => Math.round(v * 100) / 100;
      return {
        t: r2(this.time), mode: this.mode, level: this.level, phase: this.phase, left: r2(this.phaseLeft), gv: this.gridVersion,
        grid: withGrid ? this.grid.map((row) => row.join('')).join('') : undefined,
        pads: this.pads, bases: this.bases.map((b) => [b.x, b.y, b.team, b.alive ? 1 : 0, b.hp, b.max]),
        tk: this.tanks.map((t) => [t.id, t.kind, t.team, r2(t.x), r2(t.y), t.dir, t.moving ? 1 : 0, t.hp, t.shield > 0 ? 1 : 0, t.spawning > 0 ? 1 : 0, t.carrier ? 1 : 0, t.slot ?? -1, t.ricochet > 0 ? 1 : 0]),
        bl: this.bullets.map((b) => [b.id, r2(b.x), r2(b.y), b.dir, b.rocket ? 1 : 0, b.team]),
        pu: this.powerups.map((p) => [p.id, p.type, p.x, p.y, Math.round(p.left)]),
        pl: this.players.map((p) => ({ id: p.id, slot: p.slot, lives: p.lives, score: p.score, power: p.power, rapid: p.rapid, kills: p.kills, walls: p.walls, alive: !!p.tank, respawn: p.respawnAt ? Math.max(0, Math.ceil(p.respawnAt - this.time)) : 0 })),
        enemies: this.enemiesLeft, queue: this.queue.length, freeze: r2(this.freeze), fortify: r2(this.fortify),
        ends: this.mode === 'versus' ? Math.max(0, Math.ceil(this.endsAt)) : 0, sudden: !!this.sudden,
        over: this.over, fx: this.takeEvents(),
      };
    }
  }

  function overlap(ax, ay, as, bx, by, bs) {
    return ax < bx + bs - 1e-6 && ax + as > bx + 1e-6 && ay < by + bs - 1e-6 && ay + as > by + 1e-6;
  }
  function nearest(t, list) {
    let best = null;
    let bd = Infinity;
    for (const o of list) {
      const d = Math.hypot(o.x - t.x, o.y - t.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const Tanks = { Game, TICK, DIRS, KINDS, POWERS, SIZE, TILE };
  if (typeof module !== 'undefined' && module.exports) module.exports = Tanks;
  else root.Tanks = Tanks;
}(typeof window !== 'undefined' ? window : globalThis));
