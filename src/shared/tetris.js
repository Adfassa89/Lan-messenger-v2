'use strict';
// Tetris rules in the style of TETR.IO: 10×40 board (20 rows visible),
// 7-bag randomizer, SRS rotation with wall kicks (plus 180° kicks), hold,
// T-spin detection and an attack table with back-to-back, combos and
// perfect clears. Timing (gravity, lock delay, key repeat) lives in the
// game window; this file only knows the rules, so it can be tested.
(function init(root) {
  const W = 10;
  const H = 40;
  const VISIBLE = 20;
  const TYPES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];

  // Spawn orientation; x to the right, y downwards, inside a 3×3 box
  // (4×4 for I and O).
  const BASE = {
    T: [[1, 0], [0, 1], [1, 1], [2, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
    J: [[0, 0], [0, 1], [1, 1], [2, 1]],
    L: [[2, 0], [0, 1], [1, 1], [2, 1]],
    I: [[0, 1], [1, 1], [2, 1], [3, 1]],
    O: [[1, 0], [2, 0], [1, 1], [2, 1]],
  };
  const BOX = { I: 4, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };

  const SHAPES = {};
  for (const t of TYPES) {
    SHAPES[t] = [BASE[t]];
    for (let r = 1; r < 4; r++) {
      const n = BOX[t] - 1;
      SHAPES[t].push(t === 'O' ? BASE.O : SHAPES[t][r - 1].map(([x, y]) => [n - y, x]));
    }
  }

  // SRS kick tables, written with y pointing up as in the guideline.
  const K = (list) => list.map(([x, y]) => [x, -y]);
  const KICKS_JLSTZ = {
    '0>1': K([[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]),
    '1>0': K([[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]),
    '1>2': K([[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]),
    '2>1': K([[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]),
    '2>3': K([[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]),
    '3>2': K([[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]),
    '3>0': K([[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]),
    '0>3': K([[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]),
  };
  const KICKS_I = {
    '0>1': K([[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]),
    '1>0': K([[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]),
    '1>2': K([[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]),
    '2>1': K([[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]),
    '2>3': K([[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]),
    '3>2': K([[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]),
    '3>0': K([[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]),
    '0>3': K([[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]),
  };
  const KICKS_180 = {
    '0>2': K([[0, 0], [0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0]]),
    '2>0': K([[0, 0], [0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0]]),
    '1>3': K([[0, 0], [1, 0], [1, 2], [1, 1], [0, 2], [0, 1]]),
    '3>1': K([[0, 0], [-1, 0], [-1, 2], [-1, 1], [0, 2], [0, 1]]),
  };

  // Attack table (lines sent), modelled on TETR.IO.
  const CLEAR_ATTACK = [0, 0, 1, 2, 4];
  const TSPIN_ATTACK = [0, 2, 4, 6];
  const MINI_ATTACK = [0, 0, 1];
  const COMBO_BONUS = [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
  const PERFECT_CLEAR = 10;
  const GARBAGE_CAP = 8; // garbage rows that can rise after one piece

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Tetris {
    constructor(seed = Date.now()) {
      this.board = new Array(W * H).fill(null);
      this.random = rng(seed);
      this.garbageRandom = rng(seed ^ 0x5bd1e995);
      this.queue = [];
      this.hold = null;
      this.holdUsed = false;
      this.combo = -1;
      this.b2b = -1;
      this.garbage = []; // incoming: [{ lines, col }]
      this.dead = false;
      this.stats = { pieces: 0, lines: 0, sent: 0, received: 0 };
      this.lastAction = null; // 'move' | 'rotate'
      this.lastKick = 0;
      this.active = null;
      this.fill();
    }

    fill() {
      while (this.queue.length < 14) {
        const bag = TYPES.slice();
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        this.queue.push(...bag);
      }
    }

    next(count = 5) {
      return this.queue.slice(0, count);
    }

    cells(p = this.active) {
      return SHAPES[p.type][p.rot].map(([x, y]) => [p.x + x, p.y + y]);
    }

    fits(p) {
      return this.cells(p).every(([x, y]) => x >= 0 && x < W && y >= 0 && y < H && !this.board[y * W + x]);
    }

    filled(x, y) {
      return x < 0 || x >= W || y >= H || (y >= 0 && !!this.board[y * W + x]);
    }

    // Puts the next piece at the top. Returns false when it cannot fit (top out).
    spawn(type = null) {
      this.fill();
      const t = type || this.queue.shift();
      const p = { type: t, rot: 0, x: 3, y: H - VISIBLE - 2 };
      if (t === 'I') p.y -= 1;
      this.active = p;
      this.lastAction = null;
      if (!this.fits(p)) {
        this.dead = true;
        return false;
      }
      // Guideline: drop one row right away if there is room.
      const down = { ...p, y: p.y + 1 };
      if (this.fits(down)) this.active = down;
      return true;
    }

    move(dx) {
      const p = { ...this.active, x: this.active.x + dx };
      if (!this.fits(p)) return false;
      this.active = p;
      this.lastAction = 'move';
      return true;
    }

    drop() {
      const p = { ...this.active, y: this.active.y + 1 };
      if (!this.fits(p)) return false;
      this.active = p;
      this.lastAction = 'move';
      return true;
    }

    grounded() {
      return !this.fits({ ...this.active, y: this.active.y + 1 });
    }

    ghostY() {
      let y = this.active.y;
      while (this.fits({ ...this.active, y: y + 1 })) y++;
      return y;
    }

    // dir: 1 clockwise, -1 counter-clockwise, 2 for 180°.
    rotate(dir) {
      const p = this.active;
      if (p.type === 'O') return false;
      const to = (p.rot + dir + 4) % 4;
      const key = `${p.rot}>${to}`;
      const table = dir === 2 ? KICKS_180 : p.type === 'I' ? KICKS_I : KICKS_JLSTZ;
      const kicks = table[key] || [[0, 0]];
      for (let i = 0; i < kicks.length; i++) {
        const [dx, dy] = kicks[i];
        const q = { ...p, rot: to, x: p.x + dx, y: p.y + dy };
        if (this.fits(q)) {
          this.active = q;
          this.lastAction = 'rotate';
          this.lastKick = i;
          return true;
        }
      }
      return false;
    }

    holdPiece() {
      if (this.holdUsed) return false;
      const cur = this.active.type;
      this.holdUsed = true;
      if (this.hold) {
        const h = this.hold;
        this.hold = cur;
        this.spawn(h);
      } else {
        this.hold = cur;
        this.spawn();
      }
      return true;
    }

    // T-spin check: 3 of the 4 corners around the T are filled after a rotation.
    tspin() {
      const p = this.active;
      if (p.type !== 'T' || this.lastAction !== 'rotate') return null;
      const c = [[0, 0], [2, 0], [2, 2], [0, 2]].map(([x, y]) => this.filled(p.x + x, p.y + y));
      if (c.filter(Boolean).length < 3) return null;
      const front = [[0, 1], [1, 2], [2, 3], [3, 0]][p.rot];
      const both = c[front[0]] && c[front[1]];
      return both || this.lastKick === 4 ? 'full' : 'mini';
    }

    hardDrop() {
      while (this.drop()) { /* fall */ }
      return this.lock();
    }

    // Fixes the piece, clears lines, works out the attack and lets incoming
    // garbage rise. Returns what happened.
    lock() {
      const spin = this.tspin();
      for (const [x, y] of this.cells()) this.board[y * W + x] = this.active.type;
      const lockedAbove = this.cells().every(([, y]) => y < H - VISIBLE);
      this.stats.pieces++;
      const full = [];
      for (let y = 0; y < H; y++) {
        let n = 0;
        for (let x = 0; x < W; x++) if (this.board[y * W + x]) n++;
        if (n === W) full.push(y);
      }
      for (const y of full) {
        this.board.splice(y * W, W);
        this.board.unshift(...new Array(W).fill(null));
      }
      const lines = full.length;
      this.stats.lines += lines;

      let attack = 0;
      const difficult = lines > 0 && (lines === 4 || spin);
      if (spin === 'full') attack = TSPIN_ATTACK[lines] || 0;
      else if (spin === 'mini') attack = MINI_ATTACK[lines] || 0;
      else attack = CLEAR_ATTACK[lines];
      let b2bBonus = false;
      if (difficult) {
        if (this.b2b >= 0) {
          attack += 1;
          b2bBonus = true;
        }
        this.b2b++;
      } else if (lines > 0) {
        this.b2b = -1;
      }
      if (lines > 0) {
        this.combo++;
        attack += COMBO_BONUS[Math.min(this.combo, COMBO_BONUS.length - 1)];
      } else {
        this.combo = -1;
      }
      const perfect = lines > 0 && this.board.every((c) => !c);
      if (perfect) attack += PERFECT_CLEAR;

      // Outgoing attack first cancels garbage waiting to come in.
      let sent = attack;
      while (sent > 0 && this.garbage.length) {
        const g = this.garbage[0];
        const use = Math.min(g.lines, sent);
        g.lines -= use;
        sent -= use;
        if (!g.lines) this.garbage.shift();
      }
      this.stats.sent += sent;

      let risen = 0;
      if (lines === 0) risen = this.riseGarbage();

      const result = {
        lines, spin, perfect, combo: this.combo, b2b: b2bBonus ? this.b2b : 0, attack, sent, risen,
      };
      this.holdUsed = false;
      if (lockedAbove || this.dead) {
        this.dead = true;
        result.ko = true;
        return result;
      }
      if (!this.spawn()) result.ko = true;
      return result;
    }

    receive(lines) {
      if (lines <= 0) return;
      const col = Math.floor(this.garbageRandom() * W);
      this.garbage.push({ lines, col });
      this.stats.received += lines;
    }

    pendingGarbage() {
      return this.garbage.reduce((n, g) => n + g.lines, 0);
    }

    riseGarbage() {
      let budget = GARBAGE_CAP;
      let risen = 0;
      while (budget > 0 && this.garbage.length) {
        const g = this.garbage[0];
        const n = Math.min(g.lines, budget);
        for (let i = 0; i < n; i++) {
          const top = this.board.splice(0, W);
          if (top.some(Boolean)) this.dead = true; // pushed off the top
          const row = new Array(W).fill('G');
          row[g.col] = null;
          this.board.push(...row);
        }
        g.lines -= n;
        budget -= n;
        risen += n;
        if (!g.lines) this.garbage.shift();
      }
      return risen;
    }

    // Compact picture for the opponent's screen: visible rows plus the falling piece.
    snapshot() {
      const cells = this.board.slice((H - VISIBLE - 2) * W);
      if (this.active && !this.dead) {
        for (const [x, y] of this.cells()) {
          const i = (y - (H - VISIBLE - 2)) * W + x;
          if (i >= 0 && i < cells.length) cells[i] = this.active.type.toLowerCase();
        }
      }
      return cells.map((c) => c || '.').join('');
    }
  }

  const TetrisRules = { Tetris, W, H, VISIBLE, TYPES, SHAPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = TetrisRules;
  else root.TetrisRules = TetrisRules;
}(typeof window !== 'undefined' ? window : globalThis));
