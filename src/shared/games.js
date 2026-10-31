'use strict';
// Rules for the two-player chat games. Used by the messenger core to check
// every move it receives, and by the interface to show the boards.
//
// A game is a list of entries { p, m }: p is the player (0 or 1) and m is a
// move, or one of { resign: true } / { draw: 'offer' | 'accept' | 'decline' }
// / { timeout: true }. Player 0 always moves first.
//
// Chess may have a clock, { base, inc } in milliseconds. Each move entry then
// carries t, the time the mover spent on it (measured on the mover's PC).
// Each player's first move is free; the increment is added after every move.
(function init(root) {
  // ------------------------------------------------------------------ chess
  const FILES = 'abcdefgh';
  const sq = (f, r) => r * 8 + f; // r = 0 is rank 1
  const fileOf = (s) => s & 7;
  const rankOf = (s) => s >> 3;
  const name = (s) => FILES[fileOf(s)] + (rankOf(s) + 1);
  const isWhite = (p) => p && p === p.toUpperCase();
  const colorOf = (p) => (p ? (isWhite(p) ? 'w' : 'b') : null);

  const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  function chessFromFen(fen) {
    const [placement, turn, castling, ep, half, full] = fen.split(' ');
    const board = new Array(64).fill(null);
    placement.split('/').forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else board[sq(f++, 7 - i)] = ch;
      }
    });
    return {
      board,
      turn,
      castling: castling === '-' ? '' : castling,
      ep: ep === '-' ? null : FILES.indexOf(ep[0]) + (Number(ep[1]) - 1) * 8,
      half: Number(half) || 0,
      full: Number(full) || 1,
    };
  }

  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  function attacked(board, s, by) {
    const f = fileOf(s);
    const r = rankOf(s);
    const at = (ff, rr) => (ff >= 0 && ff < 8 && rr >= 0 && rr < 8 ? board[sq(ff, rr)] : undefined);
    const own = (p, type) => p && colorOf(p) === by && p.toLowerCase() === type;
    const dir = by === 'w' ? -1 : 1; // pawns attack from behind
    if (own(at(f - 1, r + dir), 'p') || own(at(f + 1, r + dir), 'p')) return true;
    for (const [df, dr] of KNIGHT) if (own(at(f + df, r + dr), 'n')) return true;
    for (const [df, dr] of KING) if (own(at(f + df, r + dr), 'k')) return true;
    for (const [dirs, types] of [[ROOK, 'rq'], [BISHOP, 'bq']]) {
      for (const [df, dr] of dirs) {
        let ff = f + df;
        let rr = r + dr;
        while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) {
          const p = board[sq(ff, rr)];
          if (p) {
            if (colorOf(p) === by && types.includes(p.toLowerCase())) return true;
            break;
          }
          ff += df;
          rr += dr;
        }
      }
    }
    return false;
  }

  function kingSquare(board, color) {
    const k = color === 'w' ? 'K' : 'k';
    return board.indexOf(k);
  }

  function inCheck(st, color = st.turn) {
    return attacked(st.board, kingSquare(st.board, color), color === 'w' ? 'b' : 'w');
  }

  function pseudoMoves(st) {
    const { board, turn } = st;
    const moves = [];
    const enemy = turn === 'w' ? 'b' : 'w';
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (!p || colorOf(p) !== turn) continue;
      const f = fileOf(s);
      const r = rankOf(s);
      const type = p.toLowerCase();
      const add = (to, extra) => moves.push({ from: s, to, ...extra });
      const addPawn = (to) => {
        if (rankOf(to) === 0 || rankOf(to) === 7) for (const promo of 'qrbn') add(to, { promo });
        else add(to);
      };
      if (type === 'p') {
        const dir = turn === 'w' ? 1 : -1;
        const startRank = turn === 'w' ? 1 : 6;
        const one = sq(f, r + dir);
        if (r + dir >= 0 && r + dir < 8 && !board[one]) {
          addPawn(one);
          const two = sq(f, r + 2 * dir);
          if (r === startRank && !board[two]) add(two);
        }
        for (const df of [-1, 1]) {
          const ff = f + df;
          const rr = r + dir;
          if (ff < 0 || ff > 7 || rr < 0 || rr > 7) continue;
          const to = sq(ff, rr);
          if (board[to] && colorOf(board[to]) === enemy) addPawn(to);
          else if (to === st.ep) add(to, { ep: true });
        }
      } else if (type === 'n' || type === 'k') {
        for (const [df, dr] of type === 'n' ? KNIGHT : KING) {
          const ff = f + df;
          const rr = r + dr;
          if (ff < 0 || ff > 7 || rr < 0 || rr > 7) continue;
          const to = sq(ff, rr);
          if (!board[to] || colorOf(board[to]) === enemy) add(to);
        }
        if (type === 'k') {
          const home = turn === 'w' ? 0 : 7;
          const rights = turn === 'w' ? ['K', 'Q'] : ['k', 'q'];
          if (s === sq(4, home) && !attacked(board, s, enemy)) {
            if (st.castling.includes(rights[0]) && !board[sq(5, home)] && !board[sq(6, home)]
              && !attacked(board, sq(5, home), enemy) && !attacked(board, sq(6, home), enemy)) {
              add(sq(6, home), { castle: 'k' });
            }
            if (st.castling.includes(rights[1]) && !board[sq(3, home)] && !board[sq(2, home)] && !board[sq(1, home)]
              && !attacked(board, sq(3, home), enemy) && !attacked(board, sq(2, home), enemy)) {
              add(sq(2, home), { castle: 'q' });
            }
          }
        }
      } else {
        const dirs = type === 'r' ? ROOK : type === 'b' ? BISHOP : ROOK.concat(BISHOP);
        for (const [df, dr] of dirs) {
          let ff = f + df;
          let rr = r + dr;
          while (ff >= 0 && ff < 8 && rr >= 0 && rr < 8) {
            const to = sq(ff, rr);
            if (board[to]) {
              if (colorOf(board[to]) === enemy) add(to);
              break;
            }
            add(to);
            ff += df;
            rr += dr;
          }
        }
      }
    }
    return moves;
  }

  function makeMove(st, mv) {
    const board = st.board.slice();
    const p = board[mv.from];
    const captured = mv.ep ? board[mv.to + (st.turn === 'w' ? -8 : 8)] : board[mv.to];
    board[mv.to] = mv.promo ? (st.turn === 'w' ? mv.promo.toUpperCase() : mv.promo) : p;
    board[mv.from] = null;
    if (mv.ep) board[mv.to + (st.turn === 'w' ? -8 : 8)] = null;
    if (mv.castle) {
      const home = st.turn === 'w' ? 0 : 7;
      const [rf, rt] = mv.castle === 'k' ? [7, 5] : [0, 3];
      board[sq(rt, home)] = board[sq(rf, home)];
      board[sq(rf, home)] = null;
    }
    let castling = st.castling;
    const strip = (chars) => { for (const c of chars) castling = castling.replace(c, ''); };
    if (p === 'K') strip('KQ');
    if (p === 'k') strip('kq');
    for (const s of [mv.from, mv.to]) {
      if (s === 0) strip('Q');
      if (s === 7) strip('K');
      if (s === 56) strip('q');
      if (s === 63) strip('k');
    }
    const pawn = p.toLowerCase() === 'p';
    return {
      board,
      turn: st.turn === 'w' ? 'b' : 'w',
      castling,
      ep: pawn && Math.abs(mv.to - mv.from) === 16 ? (mv.from + mv.to) / 2 : null,
      half: pawn || captured ? 0 : st.half + 1,
      full: st.full + (st.turn === 'b' ? 1 : 0),
      last: { from: mv.from, to: mv.to },
      captured: captured || null,
    };
  }

  function legalMoves(st) {
    return pseudoMoves(st).filter((mv) => !inCheck(makeMove(st, mv), st.turn));
  }

  function insufficient(board) {
    const rest = board.filter((p) => p && p.toLowerCase() !== 'k');
    if (!rest.length) return true;
    return rest.length === 1 && 'bn'.includes(rest[0].toLowerCase());
  }

  // Standard algebraic notation, as used by chess sites: Nf3, exd5, O-O, e8=Q+, Qh4#.
  function san(st, mv, legal, next) {
    let s;
    if (mv.castle) {
      s = mv.castle === 'k' ? 'O-O' : 'O-O-O';
    } else {
      const p = st.board[mv.from];
      const type = p.toLowerCase();
      const capture = !!st.board[mv.to] || !!mv.ep;
      if (type === 'p') {
        s = (capture ? `${FILES[fileOf(mv.from)]}x` : '') + name(mv.to) + (mv.promo ? `=${mv.promo.toUpperCase()}` : '');
      } else {
        const rivals = legal.filter((o) => o.to === mv.to && o.from !== mv.from && st.board[o.from] === p);
        let dis = '';
        if (rivals.length) {
          if (!rivals.some((o) => fileOf(o.from) === fileOf(mv.from))) dis = FILES[fileOf(mv.from)];
          else if (!rivals.some((o) => rankOf(o.from) === rankOf(mv.from))) dis = String(rankOf(mv.from) + 1);
          else dis = name(mv.from);
        }
        s = type.toUpperCase() + dis + (capture ? 'x' : '') + name(mv.to);
      }
    }
    if (inCheck(next)) s += legalMoves(next).length ? '+' : '#';
    return s;
  }

  const chess = {
    title: 'Chess',
    init: () => ({ ...chessFromFen(START), captured: null, last: null, log: [] }),
    fromFen: chessFromFen,
    legalMoves,
    inCheck,
    // m = { from: 'e2', to: 'e4', promo?: 'q' }
    apply(st, m, player) {
      if ((player === 0 ? 'w' : 'b') !== st.turn) throw new Error('Not your turn');
      const from = typeof m.from === 'string' ? FILES.indexOf(m.from[0]) + (Number(m.from[1]) - 1) * 8 : m.from;
      const to = typeof m.to === 'string' ? FILES.indexOf(m.to[0]) + (Number(m.to[1]) - 1) * 8 : m.to;
      const promo = m.promo ? String(m.promo).toLowerCase() : undefined;
      const legal = legalMoves(st);
      const mv = legal.find((x) => x.from === from && x.to === to && (x.promo || undefined) === (x.promo ? promo || 'q' : undefined));
      if (!mv) throw new Error('Illegal move');
      const next = makeMove(st, mv);
      next.log = (st.log || []).concat(san(st, mv, legal, next));
      return next;
    },
    status(st) {
      const moves = legalMoves(st);
      const check = inCheck(st);
      if (!moves.length) {
        return check
          ? { over: true, winner: st.turn === 'w' ? 1 : 0, reason: 'checkmate' }
          : { over: true, winner: null, reason: 'stalemate' };
      }
      if (insufficient(st.board)) return { over: true, winner: null, reason: 'insufficient' };
      if (st.half >= 100) return { over: true, winner: null, reason: 'fifty' };
      return { over: false, turn: st.turn === 'w' ? 0 : 1, check };
    },
    squareName: name,
  };

  // ------------------------------------------------------------------ tic-tac-toe
  const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const ttt = {
    title: 'Tic-tac-toe',
    init: () => ({ cells: new Array(9).fill(null), turn: 0, last: null }),
    apply(st, m, player) {
      if (player !== st.turn) throw new Error('Not your turn');
      const i = Number(m.cell);
      if (!Number.isInteger(i) || i < 0 || i > 8 || st.cells[i] !== null) throw new Error('Illegal move');
      const cells = st.cells.slice();
      cells[i] = player;
      return { cells, turn: 1 - player, last: i };
    },
    status(st) {
      for (const line of LINES) {
        const [a, b, c] = line;
        if (st.cells[a] !== null && st.cells[a] === st.cells[b] && st.cells[a] === st.cells[c]) {
          return { over: true, winner: st.cells[a], reason: 'line', line };
        }
      }
      if (st.cells.every((c) => c !== null)) return { over: true, winner: null, reason: 'full' };
      return { over: false, turn: st.turn };
    },
  };

  // ------------------------------------------------------------------ connect four (7 columns × 6 rows)
  const C4W = 7;
  const C4H = 6;
  const c4 = {
    title: 'Connect Four',
    init: () => ({ cells: new Array(C4W * C4H).fill(null), turn: 0, last: null }),
    apply(st, m, player) {
      if (player !== st.turn) throw new Error('Not your turn');
      const col = Number(m.col);
      if (!Number.isInteger(col) || col < 0 || col >= C4W) throw new Error('Illegal move');
      let row = -1;
      for (let r = 0; r < C4H; r++) if (st.cells[r * C4W + col] === null) { row = r; break; }
      if (row < 0) throw new Error('Column is full');
      const cells = st.cells.slice();
      cells[row * C4W + col] = player;
      return { cells, turn: 1 - player, last: row * C4W + col };
    },
    status(st) {
      const at = (c, r) => (c >= 0 && c < C4W && r >= 0 && r < C4H ? st.cells[r * C4W + c] : null);
      for (let r = 0; r < C4H; r++) {
        for (let c = 0; c < C4W; c++) {
          const p = at(c, r);
          if (p === null) continue;
          for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
            const line = [0, 1, 2, 3].map((k) => [c + dc * k, r + dr * k]);
            if (line.every(([cc, rr]) => at(cc, rr) === p)) {
              return { over: true, winner: p, reason: 'line', line: line.map(([cc, rr]) => rr * C4W + cc) };
            }
          }
        }
      }
      if (st.cells.every((x) => x !== null)) return { over: true, winner: null, reason: 'full' };
      return { over: false, turn: st.turn };
    },
    width: C4W,
    height: C4H,
  };

  // ------------------------------------------------------------------ checkers (English draughts)
  // Squares are r * 8 + c with r = 0 on player 0's side; only dark squares
  // ((r + c) even) are used. Player 0 ("Black") moves first, up the board.
  // 'b' / 'B' are player 0's man / king, 'r' / 'R' player 1's.
  const DRAW_PLIES = 80; // 40 moves each with no capture and no man moved

  function ckOwner(p) {
    if (!p) return null;
    return p.toLowerCase() === 'b' ? 0 : 1;
  }

  function ckDirs(p) {
    if (p === 'B' || p === 'R') return [[1, -1], [1, 1], [-1, -1], [-1, 1]];
    return p === 'b' ? [[1, -1], [1, 1]] : [[-1, -1], [-1, 1]];
  }

  // All capture sequences for the piece on `from`. A man that reaches the far
  // row during a capture is crowned and the turn ends there.
  function ckJumps(board, from, piece, path, taken) {
    const r = from >> 3;
    const c = from & 7;
    const out = [];
    for (const [dr, dc] of ckDirs(piece)) {
      const mr = r + dr;
      const mc = c + dc;
      const lr = r + 2 * dr;
      const lc = c + 2 * dc;
      if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
      const mid = mr * 8 + mc;
      const land = lr * 8 + lc;
      if (taken.includes(mid) || board[land] || ckOwner(board[mid]) !== 1 - ckOwner(piece)) continue;
      const next = path.concat(land);
      const crowned = (piece === 'b' && lr === 7) || (piece === 'r' && lr === 0);
      const more = crowned ? [] : ckJumps(board, land, piece, next, taken.concat(mid));
      if (more.length) out.push(...more);
      else out.push(next);
    }
    return out;
  }

  function ckMoves(st) {
    const jumps = [];
    const steps = [];
    for (let s = 0; s < 64; s++) {
      const p = st.board[s];
      if (ckOwner(p) !== st.turn) continue;
      // Clear the starting square so a king may jump back across it.
      const board = st.board.slice();
      board[s] = null;
      jumps.push(...ckJumps(board, s, p, [s], []));
      for (const [dr, dc] of ckDirs(p)) {
        const r = (s >> 3) + dr;
        const c = (s & 7) + dc;
        if (r >= 0 && r < 8 && c >= 0 && c < 8 && !st.board[r * 8 + c]) steps.push([s, r * 8 + c]);
      }
    }
    return jumps.length ? jumps : steps; // captures are compulsory
  }

  // Checkers square numbers 1-32: player 0 starts on 1-12, player 1 on 21-32.
  function ckNumber(s) {
    return (s >> 3) * 4 + Math.floor((s & 7) / 2) + 1;
  }

  const checkers = {
    title: 'Checkers',
    init() {
      const board = new Array(64).fill(null);
      for (let s = 0; s < 64; s++) {
        const r = s >> 3;
        if (((r + (s & 7)) % 2) !== 0) continue;
        if (r <= 2) board[s] = 'b';
        if (r >= 5) board[s] = 'r';
      }
      return { board, turn: 0, quiet: 0, last: null, log: [] };
    },
    legalMoves: ckMoves,
    number: ckNumber,
    // m = { path: [from, to, ...] }
    apply(st, m, player) {
      if (player !== st.turn) throw new Error('Not your turn');
      const path = Array.isArray(m.path) ? m.path.map(Number) : [];
      const legal = ckMoves(st).find((x) => x.length === path.length && x.every((v, i) => v === path[i]));
      if (!legal) throw new Error('Illegal move');
      const board = st.board.slice();
      let piece = board[path[0]];
      board[path[0]] = null;
      let captured = 0;
      for (let i = 1; i < path.length; i++) {
        if (Math.abs((path[i] >> 3) - (path[i - 1] >> 3)) === 2) {
          board[(path[i] + path[i - 1]) / 2] = null;
          captured++;
        }
      }
      const end = path[path.length - 1];
      const manMoved = piece === 'b' || piece === 'r';
      if (piece === 'b' && end >> 3 === 7) piece = 'B';
      if (piece === 'r' && end >> 3 === 0) piece = 'R';
      board[end] = piece;
      const sep = captured ? 'x' : '-';
      return {
        board,
        turn: 1 - st.turn,
        quiet: captured || manMoved ? 0 : st.quiet + 1,
        last: path,
        log: (st.log || []).concat(path.map(ckNumber).join(sep)),
      };
    },
    status(st) {
      if (!ckMoves(st).length) return { over: true, winner: 1 - st.turn, reason: 'blocked' };
      if (st.quiet >= DRAW_PLIES) return { over: true, winner: null, reason: 'quiet' };
      return { over: false, turn: st.turn };
    },
  };

  // ------------------------------------------------------------------ tetris battle
  // Played in real time in its own window. Only the result is stored here:
  // a player sends { ko: true } when they top out.
  const tetris = {
    title: 'Tetris Battle',
    realtime: true,
    init: () => ({ ko: null }),
    apply(st, m, player) {
      if (!m.ko || st.ko !== null) throw new Error('Illegal move');
      return { ko: player };
    },
    status(st) {
      return st.ko === null ? { over: false, turn: null } : { over: true, winner: 1 - st.ko, reason: 'ko' };
    },
  };

  const RULES = { chess, checkers, ttt, c4, tetris };

  // Accepts a clock from the network only if it is sensible.
  function cleanClock(c) {
    if (!c || typeof c !== 'object') return null;
    const base = Math.round(Number(c.base));
    const inc = Math.round(Number(c.inc) || 0);
    if (!(base >= 15000 && base <= 3 * 3600000) || !(inc >= 0 && inc <= 60000)) return null;
    return { base, inc };
  }

  // Can this side still give checkmate? (Losing on time against a lone king is a draw.)
  function canMate(board, white) {
    return board.some((x) => x && x.toLowerCase() !== 'k' && (x === x.toUpperCase()) === white);
  }

  // Replays a game. Throws if any entry breaks the rules. `options` is the
  // game record's settings (its clock).
  function replay(type, entries, options) {
    const rules = RULES[type];
    if (!rules) throw new Error('Unknown game');
    const clock = type === 'chess' && options ? cleanClock(options.clock) : null;
    const left = clock ? [clock.base, clock.base] : null;
    const moved = [0, 0];
    let state = rules.init();
    let status = rules.status(state);
    let drawOffer = null;
    let ended = null; // { winner, reason } for resignations and agreed draws
    for (const e of entries || []) {
      const p = e.p;
      if (p !== 0 && p !== 1) throw new Error('Bad player');
      if (ended || status.over) throw new Error('Game is over');
      const m = e.m || {};
      if (m.timeout) {
        if (!clock) throw new Error('This game has no clock');
        const loser = status.turn;
        ended = canMate(state.board, loser === 1)
          ? { over: true, winner: 1 - loser, reason: 'timeout' }
          : { over: true, winner: null, reason: 'timeoutDraw' };
        left[loser] = 0;
      } else if (m.resign) {
        ended = { over: true, winner: 1 - p, reason: 'resign' };
      } else if (m.draw === 'offer') {
        if (drawOffer !== null) throw new Error('Draw already offered');
        drawOffer = p;
      } else if (m.draw === 'accept') {
        if (drawOffer !== 1 - p) throw new Error('No draw offer to accept');
        ended = { over: true, winner: null, reason: 'agreed' };
      } else if (m.draw === 'decline') {
        if (drawOffer !== 1 - p) throw new Error('No draw offer to decline');
        drawOffer = null;
      } else {
        state = rules.apply(state, m, p);
        status = rules.status(state);
        drawOffer = null;
        if (clock) {
          if (moved[p] > 0) left[p] = Math.max(0, left[p] - Math.max(0, Math.min(Number(e.t) || 0, 86400000)));
          left[p] += clock.inc;
          moved[p]++;
        }
      }
    }
    const final = ended || status;
    // Whose clock runs now: nobody's before their first move or after the end.
    const running = clock && !final.over && moved[final.turn] > 0 ? final.turn : null;
    return { state, status: final, drawOffer, clock: clock ? { ...clock, left, running } : null };
  }

  // Checks that `entry` may be added to the game; returns the new result.
  function play(type, entries, entry, options) {
    return replay(type, (entries || []).concat(entry), options);
  }

  const Games = { RULES, replay, play, cleanClock, TYPES: Object.keys(RULES) };
  if (typeof module !== 'undefined' && module.exports) module.exports = Games;
  else root.Games = Games;
}(typeof window !== 'undefined' ? window : globalThis));
