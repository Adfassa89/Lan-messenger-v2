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
  // Game modes (base/mode.lua): Rounds = last team standing scores; Deathmatch
  // = 60 s rounds, respawn after 10 s, 1 score per kill, shop always open.
  const DM_ROUND_TIME = 60;
  const DM_RESPAWN = 10;
  const TEAM_COLORS = ['#e8443a', '#3a7be8', '#2fbf71', '#f2c230', '#a35ce8', '#f2862e', '#2fc6c9', '#e85ca8', '#9aa13a', '#8a8f99'];
  const CAST_POINT = 0.2;
  // Dota 2 turning. Warlock Brawl's hero has MovementTurnRate 1.2
  // (npc_heroes_custom.txt), twice Dota's own Warlock (0.6, 180 degrees in
  // 0.175 s), so 180 degrees take about 0.0875 s. A hero only starts walking
  // or casting once it faces within 11.5 degrees.
  const TURN_SPEED = Math.PI / 0.0875;
  const FACE_TOLERANCE = (11.5 * Math.PI) / 180;
  // Spells without a direction are used on the spot, without turning.
  const NO_TURN = new Set(['scourge', 'windwalk', 'shield', 'rush', 'alteration', 'splitter', 'pact']); // Splitter: IGNORE_TURN
  const COLORS = ['#e8443a', '#3a7be8', '#2fbf71', '#f2c230', '#a35ce8', '#f2862e', '#2fc6c9', '#e85ca8', '#9aa13a', '#8a8f99'];

  const lv = (arr, level) => arr[Math.min(arr.length, Math.max(1, level)) - 1];
  const steps = (a, step, n = 7) => Array.from({ length: n }, (_, i) => +(a + step * i).toFixed(2));

  // ------------------------------------------------------------------ spells
  // slot 0 = Fireball (Q), 1..6 = spell columns (W E R D F G), 7 = Scourge (X).
  const SPELLS = {
    fireball: { name: 'Fireball', icon: '🔥', col: 0, cd: [4.8], dmg: steps(70, 7), range: 1000, speed: 1000, radius: 25, cast: CAST_POINT, buy: 7, up: [7, 7, 7, 7, 7, 7] },
    scourge: { name: 'Scourge', icon: '💢', col: 7, cd: [3.0], dmg: [100, 110, 120], radius: 250, cast: 0.9, buy: 7, up: [7, 7], max: 3 },
    lightning: { name: 'Lightning', icon: '⚡', col: 1, cd: [16.5, 15.5, 15, 14.5, 14, 13.5, 13], dmg: steps(70, 8), range: 600, kb: 0.92, cast: CAST_POINT, buy: 11, up: [8, 9, 10, 11, 12, 13] },
    homing: { name: 'Homing', icon: '🔮', col: 1, cd: [16.5, 14.5, 13, 12, 11, 10, 9], dmg: steps(70, 10), speed: 1000, radius: 30, life: 4.5, explode: 200 * 1.46, cast: CAST_POINT, buy: 11, up: [8, 9, 10, 11, 12, 13] },
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
    // Added from Warlock Brawl's npc_abilities_custom.txt and spell scripts.
    twin: { name: 'Twin', col: 1, cd: [16, 13.9, 12.5, 11.7, 11, 10.3, 9.6], dmg: [44, 48, 52, 56, 62, 66, 72], range: 800, speed: 1000, radius: 35, area: 450 * 450, cast: CAST_POINT, buy: 12, up: [7, 8, 9, 10, 11, 12] },
    drain: { name: 'Drain', col: 3, cd: [22, 21, 20, 19, 18, 17, 16], dmg: steps(60, 10), duration: [4, 5, 6, 7, 8, 9, 10], speed: 700, turnSpeed: 600, radius: 24.5, range: 850, extra: 1.2, cast: CAST_POINT, buy: 14, up: [6, 7, 8, 9, 10, 11] },
    recharge: { name: 'Recharge', col: 3, cd: [23.5, 22, 21, 20.5, 20, 19.5, 19], dmg: steps(60, 7), perHit: 10, radius: 35, speed: 900, life: 1, cast: CAST_POINT, buy: 13, up: [6, 7, 8, 9, 10, 11] },
    splitter: { name: 'Splitter', col: 4, cd: [24, 23, 22, 21, 20, 19, 18], dmg: steps(30, 5), radius: 50, speed: 700, life: 1, cast: 0, buy: 15, up: [7, 8, 9, 10, 11, 12] },
    snowball: { name: 'Snowball', col: 4, cd: [19, 18, 17, 16, 15, 14, 13], dmg: steps(30, 5), dmgMax: steps(45, 15), range: 575, blast: 200, radius: [75, 77, 79, 81, 83, 85, 87], speed: 400, cast: CAST_POINT, buy: 14, up: [6, 7, 8, 9, 10, 11] },
    alteration: { name: 'Alteration', col: 5, cd: [19, 17.5, 16, 14.5, 13, 11.5, 10], duration: 2, radius: 120, cast: 0, buy: 11, up: [5, 6, 7, 8, 9, 10] },
    grip: { name: 'Grip', col: 6, cd: [24, 20, 17, 15, 13, 12, 10.5], duration: [4.5, 4.75, 5, 5.25, 5.5, 5.75, 6], dpGain: 5, radius: 39, speed: 1000, life: 1.1, cast: CAST_POINT, buy: 12, up: [6, 7, 8, 9, 10, 11] },
    warpzone: { name: 'Warpzone', col: 6, cd: [23, 21, 20, 19, 18, 17, 16], duration: 4.5, scale: [0.4, 0.36, 0.32, 0.28, 0.24, 0.2, 0.16], radius: steps(200, 10), range: 700, cast: CAST_POINT, buy: 12, up: [6, 7, 8, 9, 10, 11] },
    magnetize: { name: 'Magnetize', col: 6, cd: [22, 21, 20, 19, 18, 17, 16], duration: steps(3.5, 0.5), radius: 36, speed: 800, life: 1.2, cast: CAST_POINT, buy: 14, up: [5, 6, 7, 8, 9, 10] },
    rockpillar: { name: 'Rockpillar', col: 6, cd: [26, 24, 22, 20, 18, 16, 14], duration: 4, range: steps(650, 75), pillar: 90, cast: CAST_POINT, buy: 13, up: [5, 6, 7, 8, 9, 10] },
    // Usable items (npc_items_custom.txt): cast from item slots like Fireball and Scourge.
    redirector: { name: 'Redirector', col: 8, cd: [24], cast: CAST_POINT, penalty: 0.3, penaltyTime: 8 },
    pact: { name: 'Pact', col: 9, cd: [30], cast: CAST_POINT, duration: 5, mul: 1.5, slow: 66, slowTime: 6 },
    link: { name: 'Link', icon: '⛓️', col: 6, cd: [17, 15, 13, 11, 9, 7, 7], dmg: steps(12, 8), range: 860, speed: 950, radius: 35, pull: 1550, hold: 2.5, cast: CAST_POINT, buy: 12, up: [6, 7, 8, 9, 10, 11] },
  };
  const COLUMN_SPELLS = [[], ['boomerang', 'lightning', 'homing', 'twin'], ['teleport', 'thrust', 'swap'], ['cluster', 'drain', 'bouncer', 'recharge'], ['windwalk', 'meteor', 'splitter', 'snowball'], ['shield', 'rush', 'alteration'], ['gravity', 'grip', 'warpzone', 'magnetize', 'rockpillar', 'link']];
  // Obstacles (base/obstacles.lua): 2 – 8 per round within ±1000 of the
  // centre, one of three styles per round, 400 HP, bounce with elasticity 0.5,
  // explode for 5 – 10 damage within 300 when destroyed.
  const OBSTACLE_STYLES = [[60, 60, 60, 60, 60], [70, 45, 60, 40], [50, 50, 35, 35, 50]]; // radius per variant
  const OBSTACLE_HP = 400;
  const ELASTIC = 0.5;
  const ITEMS = {
    ring: { name: 'Ring of Health', icon: '💍', buy: 4, max: 5, hp: [100, 190, 270, 340, 400] },
    cape: { name: 'Cape', icon: '🧥', buy: 3, max: 3, regen: [1.5, 2.5, 3.5] },
    armor: { name: 'Armor', icon: '🦺', buy: 6, max: 3, kbRed: [0.12, 0.18, 0.22] },
    boots: { name: 'Boots', icon: '👢', buy: 5, max: 3, speed: [18, 29, 40] },
    cursed: { name: 'Cursed Ring', buy: 4, max: 2, hp: [100, 200], kbRed: 0.15, debuff: [0.25, 0.3] },
    watch: { name: 'Pocket Watch', buy: 2, max: 2, debuff: [-0.35, -0.45] },
    redirector: { name: 'Redirector', buy: 8, max: 1, slot: 8 },
    pact: { name: 'Pact', buy: 10, max: 1, slot: 9 },
  };

  // Masteries (shop.lua): Duration, Range, Lifesteal; 6 levels each, 5 gold a
  // level or 13 for one level of all three.
  const MASTERY = {
    names: ['Duration', 'Range', 'Lifesteal'],
    gain: [[0.10, 0.08, 0.07, 0.06, 0.05, 0.04], [0.12, 0.10, 0.09, 0.08, 0.07, 0.06], [0.09, 0.08, 0.07, 0.06, 0.05, 0.04]],
    cost: 5,
    allCost: 13,
    max: 6,
  };
  // Spells whose damage Pact boosts (they have a damage value).
  const DAMAGE_SPELLS = new Set(['fireball', 'scourge', 'lightning', 'homing', 'boomerang', 'thrust', 'cluster', 'bouncer', 'meteor', 'windwalk', 'twin', 'drain', 'recharge', 'splitter', 'snowball', 'link']);

  // ------------------------------------------------------------------ helpers
  const len = (x, y) => Math.hypot(x, y);
  function norm(x, y) {
    const l = Math.hypot(x, y);
    return l > 1e-6 ? [x / l, y / l] : [1, 0];
  }

  class Sim {
    // players: [{ id, name }]; options: { rounds }
    // options: mode 'rounds' | 'dm'; teams 'shuffle' | 'ffa' | 'lobby' (with
    // lobbyTeams { id: team }); win 'rounds' | 'score' with target (default 11).
    constructor(players, { rounds = 11, seed = 1, mode = 'rounds', teams = 'shuffle', win = 'rounds', target, lobbyTeams = {} } = {}) {
      this.mode = mode === 'dm' ? 'dm' : 'rounds';
      this.teamMode = ['shuffle', 'ffa', 'lobby'].includes(teams) ? teams : 'shuffle';
      this.win = win === 'score' ? 'score' : 'rounds';
      this.target = target || rounds;
      this.rounds = this.win === 'rounds' ? this.target : 0;
      this.lobbyTeams = lobbyTeams;
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
        move: null, cd: {}, casting: null, mods: {}, lastHit: null, team: i, respawnAt: 0, mastery: [0, 0, 0],
      }));
      this.obstacles = [];
      this.zones = []; // warp zones
      this.obstacleStyle = 0;
      this.layer = 0;
      this.lavaAcc = 0;
      this.shrinkAcc = 0;
    }

    pawn(id) { return this.pawns.find((p) => p.id === id); }
    // Same warlock or same team: spells pass through allies.
    ally(a, b) {
      if (a === b) return true;
      const p = this.pawn(a);
      const q = this.pawn(b);
      return !!(p && q && p.team === q.team);
    }
    teamCount() { return new Set(this.pawns.filter((p) => !p.left).map((p) => p.team)).size; }

    // Teams for the coming round (base/teammode.lua).
    assignTeams() {
      const active = this.pawns.filter((p) => !p.left);
      if (this.teamMode === 'ffa') { active.forEach((p, i) => { p.team = i; }); return; }
      if (this.teamMode === 'lobby') { active.forEach((p, i) => { p.team = Number.isInteger(this.lobbyTeams[p.id]) ? this.lobbyTeams[p.id] : i; }); return; }
      // Shuffle: a random team count that divides the players evenly (not one per player
      // unless there is no other way), players shuffled into them.
      const n = active.length;
      const counts = [];
      for (let i = 2; i <= n; i++) if (n % i === 0) counts.push(i);
      if (!counts.length) counts.push(1);
      const teamCount = counts.length > 1 ? counts[Math.floor(this.rand() * (counts.length - 1))] : counts[0];
      const order = active.slice();
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      order.forEach((p, i) => { p.team = i % teamCount; });
    }

    // Spawn spots: teams spread around the ring, team mates side by side.
    spawnSpot(p) {
      const teams = [...new Set(this.pawns.filter((q) => !q.left).map((q) => q.team))].sort((a, b) => a - b);
      const ti = Math.max(0, teams.indexOf(p.team));
      const mates = this.pawns.filter((q) => !q.left && q.team === p.team);
      const mi = mates.indexOf(p);
      const a = ((2 * Math.PI) / teams.length) * ti + 0.2 * (mi - (mates.length - 1) / 2);
      const r = (13 + this.pawns.length) * 100 - 600;
      return [r * Math.cos(a), r * Math.sin(a)];
    }
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
      this.zones = [];
      this.placeObstacles();
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
      this.zones = [];
      this.obstacles = this.obstacles.filter((o) => !o.temp);
      this.assignTeams();
      if (this.mode === 'dm') this.phaseLeft = DM_ROUND_TIME;
      for (const p of this.pawns.filter((q) => !q.left)) this.spawnAt(p);
      this.fx({ e: 'fight', round: this.round });
    }

    spawnAt(p) {
      this.respawn(p, false);
      [p.x, p.y] = this.spawnSpot(p);
      p.face = Math.atan2(-p.y, -p.x);
      p.mods.spawnShield = ROUND_START_SHIELD;
      p.respawnAt = 0;
    }

    // Deathmatch: a new 60 s round without a shop break (the shop stays open):
    // new teams, a full platform with new obstacles; living warlocks stay put.
    nextDmRound() {
      this.round++;
      this.phaseLeft = DM_ROUND_TIME;
      this.layer = 13 + this.pawns.length;
      this.shrinkAcc = 0;
      this.zones = [];
      this.placeObstacles();
      this.assignTeams();
      this.fx({ e: 'fight', round: this.round, dm: 1 });
    }

    gameOver() {
      if (this.win === 'rounds') return this.round >= this.target;
      return this.pawns.some((p) => p.score >= this.target);
    }

    // A new random set of obstacles in one style for the coming round.
    placeObstacles() {
      this.obstacleStyle = Math.floor(this.rand() * OBSTACLE_STYLES.length);
      const sizes = OBSTACLE_STYLES[this.obstacleStyle];
      const n = 2 + Math.floor(this.rand() * 7);
      this.obstacles = [];
      for (let i = 0; i < n; i++) {
        const v = Math.floor(this.rand() * sizes.length);
        this.addObstacle((this.rand() * 2 - 1) * 1000, (this.rand() * 2 - 1) * 1000, sizes[v], v);
      }
    }

    addObstacle(x, y, r, variant, temp = 0) {
      const o = { id: this.nextId++, x, y, r, hp: OBSTACLE_HP, variant, temp };
      this.obstacles.push(o);
      return o;
    }

    damageObstacle(o, amount, src) {
      if (o.dead || this.phase !== 'fight') return;
      o.hp -= amount;
      if (o.hp > 0) return;
      o.dead = true;
      this.obstacles = this.obstacles.filter((q) => q !== o);
      // Explodes: 5 – 10 damage within 300, pushing everyone away.
      for (const p of this.alive()) {
        const d = len(p.x - o.x, p.y - o.y);
        if (d >= 300) continue;
        const [nx, ny] = norm(p.x - o.x, p.y - o.y);
        this.damage(p, src || null, 5 + 5 * (1 - d / 300), nx, ny, 1);
      }
      this.fx({ e: 'obstacleBoom', x: o.x, y: o.y, id: o.id });
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

    maxHp(p) { return MAX_HP + (p.items.ring ? lv(ITEMS.ring.hp, p.items.ring) : 0) + (p.items.cursed ? lv(ITEMS.cursed.hp, p.items.cursed) : 0); }
    // Mastery factors: duration and range start at 1, lifesteal at 0.
    mastery(p, i) {
      let f = i === 2 ? 0 : 1;
      for (let k = 0; k < (p.mastery[i] || 0); k++) f += MASTERY.gain[i][k];
      return f;
    }
    // How long debuffs last on a warlock: Pocket Watch shortens, Cursed Ring lengthens.
    debuffFactor(p) {
      return 1 + (p.items.cursed ? lv(ITEMS.cursed.debuff, p.items.cursed) : 0) + (p.items.watch ? lv(ITEMS.watch.debuff, p.items.watch) : 0);
    }
    // Pawn:getBuffDuration / getDebuffDuration.
    buffTime(t, target, caster) { return t * this.mastery(target, 0) * (caster && caster !== target ? this.mastery(caster, 0) : 1); }
    debuffTime(t, target, caster) { return t * this.debuffFactor(target) * (caster && caster !== target ? this.mastery(caster, 0) : 1); }
    regen(p) { return REGEN + (p.items.cape ? lv(ITEMS.cape.regen, p.items.cape) : 0); }
    speed(p) {
      let s = MOVE_SPEED + (p.items.boots ? lv(ITEMS.boots.speed, p.items.boots) : 0);
      if (p.mods.windwalk) s += SPELLS.windwalk.bonus;
      if (p.mods.rush) s += 35 + p.mods.rush.bonus;
      if (p.mods.drained) s -= 50;
      if (p.mods.hasted) s += p.mods.hasted.v;
      if (p.mods.pactSlow) s -= SPELLS.pact.slow;
      if (p.mods.snowed) s -= 100;
      if (p.mods.gripped) return 0;
      return Math.max(0, s);
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
      if (!p || !(this.phase === 'shop' || (this.mode === 'dm' && this.phase === 'fight'))) return false;
      if (SPELLS[what] && !ITEMS[what] && SPELLS[what].buy) {
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
        if (def.slot) p.spells[def.slot] = { key: what, level: 1 };
        p.hp = this.maxHp(p);
        return true;
      }
      const mi = ['m_dur', 'm_range', 'm_life'].indexOf(what);
      if (mi >= 0) {
        if (p.mastery[mi] >= MASTERY.max || p.cash < MASTERY.cost) return false;
        p.cash -= MASTERY.cost;
        p.mastery[mi]++;
        return true;
      }
      if (what === 'm_all') {
        if (p.mastery.some((m) => m >= MASTERY.max) || p.cash < MASTERY.allCost) return false;
        p.cash -= MASTERY.allCost;
        p.mastery = p.mastery.map((m) => m + 1);
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
        p.casting = null; // a new order replaces a cast that has not gone off yet
      } else if (inp.stop) {
        p.move = null;
        p.casting = null;
      } else if (inp.cast !== undefined) {
        this.cast(p, Number(inp.cast), Number(inp.x) || 0, Number(inp.y) || 0);
      }
    }

    cast(p, slot, tx, ty) {
      const s = p.spells[slot];
      if (!s) return;
      const def = SPELLS[s.key];
      if ((p.cd[slot] || 0) > 0) return;
      if (NO_TURN.has(s.key) && def.cast === 0) {
        this.fire(p, slot, tx, ty);
        return;
      }
      // Like Dota: turn to face the target, then the cast point, then the spell.
      p.casting = { slot, tx, ty, t: def.cast, turning: !NO_TURN.has(s.key), total: def.cast };
      p.move = null;
    }

    // Turns the warlock towards an angle at Dota's turn speed; true once it faces it.
    turn(p, want, dt) {
      let d = want - p.face;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const step = TURN_SPEED * dt;
      if (Math.abs(d) <= step) p.face = want;
      else p.face += Math.sign(d) * step;
      p.face = Math.atan2(Math.sin(p.face), Math.cos(p.face));
      return Math.abs(d) <= FACE_TOLERANCE;
    }

    fire(p, slot, tx, ty) {
      const s = p.spells[slot];
      if (!s) return;
      const def = SPELLS[s.key];
      const L = s.level;
      p.cd[slot] = lv(def.cd, L);
      // Pact: the next damaging spell hits 1.5x as hard, then the caster is slowed.
      let mul = 1;
      if (p.mods.pact && DAMAGE_SPELLS.has(s.key)) {
        mul = SPELLS.pact.mul;
        delete p.mods.pact;
        p.mods.pactSlow = { t: this.debuffTime(SPELLS.pact.slowTime, p, p) };
        this.fx({ e: 'pactBoost', id: p.id });
      }
      const rF = this.mastery(p, 1); // Range mastery: spells fly further
      const dF = (t) => this.buffTime(t, p, p); // Duration mastery on your own buffs
      if (p.mods.windwalk) delete p.mods.windwalk; // casting breaks invisibility
      if (p.mods.gripped) p.dp += SPELLS.grip.dpGain; // Grip: every spell cast adds damage points
      const [dx, dy] = norm(tx - p.x, ty - p.y);
      const dist = len(tx - p.x, ty - p.y);
      const proj = (o) => this.projectiles.push({ id: this.nextId++, owner: p.id, age: 0, hits: [], ...o, life: o.noRange ? o.life : o.life * rF });
      this.fx({ e: 'cast', k: s.key, id: p.id, x: p.x, y: p.y });
      switch (s.key) {
        case 'fireball':
          proj({ k: 'fireball', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: def.range / def.speed, dmg: lv(def.dmg, L) * mul, kb: 1 });
          break;
        case 'scourge': {
          const dmg = lv(def.dmg, L) * mul;
          this.damageArea(p, p.x, p.y, def.radius, { amount: dmg, kbMin: 0.75, kbMax: 1 });
          p.hp = Math.max(1, p.hp - (L === 1 ? dmg : 100));
          this.fx({ e: 'scourge', x: p.x, y: p.y, r: def.radius });
          break;
        }
        case 'lightning': {
          // Instant beam: hits the first enemy along the line.
          const range = def.range * rF;
          let best = null;
          for (const o of this.alive()) {
            if (this.ally(o.id, p.id)) continue;
            const along = (o.x - p.x) * dx + (o.y - p.y) * dy;
            if (along < 0 || along > range + RADIUS) continue;
            const off = Math.abs((o.x - p.x) * dy - (o.y - p.y) * dx);
            if (off <= 25 + RADIUS && (!best || along < best.along)) best = { o, along };
          }
          // ...unless an obstacle is in the way.
          let wall = null;
          for (const o of this.obstacles) {
            const along = (o.x - p.x) * dx + (o.y - p.y) * dy;
            const off = Math.abs((o.x - p.x) * dy - (o.y - p.y) * dx);
            if (along > 0 && along <= range + o.r && off <= 25 + o.r && (!wall || along < wall.along)) wall = { o, along: Math.max(0, along - o.r) };
          }
          if (wall && (!best || wall.along < best.along)) best = null; else wall = null;
          const end = best ? best.along : wall ? wall.along : range;
          this.fx({ e: 'bolt', x1: p.x, y1: p.y, x2: p.x + dx * end, y2: p.y + dy * end });
          if (best) this.damage(best.o, p, lv(def.dmg, L) * mul, dx, dy, def.kb);
          if (wall) this.damageObstacle(wall.o, lv(def.dmg, L) * mul, p);
          break;
        }
        case 'homing': {
          let target = null;
          let bd = Infinity;
          for (const o of this.alive()) {
            if (this.ally(o.id, p.id)) continue;
            const d = len(o.x - tx, o.y - ty);
            if (d < bd) { bd = d; target = o.id; }
          }
          proj({ k: 'homing', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * 800, vy: dy * 800, r: def.radius, life: def.life, dmg: lv(def.dmg, L) * mul, kb: 1, target, speed: def.speed });
          break;
        }
        case 'boomerang': {
          const d = Math.max(300, Math.min(dist, def.range * rF));
          proj({ k: 'boomerang', noRange: true, x: p.x + dx * 40, y: p.y + dy * 40, dirx: dx, diry: dy, d, phase: 'out', t: 0, vx: dx * 1500 + -dy * 300, vy: dy * 1500 + dx * 300, r: def.radius, life: 6, dmg: lv(def.dmg, L) * mul, kb: def.kb });
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
          p.mods.thrust = { t: 0.09 + d / def.speed, dx, dy, dmg: lv(def.dmg, L) * mul };
          p.move = null;
          break;
        }
        case 'swap':
          proj({ k: 'swap', x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: Math.min(dist / def.speed, def.life * rF), any: true, noRange: true });
          break;
        case 'cluster':
          for (const a of [-0.18, -0.06, 0.06, 0.18]) {
            const c = Math.cos(a);
            const sn = Math.sin(a);
            const ux = dx * c - dy * sn;
            const uy = dx * sn + dy * c;
            proj({ k: 'cluster', x: p.x + ux * 40, y: p.y + uy * 40, vx: ux * def.speed, vy: uy * def.speed, r: def.radius, life: def.range / def.speed, dmg: lv(def.dmg, L) * mul, kb: def.kb });
          }
          break;
        case 'bouncer':
          proj({ k: 'bouncer', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: 1, dmg: lv(def.dmg, L) * mul, kb: def.kb, prev: null });
          break;
        case 'meteor': {
          const d = Math.min(dist, def.range);
          proj({ k: 'meteor', x: p.x + dx * d, y: p.y + dy * d, vx: 0, vy: 0, r: lv(def.radius, L), life: def.delay, dmg: lv(def.dmg, L) * mul, dmgMin: def.dmgMin * mul, ghost: true, noRange: true });
          break;
        }
        case 'windwalk':
          p.mods.windwalk = { t: dF(def.duration), dmg: lv(def.dmg, L) * mul };
          break;
        case 'shield':
          p.mods.shield = { t: dF(def.duration), r: lv(def.radius, L) };
          break;
        case 'rush':
          p.mods.rush = { t: dF(lv(def.duration, L)), absorb: lv(def.absorb, L), bonus: 0 };
          break;
        case 'gravity':
          proj({ k: 'gravity', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: 25, life: def.life, strength: lv(def.strength, L), dps: lv(def.dps, L), ghost: true, tick: 0 });
          break;
        case 'twin': {
          // Two orbs on mirrored half-ellipses that meet at the target point.
          const range = def.range * rF;
          const minDist = Math.max(10, (2 * def.area) / (Math.PI * range));
          const d = Math.min(Math.max(dist, minDist), range);
          const ex = p.x + dx * d;
          const ey = p.y + dy * d;
          const a = d / 2;
          for (const sign of [1, -1]) {
            proj({ k: 'twin', noRange: true, x: p.x, y: p.y, vx: 0, vy: 0, r: def.radius, life: 9, dmg: lv(def.dmg, L) * mul, kb: 1,
              cx: (p.x + ex) / 2, cy: (p.y + ey) / 2, ea: a, eb: def.area / (Math.PI * a), ux: -dx, uy: -dy, sign, et: 0, speed: def.speed });
          }
          break;
        }
        case 'drain': {
          // Flies to the target point, then turns to the nearest warlock.
          const d = Math.min(dist, def.range * rF);
          proj({ k: 'drain', noRange: true, x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: d / def.speed + def.extra * rF, turnAt: def.extra * rF, turned: false, dmg: lv(def.dmg, L) * mul, dur: lv(def.duration, L) });
          break;
        }
        case 'recharge':
          proj({ k: 'recharge', x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: def.life, dmg: lv(def.dmg, L) * mul + def.perHit * (p.recharge || 0), caster: p.id });
          break;
        case 'splitter': {
          const life = Math.min(def.life * rF, dist / def.speed);
          proj({ k: 'splitter', noRange: true, rF, x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life, dmg: lv(def.dmg, L) * mul });
          break;
        }
        case 'snowball':
          proj({ k: 'snowball', x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: lv(def.radius, L), life: def.range / def.speed, dmg: lv(def.dmg, L) * mul, dmgMax: lv(def.dmgMax, L) * mul });
          break;
        case 'alteration':
          p.mods.alteration = { t: dF(def.duration) };
          break;
        case 'grip':
          proj({ k: 'grip', x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: def.life, dur: lv(def.duration, L) });
          break;
        case 'warpzone': {
          const d = Math.min(dist, def.range);
          this.zones.push({ id: this.nextId++, owner: p.id, x: p.x + dx * d, y: p.y + dy * d, r: lv(def.radius, L), life: def.duration * this.mastery(p, 0), scale: lv(def.scale, L) });
          break;
        }
        case 'magnetize':
          proj({ k: 'magnet', x: p.x, y: p.y, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: def.life, dur: lv(def.duration, L), bounced: false, any: true });
          break;
        case 'rockpillar': {
          const d = Math.min(dist, lv(def.range, L));
          const o = this.addObstacle(p.x + dx * d, p.y + dy * d, def.pillar, 0, def.duration * this.mastery(p, 0));
          o.pillar = 1;
          this.fx({ e: 'pillar', x: o.x, y: o.y });
          break;
        }
        case 'redirector': {
          // Turns your own spell nearest to the target point towards it (+0.5 s),
          // but you take 30% more knockback for 8 s.
          let best = null;
          let bd = Infinity;
          for (const b of this.projectiles) {
            if (b.owner !== p.id || ['meteor', 'linked', 'spawner', 'drainHeal', 'rechargeBack'].includes(b.k)) continue;
            const d = len(tx - b.x, ty - b.y);
            if (d < bd) { bd = d; best = b; }
          }
          if (best) {
            const sp = len(best.vx, best.vy);
            const [ux, uy] = norm(tx - best.x, ty - best.y);
            best.vx = ux * sp;
            best.vy = uy * sp;
            best.life += 0.5;
            if (best.k === 'twin') best.k = 'twinLoose';
            if (best.k === 'boomerang') best.phase = 'free';
            this.fx({ e: 'redirect', x: best.x, y: best.y, dx: ux, dy: uy });
          }
          p.mods.redirPenalty = { t: this.debuffTime(def.penaltyTime, p, p) };
          break;
        }
        case 'pact':
          p.mods.pact = { t: dF(def.duration) };
          break;
        case 'link':
          proj({ k: 'link', x: p.x + dx * 40, y: p.y + dy * 40, vx: dx * def.speed, vy: dy * def.speed, r: def.radius, life: def.range / def.speed, dmg: lv(def.dmg, L) * mul, any: true });
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
        // Lifesteal mastery: heal a share of the damage dealt.
        const ls = this.mastery(src, 2);
        if (ls > 0 && !src.dead) src.hp = Math.min(this.maxHp(src), src.hp + dmg * ls);
      }
      if (!noKb) {
        // Knockback factor: 1 minus Armor, Cursed Ring and Grip, plus the Redirector penalty.
        const kbF = 1 - (target.items.armor ? lv(ITEMS.armor.kbRed, target.items.armor) : 0) - (target.items.cursed ? ITEMS.cursed.kbRed : 0)
          - (target.mods.gripped ? 0.67 : 0) + (target.mods.redirPenalty ? SPELLS.redirector.penalty : 0);
        const k = dmg > 100 ? Math.sqrt(100 * dmg) : dmg;
        const kb = Math.max(0, kbF) * k * KB_DMG_TO_VELOCITY * (1 + target.dp / 1000) * kbFactor;
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
        if (src && this.ally(o.id, src.id)) continue;
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
      let killer = p.lastHit && this.time - p.lastHit.t < 8 ? this.pawn(p.lastHit.id) : null;
      if (killer && this.ally(killer.id, p.id)) killer = null;
      if (killer) killer.kills++;
      if (this.mode === 'dm') {
        // A kill scores 1 for every player on the killer's team; respawn in 10 s.
        if (killer) for (const q of this.pawns) if (q.team === killer.team) q.score++;
        if (!p.left) p.respawnAt = this.time + DM_RESPAWN;
      }
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
          if (this.gameOver()) this.finish();
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
      this.stepZones(dt);
      this.stepProjectiles(dt);
      this.collidePawns();
      this.collideObstacles();
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
      if (this.mode === 'dm') {
        // Respawns, and the end of each 60 s round.
        for (const p of this.pawns) if (p.dead && !p.left && p.respawnAt && this.time >= p.respawnAt) this.spawnAt(p);
        if (this.phaseLeft <= 0) {
          for (const p of this.pawns) p.cash += CASH_ROUND;
          this.fx({ e: 'roundEnd', round: this.round, winner: null, dm: 1 });
          if (this.gameOver()) this.finish();
          else this.nextDmRound();
        }
        return;
      }
      // Last team standing wins the round: everyone in it scores.
      const alive = this.alive();
      const teamsAlive = new Set(alive.map((p) => p.team));
      if (teamsAlive.size <= 1) {
        const team = alive.length ? alive[0].team : null;
        if (team !== null) for (const p of this.pawns) if (p.team === team && !p.left) p.score++;
        for (const p of this.pawns) p.cash += CASH_ROUND;
        this.phase = 'roundEnd';
        this.phaseLeft = 3;
        const winners = team === null ? [] : this.pawns.filter((p) => p.team === team && !p.left).map((p) => p.id);
        this.fx({ e: 'roundEnd', round: this.round, winner: winners.length === 1 ? winners[0] : null, team, winners });
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
              // Snowball: the chill deals its damage when it ends.
              if (k === 'snowed') this.damage(p, this.pawn(m.src), m.dmg, 0, 0, 1, { noKb: true });
            }
          }
        }
        if (p.casting && p.casting.turning) {
          const c = p.casting;
          if (this.turn(p, Math.atan2(c.ty - p.y, c.tx - p.x), dt)) c.turning = false;
        }
        if (p.casting && !p.casting.turning) {
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
          } else if (this.turn(p, Math.atan2(dy, dx), dt)) {
            // Walks straight to the point once roughly facing it.
            wx = (dx / d) * sp;
            wy = (dy / d) * sp;
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

    // Warp zones and Rockpillars run out.
    stepZones(dt) {
      for (const z of this.zones) z.life -= dt;
      this.zones = this.zones.filter((z) => z.life > 0);
      for (const o of this.obstacles) {
        if (!o.temp) continue;
        o.temp -= dt;
        if (o.temp <= 0) { o.dead = true; this.fx({ e: 'pillarEnd', x: o.x, y: o.y, id: o.id }); }
      }
      this.obstacles = this.obstacles.filter((o) => !o.dead);
    }

    // Warlocks bounce off obstacles (elasticity 0.5).
    collideObstacles() {
      for (const p of this.alive()) {
        for (const o of this.obstacles) {
          const dx = p.x - o.x;
          const dy = p.y - o.y;
          const d = len(dx, dy);
          const min = RADIUS + o.r;
          if (d >= min) continue;
          const [nx, ny] = d > 1e-6 ? [dx / d, dy / d] : [1, 0];
          p.x = o.x + nx * min;
          p.y = o.y + ny * min;
          const vn = p.vx * nx + p.vy * ny;
          if (vn < 0) {
            p.vx -= (1 + ELASTIC) * vn * nx;
            p.vy -= (1 + ELASTIC) * vn * ny;
          }
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
          const foes = !this.ally(p.id, q.id);
          for (const [s, t, sx, sy] of [[p, q, nx, ny], [q, p, -nx, -ny]]) {
            if (!s.mods.thrust || !foes) continue;
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
            if (!s.mods.windwalk || !foes) continue;
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

    stepProjectiles(dt0) {
      const keep = [];
      const ended = [];
      for (const b of this.projectiles) {
        if (b.dead) { ended.push(b); continue; }
        // Warp zones slow the spells of other players that fly through them.
        let dt = dt0;
        if (b.k !== 'meteor') {
          for (const z of this.zones) {
            if (z.owner !== b.owner && len(b.x - z.x, b.y - z.y) <= z.r + (b.r || 0)) dt *= z.scale;
          }
        }
        b.ts = dt / dt0;
        b.age += dt;
        const owner = this.pawn(b.owner);
        let gone = false;
        // Movement per kind.
        if (b.k === 'homing') {
          const t = this.pawn(b.target);
          if (!t || t.dead || this.ally(t.id, b.owner)) {
            let bd = Infinity;
            b.target = null;
            for (const o of this.alive()) {
              if (this.ally(o.id, b.owner)) continue;
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
        } else if (b.k === 'twin') {
          // Constant speed along the half-ellipse (TwinProjectile:onPreTick).
          const evx = -b.ea * Math.sin(b.et);
          const evy = b.sign * b.eb * Math.cos(b.et);
          b.et = Math.min(Math.PI, b.et + Math.max(0.001, (dt * b.speed) / (len(evx, evy) || 1)));
          const lx = b.ea * Math.cos(b.et);
          const ly = b.sign * b.eb * Math.sin(b.et);
          const nx = b.cx + b.ux * lx - b.uy * ly;
          const ny = b.cy + b.uy * lx + b.ux * ly;
          b.vx = (nx - b.x) / (dt || 1);
          b.vy = (ny - b.y) / (dt || 1);
          if (b.et >= Math.PI) b.life = 0;
        } else if (b.k === 'drain' && !b.turned && b.life <= b.turnAt) {
          // Turns towards the nearest warlock (other than the caster).
          b.turned = true;
          let best = null;
          let bd = Infinity;
          for (const o of this.alive()) {
            if (o.id === b.owner) continue;
            const d = len(o.x - b.x, o.y - b.y);
            if (d < bd) { bd = d; best = o; }
          }
          const [ux, uy] = best ? norm(best.x - b.x, best.y - b.y) : norm(b.vx, b.vy);
          b.vx = ux * SPELLS.drain.turnSpeed;
          b.vy = uy * SPELLS.drain.turnSpeed;
        } else if (b.k === 'drainHeal' || b.k === 'rechargeBack') {
          // Flies back to the caster: heals (Drain) or resets the cooldown (Recharge).
          if (!owner || owner.dead) gone = true;
          else if (len(owner.x - b.x, owner.y - b.y) < 64) {
            gone = true;
            if (b.k === 'drainHeal') {
              owner.hp = Math.min(this.maxHp(owner), owner.hp + b.heal);
              this.fx({ e: 'heal', id: owner.id, n: Math.round(b.heal) });
            } else {
              for (const [slot, sp] of Object.entries(owner.spells)) if (sp.key === 'recharge') owner.cd[slot] = 0;
              this.fx({ e: 'recharged', id: owner.id, n: owner.recharge || 0 });
            }
          } else {
            const [ux, uy] = norm(owner.x - b.x, owner.y - b.y);
            const sp = b.k === 'drainHeal' ? 650 : 400;
            b.vx = ux * sp;
            b.vy = uy * sp;
          }
        } else if (b.k === 'spawner') {
          // Splitter: 4 waves of 2 smaller bolts, fanning out less each time.
          b.tick += dt;
          const period = b.spawnLife / 4;
          while (b.tick >= period && b.waves < 4) {
            b.tick -= period;
            const [ux, uy] = norm(b.vx, b.vy);
            const alpha = b.spawnLife * (1 - b.waves / 4);
            for (const sign of [-1, 1]) {
              const cx = (ux - sign * uy * alpha) / (1 + alpha);
              const cy = (uy + sign * ux * alpha) / (1 + alpha);
              this.projectiles.push({ id: this.nextId++, k: 'splitChild', owner: b.owner, age: 0, hits: [], x: b.x, y: b.y, vx: cx * 600, vy: cy * 600, r: 21, life: 1.2 * (b.rF || 1), dmg: b.dmg, kb: 1 });
            }
            b.waves++;
          }
          if (b.waves >= 4) gone = true;
        } else if (b.k === 'gravity') {
          // Pulls enemies (and other spells) towards it and burns those close by.
          for (const o of this.alive()) {
            if (this.ally(o.id, b.owner)) continue;
            const d = len(o.x - b.x, o.y - b.y);
            if (d < 550) {
              const [ux, uy] = norm(b.x - o.x, b.y - o.y);
              const a = b.strength * (1 - (d * d) / (550 * 550));
              o.vx += ux * a * dt;
              o.vy += uy * a * dt;
            }
          }
          for (const q of this.projectiles) {
            if (q === b || ['meteor', 'gravity', 'link', 'spawner', 'drainHeal', 'rechargeBack'].includes(q.k)) continue;
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
              if (!this.ally(o.id, b.owner) && len(o.x - b.x, o.y - b.y) <= 250) this.damage(o, owner, b.dps * 0.2, 0, 0, 1, { noKb: true });
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
        // Magnetized warlocks bend other players' spells towards (or away from) them.
        if (!['meteor', 'linked', 'spawner', 'drainHeal', 'rechargeBack'].includes(b.k)) {
          for (const o of this.alive()) {
            const m = o.mods.magnet;
            if (!m || this.ally(o.id, b.owner)) continue;
            const d = len(o.x - b.x, o.y - b.y);
            if (d > 300) continue;
            const [ux, uy] = norm(o.x - b.x, o.y - b.y);
            const f = 0.2 * (1 - (d * d) / 90000);
            const sp = len(b.vx, b.vy);
            b.vx = (1 - f) * b.vx + f * sp * m.sign * ux;
            b.vy = (1 - f) * b.vy + f * sp * m.sign * uy;
          }
        }
        if (b.k !== 'linked') {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
        }
        b.life -= dt;
        const ghost = b.ghost || ['spawner', 'drainHeal', 'rechargeBack', 'linked'].includes(b.k);

        // Alteration: a warlock trades places with an enemy spell coming at it.
        if (!ghost && !gone && b.k !== 'gravity') {
          for (const o of this.alive()) {
            if (!o.mods.alteration || this.ally(o.id, b.owner)) continue;
            const dx = b.x - o.x;
            const dy = b.y - o.y;
            if (len(dx, dy) > SPELLS.alteration.radius + b.r || b.vx * dx + b.vy * dy >= 0) continue;
            this.fx({ e: 'alter', x1: o.x, y1: o.y, x2: b.x, y2: b.y });
            const ox = o.x;
            const oy = o.y;
            o.x = b.x;
            o.y = b.y;
            b.x = ox;
            b.y = oy;
            delete o.mods.alteration;
          }
        }

        // Shields turn enemy spells around and make them the shield owner's.
        if (!ghost && b.k !== 'swap') {
          for (const o of this.alive()) {
            if (!o.mods.shield || this.ally(o.id, b.owner) || b.shielded === o.id) continue;
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
              if (b.k === 'twin') b.life = 0.6; // leaves its ellipse
              if (b.k === 'twin') b.k = 'twinLoose';
              b.shielded = o.id;
              b.life = Math.max(b.life, 0.5);
              this.fx({ e: 'reflect', x: b.x, y: b.y });
            }
          }
        }

        // Obstacles: most spells damage them and burst; some bounce off.
        if (!gone && !ghost) {
          for (const o of this.obstacles) {
            const dx = b.x - o.x;
            const dy = b.y - o.y;
            const d = len(dx, dy);
            if (d > b.r + o.r) continue;
            const [nx, ny] = d > 1e-6 ? [dx / d, dy / d] : [1, 0];
            const vn = b.vx * nx + b.vy * ny;
            if (['drain', 'recharge', 'magnet', 'boomerang'].includes(b.k)) {
              if (vn < 0) { b.vx -= 2 * vn * nx; b.vy -= 2 * vn * ny; }
              b.x = o.x + nx * (b.r + o.r + 1);
              b.y = o.y + ny * (b.r + o.r + 1);
              if (b.k === 'magnet') b.bounced = true;
              if (b.k === 'boomerang') b.phase = 'back';
            } else if (b.k === 'splitter') {
              // Splits backwards, out of the obstacle.
              b.vx = -b.vx;
              b.vy = -b.vy;
              b.x = o.x + nx * (b.r + o.r + 10);
              b.y = o.y + ny * (b.r + o.r + 10);
              gone = true;
            } else if (b.k === 'snowball') {
              this.damageObstacle(o, b.dmgMax, owner);
              gone = true;
            } else if (b.k === 'grip' || b.k === 'link' || b.k === 'swap') {
              gone = true;
            } else if (b.k !== 'gravity') {
              this.damageObstacle(o, b.dmg || 0, owner);
              this.fx({ e: 'boom', k: b.k, x: b.x, y: b.y });
              gone = true;
            }
            break;
          }
        }

        // Hits on warlocks.
        if (!gone && !ghost && b.k !== 'gravity') {
          for (const o of this.alive()) {
            const self = o.id === b.owner;
            if (self && !(b.k === 'bouncer' && b.prev) && !(b.k === 'magnet' && b.bounced)) continue;
            // Team mates: most spells pass through; a few help them instead.
            if (!self && this.ally(o.id, b.owner) && !['swap', 'link'].includes(b.k)) {
              if (len(o.x - b.x, o.y - b.y) > b.r + RADIUS) continue;
              if (b.k === 'drain') {
                o.hp = Math.min(this.maxHp(o), o.hp + b.dmg);
                o.mods.hasted = { t: this.buffTime(b.dur, o, owner), v: 50 };
                this.fx({ e: 'heal', id: o.id, n: Math.round(b.dmg) });
                gone = true;
                break;
              }
              if (b.k === 'homing') {
                // Bursts at the ally, hurting enemies around, and speeds the ally up.
                const thrusting = !!o.mods.thrust;
                this.damageArea(owner, b.x, b.y, SPELLS.homing.explode * (thrusting ? 1.05 : 1), { amount: b.dmg, amountMin: 0, kbMin: 0.9, kbMax: 0.9 });
                o.mods.hasted = { t: this.buffTime(4, o, owner), v: thrusting ? 120 : 50 };
                this.fx({ e: 'boom', k: 'homing', x: b.x, y: b.y });
                gone = true;
                break;
              }
              if (b.k === 'magnet') {
                o.mods.magnet = { t: this.buffTime(b.dur, o, owner), sign: -1 };
                this.fx({ e: 'magnet', id: o.id, sign: -1 });
                gone = true;
                break;
              }
              continue;
            }
            if (b.hits.includes(o.id) && b.k !== 'bouncer' && b.k !== 'snowball') continue;
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
            if (b.k === 'splitter') { gone = true; break; } // splits on contact, the bolts do the damage
            if (b.k === 'snowball') {
              // Carries warlocks along and chills them: damage every half second.
              const c = 425 - (nx * o.vx + ny * o.vy);
              if (c > 0) { o.vx += c * nx; o.vy += c * ny; }
              if (!o.mods.snowed && !o.mods.spawnShield) o.mods.snowed = { t: 0.5, dmg: b.dmg * 0.5, src: b.owner };
              continue;
            }
            if (b.k === 'grip') {
              if (!o.mods.spawnShield) {
                o.move = null;
                o.casting = null;
                o.mods.gripped = { t: this.debuffTime(b.dur, o, owner) };
                this.fx({ e: 'grip', id: o.id });
              }
              gone = true;
              break;
            }
            if (b.k === 'magnet') {
              o.mods.magnet = { t: self ? this.buffTime(b.dur, o, owner) : this.debuffTime(b.dur, o, owner), sign: self ? -1 : 1 };
              this.fx({ e: 'magnet', id: o.id, sign: self ? -1 : 1 });
              gone = true;
              break;
            }
            if (b.k === 'drain') {
              this.damage(o, owner, b.dmg, nx, ny, 0.2);
              if (!o.dead && !o.mods.spawnShield) o.mods.drained = { t: this.debuffTime(b.dur, o, owner) };
              if (owner) this.projectiles.push({ id: this.nextId++, k: 'drainHeal', owner: b.owner, age: 0, hits: [], x: b.x, y: b.y, vx: 0, vy: 0, r: 0, life: 30, heal: b.dmg });
              this.fx({ e: 'boom', k: 'drain', x: b.x, y: b.y });
              gone = true;
              break;
            }
            this.damage(o, owner, b.dmg, nx, ny, b.kb);
            this.fx({ e: 'boom', k: b.k, x: b.x, y: b.y });
            b.hits.push(o.id);
            if (b.k === 'recharge') {
              b.hitPawn = true;
              if (owner) this.projectiles.push({ id: this.nextId++, k: 'rechargeBack', owner: b.owner, age: 0, hits: [], x: b.x, y: b.y, vx: 0, vy: 0, r: 0, life: 30 });
              gone = true;
            } else if (b.k === 'bouncer') {
              b.dmg *= 0.7;
              b.prev = o.id;
              if (b.dmg < 10) { gone = true; break; }
              // Next target: the closest other warlock.
              let next = null;
              let bd = Infinity;
              for (const q of this.alive()) {
                if (q.id === o.id || this.ally(q.id, b.owner)) continue;
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

        // Spells hitting spells: both burst. A snowball swallows what hits it.
        if (!gone && !ghost && b.k !== 'swap') {
          for (const q of this.projectiles) {
            if (q === b || q.ghost || q.dead || ['linked', 'swap', 'spawner', 'drainHeal', 'rechargeBack'].includes(q.k) || this.ally(q.owner, b.owner)) continue;
            if (len(q.x - b.x, q.y - b.y) <= b.r + q.r) {
              if (b.k !== 'snowball') gone = true;
              if (q.k !== 'snowball') q.dead = true;
              this.fx({ e: 'boom', k: 'clash', x: (b.x + q.x) / 2, y: (b.y + q.y) / 2 });
              if (gone) break;
            }
          }
        }

        if (b.life <= 0) gone = true;
        if (gone || b.dead) ended.push(b);
        else keep.push(b);
      }
      this.projectiles = keep.filter((b) => !b.dead);
      for (const b of keep) if (b.dead) ended.push(b);
      for (const b of ended) this.projectileEnd(b);
    }

    // What happens when a spell ends (hit, timed out or destroyed).
    projectileEnd(b) {
      const owner = this.pawn(b.owner);
      if (b.k === 'meteor' && b.life <= 0) {
        this.damageArea(owner, b.x, b.y, b.r, { amount: b.dmg, amountMin: b.dmgMin });
        this.fx({ e: 'meteor', x: b.x, y: b.y, r: b.r });
      } else if (b.k === 'swap' && owner && !b.swapped && !owner.dead) {
        // A miss still moves the caster to the end of the swap path.
        this.fx({ e: 'swap', x1: owner.x, y1: owner.y, x2: b.x, y2: b.y });
        owner.x = b.x;
        owner.y = b.y;
        owner.move = null;
      } else if (b.k === 'splitter') {
        this.projectiles.push({ id: this.nextId++, k: 'spawner', owner: b.owner, age: 0, hits: [], x: b.x, y: b.y, ...((() => { const [ux, uy] = norm(b.vx, b.vy); return { vx: ux * 250, vy: uy * 250 }; })()), r: 0, life: 5, spawnLife: 0.48, waves: 0, tick: 0, dmg: b.dmg, rF: b.rF });
        this.fx({ e: 'split', x: b.x, y: b.y });
      } else if (b.k === 'snowball') {
        // Bursts: up to its full damage at the centre, pushing with 0.8 force.
        this.damageArea(owner, b.x, b.y, SPELLS.snowball.blast, { amount: b.dmgMax, amountMin: 0, kbMin: 0.8, kbMax: 0.8 });
        this.fx({ e: 'snowboom', x: b.x, y: b.y, r: SPELLS.snowball.blast });
      } else if (b.k === 'recharge') {
        // Hits in a row make the next Recharge stronger (+10 each); a miss resets.
        const caster = this.pawn(b.caster);
        if (caster) caster.recharge = b.hitPawn && b.owner === b.caster ? (caster.recharge || 0) + 1 : 0;
      }
    }

    finish() {
      this.phase = 'over';
      const order = this.pawns.slice().sort((a, b) => b.score - a.score || b.kills - a.kills || b.dmgDone - a.dmgDone);
      const top = order[0] ? order[0].score : 0;
      this.fx({ e: 'over', winner: order[0] ? order[0].id : null, winners: this.pawns.filter((p) => p.score === top).map((p) => p.id) });
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
        mode: this.mode, tmode: this.teamMode, win: this.win, target: this.target,
        t: r1(this.time), ph: this.phase, left: Math.max(0, r1(this.phaseLeft)), round: this.round, rounds: this.rounds, layer: this.layer,
        shrink: r1(SHRINK_PERIOD - this.shrinkAcc),
        p: this.pawns.map((p) => ({
          id: p.id, x: r1(p.x), y: r1(p.y), f: Math.round(p.face * 100) / 100, hp: Math.round(p.hp), mx: this.maxHp(p), dp: Math.round(p.dp), d: p.dead ? 1 : 0, l: p.left ? 1 : 0,
          sc: p.score, k: p.kills, c: p.cash, tm: p.team, rs: p.dead && p.respawnAt ? Math.max(0, Math.ceil(p.respawnAt - this.time)) : 0, cast: p.casting && !p.casting.turning ? 1 : 0,
          cs: p.casting && !p.casting.turning ? p.spells[p.casting.slot].key : '',
          cp: p.casting && !p.casting.turning && p.casting.total ? r1(1 - p.casting.t / p.casting.total) : 0,
          mv: p.move ? 1 : 0,
          m: Object.keys(p.mods).filter((k) => p.mods[k]),
          sh: p.mods.shield ? p.mods.shield.r : 0,
          cd: Object.fromEntries(Object.entries(p.cd).filter(([, v]) => v > 0).map(([k, v]) => [k, r1(v)])),
          sp: Object.fromEntries(Object.entries(p.spells).map(([k, v]) => [k, [v.key, v.level]])),
          it: p.items,
          ms: p.mastery,
        })),
        b: this.projectiles.filter((b) => b.k !== 'spawner').map((b) => [b.k, r1(b.x), r1(b.y), r1(b.vx * (b.ts ?? 1)), r1(b.vy * (b.ts ?? 1)), b.r, b.owner, b.k === 'linked' ? b.target : b.life > 0 ? r1(b.life) : 0, b.id]),
        o: this.obstacles.map((o) => [o.id, r1(o.x), r1(o.y), o.r, Math.round(o.hp), o.variant, o.pillar ? 1 : 0]),
        os: this.obstacleStyle,
        z: this.zones.map((z) => [z.id, r1(z.x), r1(z.y), z.r, r1(z.life), z.owner]),
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
    Sim, SPELLS, ITEMS, MASTERY, COLUMN_SPELLS, COLORS, TEAM_COLORS, DM_ROUND_TIME, OBSTACLE_HP, TICK, TILE, LAYER_RADIUS, RADIUS, MAX_HP, SHOP_TIME, SHRINK_PERIOD, lv,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Warlock;
  else root.Warlock = Warlock;
}(typeof window !== 'undefined' ? window : globalThis));
