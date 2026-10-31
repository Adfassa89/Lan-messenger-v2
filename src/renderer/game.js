'use strict';
/* global Games, api, el, esc, t, call, S, peerName, confirmModal, avatarHtml, $ */
// Games inside private chats: the card shown in the chat, and the game
// window with the interactive board.

const Game = (() => {
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const TITLES = { chess: 'Chess', checkers: 'Checkers', ttt: 'Tic-tac-toe', c4: 'Connect Four', tetris: 'Tetris Battle' };
  const ICONS = { chess: '♞', checkers: '⛀', ttt: '#', c4: '●', tetris: '▦' };
  const ABOUT = {
    chess: 'Pick your side and a time control, like on chess.com',
    checkers: 'Captures are compulsory, kings move both ways; clocks optional',
    ttt: 'Three in a row wins',
    c4: 'Four in a row wins',
    tetris: 'Real-time battle: clear lines to send garbage',
  };
  let open = null; // { conv, id, back, selected }

  // Game preferences, kept per PC: last time control and side chosen,
  // premoves and game sounds.
  const PREFS_KEY = 'lanmsg.games.v1';
  const prefs = { clock: 'none', ckClock: 'none', side: 'random', bestOf: 3, premoves: true, sounds: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* defaults */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* not saved */ } };

  // Time controls: minutes + increment seconds. Chess like chess.com.
  // Checkers: the draughts federation's blitz 3|2 and rapid 5|3, and the
  // English draughts (checkers) 3|3 blitz, 12|5 rapid and 45|20 classical.
  const CLOCKS = {
    chess: [
      ['Bullet', ['1+0', '1+1', '2+1']],
      ['Blitz', ['3+0', '3+2', '5+0']],
      ['Rapid', ['10+0', '15+10', '30+0']],
    ],
    checkers: [
      ['Bullet', ['1+0', '1+1', '2+1']],
      ['Blitz', ['3+2', '3+3', '5+2']],
      ['Rapid', ['5+3', '10+5', '12+5']],
      ['Classical', ['45+20']],
    ],
  };
  const clockPref = (type) => (type === 'chess' ? 'clock' : 'ckClock');
  const clockFromKey = (k) => {
    const m = /^(\d+)\+(\d+)$/.exec(k || '');
    return m ? { base: Number(m[1]) * 60000, inc: Number(m[2]) * 1000 } : null;
  };
  const clockLabel = (c) => {
    if (!c) return t('No time limit');
    return c.inc ? `${c.base / 60000} | ${c.inc / 1000}` : t('{n} min', { n: c.base / 60000 });
  };
  function fmtClock(ms) {
    const v = Math.max(0, ms);
    const s = Math.floor(v / 1000);
    const two = (n) => String(n).padStart(2, '0');
    if (v >= 3600000) return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    if (v >= 20000) return `${Math.floor(s / 60)}:${two(s % 60)}`;
    return `${Math.floor(s / 60)}:${two(s % 60)}.${Math.floor((v % 1000) / 100)}`;
  }
  // The running clock ticks without redrawing the whole window.
  function startTicker(modal, msg, r) {
    clearInterval(open.ticker);
    if (!r.clock || r.clock.running === null) return;
    const i = r.clock.running;
    const me = myIndex(msg);
    const box = modal.querySelector(`.cc-clock[data-clock="${i}"]`);
    if (!box) return;
    open.ticker = setInterval(() => {
      const left = clockLeft(msg, r, i);
      box.lastChild.textContent = fmtClock(left);
      box.classList.toggle('low', left < 20000);
      if (i === me && left < 10000 && left > 0 && open.warned !== msg.id) {
        open.warned = msg.id; // "ten seconds left", once per game
        Sfx.play('lowtime');
      }
    }, 100);
  }

  // Time left on a player's clock right now.
  function clockLeft(msg, r, i) {
    if (!r.clock) return 0;
    const running = r.clock.running === i ? Date.now() - (msg.game.at || msg.ts) : 0;
    return Math.max(0, r.clock.left[i] - running);
  }

  function result(msg) {
    try {
      return Games.replay(msg.game.type, msg.game.moves, msg.game);
    } catch {
      return null;
    }
  }

  function myIndex(msg) {
    return msg.game.players.indexOf(S.me.id);
  }

  // Piece pictures come from pieces.css (classes wk, bq, ...).
  function pieceHtml(p, extra = '') {
    if (!p) return '';
    const white = p === p.toUpperCase();
    return `<span class="pc ${white ? 'w' : 'b'}${p.toLowerCase()}${extra ? ` ${extra}` : ''}"></span>`;
  }

  function sideName(msg, i) {
    const id = msg.game.players[i];
    return id === S.me.id ? t('You') : peerName(id);
  }

  function colorName(type, i) {
    if (type === 'chess') return i === 0 ? t('White') : t('Black');
    if (type === 'checkers') return i === 0 ? t('Black') : t('Red');
    if (type === 'tetris') return i === 0 ? t('Player 1') : t('Player 2');
    if (type === 'ttt') return i === 0 ? '✕' : '◯';
    return i === 0 ? t('Red') : t('Yellow');
  }

  function reasonText(st) {
    return {
      checkmate: t('Checkmate'), stalemate: t('Stalemate'), insufficient: t('Not enough pieces to win'),
      fifty: t('50-move rule'), resign: t('Resigned'), agreed: t('Draw agreed'), line: '', full: t('Board full'),
      blocked: t('No moves left'), quiet: t('40 moves without a capture'), ko: 'K.O.',
      timeout: t('Time out'), timeoutDraw: t('Time out against a lone king'),
    }[st.reason] || '';
  }

  function statusText(msg, r) {
    if (!r) return t('This game could not be loaded');
    const me = myIndex(msg);
    const st = r.status;
    if (st.over) {
      const why = reasonText(st);
      let head;
      if (st.winner === null) head = t('Draw');
      else if (st.winner === me) head = t('You won! 🎉');
      else head = t('{name} won', { name: sideName(msg, st.winner) });
      return why ? `${head} · ${why}` : head;
    }
    if (r.drawOffer !== null && r.drawOffer !== undefined) {
      return r.drawOffer === me ? t('Draw offered – waiting for an answer') : t('{name} offers a draw', { name: sideName(msg, r.drawOffer) });
    }
    if (msg.game.type === 'tetris') {
      const w = r.state.wins || [0, 0];
      const mine = me < 0 ? 0 : me;
      return w[0] + w[1] ? t('Score {a} – {b}', { a: w[mine], b: w[1 - mine] }) : t('Battle ready – both players press Play');
    }
    const turn = st.turn;
    const check = st.check ? ` · ${t('Check!')}` : '';
    return (turn === me ? t('Your turn') : t('Waiting for {name}', { name: sideName(msg, turn) })) + check;
  }

  // ------------------------------------------------------------------ boards
  function chessBoard(msg, r, { interactive, selected, targets, marks, premove } = {}) {
    const st = r.state;
    const flip = myIndex(msg) === 1;
    const kingInCheck = r.status.check || r.status.reason === 'checkmate'
      ? st.board.indexOf(st.turn === 'w' ? 'K' : 'k') : -1;
    let html = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = flip ? row : 7 - row;
        const file = flip ? 7 - col : col;
        const s = rank * 8 + file;
        const cls = ['sq', (rank + file) % 2 ? 'light' : 'dark'];
        if (st.last && (st.last.from === s || st.last.to === s)) cls.push('last');
        if (s === selected) cls.push('sel');
        if (targets && targets.has(s)) cls.push(st.board[s] ? 'cap' : 'dot');
        if (s === kingInCheck) cls.push('check');
        if (premove && (premove.from === s || premove.to === s)) cls.push('pre');
        if (marks && marks.sq.has(s)) cls.push('mark');
        // Coordinates sit inside the edge squares, like on chess.com.
        const coords = `${col === 0 ? `<i class="rk">${rank + 1}</i>` : ''}${row === 7 ? `<i class="fl">${'abcdefgh'[file]}</i>` : ''}`;
        html += `<div class="${cls.join(' ')}" ${interactive ? `data-sq="${s}"` : ''}>${pieceHtml(st.board[s])}${coords}</div>`;
      }
    }
    return `<div class="board chess">${html}</div>`;
  }

  function tttBoard(msg, r, { interactive } = {}) {
    const line = new Set(r.status.line || []);
    return `<div class="board ttt">${r.state.cells.map((c, i) => `<div class="cell${line.has(i) ? ' win' : ''}${r.state.last === i ? ' last' : ''}" ${interactive && c === null ? `data-cell="${i}"` : ''}>${c === null ? '' : `<span class="mark p${c}">${c === 0 ? '✕' : '◯'}</span>`}</div>`).join('')}</div>`;
  }

  function c4Board(msg, r, { interactive } = {}) {
    const { width, height } = Games.RULES.c4;
    const line = new Set(r.status.line || []);
    let html = '';
    for (let row = height - 1; row >= 0; row--) {
      for (let col = 0; col < width; col++) {
        const i = row * width + col;
        const c = r.state.cells[i];
        html += `<div class="hole" ${interactive ? `data-col="${col}"` : ''}>${c === null ? '' : `<span class="disc p${c}${line.has(i) ? ' win' : ''}${r.state.last === i ? ' last' : ''}"></span>`}</div>`;
      }
    }
    return `<div class="board c4">${html}</div>`;
  }

  // Checkers board. `view` is the board to draw (it can show a capture
  // sequence that is still being entered), `path` the squares chosen so far.
  function checkersBoard(msg, r, { interactive, view, path = [], targets } = {}) {
    const board = view || r.state.board;
    const flip = myIndex(msg) === 1;
    const last = new Set(path.length ? [] : r.state.last || []);
    let html = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const rank = flip ? row : 7 - row;
        const file = flip ? 7 - col : col;
        const s = rank * 8 + file;
        const dark = (rank + file) % 2 === 0;
        const cls = ['sq', 'ck-sq', dark ? 'dark' : 'light'];
        if (last.has(s) || path.includes(s)) cls.push('last');
        if (targets && targets.has(s)) cls.push('dot');
        const p = board[s];
        const piece = p ? `<span class="ck-piece ${p.toLowerCase() === 'b' ? 'p0' : 'p1'}${p === p.toUpperCase() ? ' king' : ''}"></span>` : '';
        html += `<div class="${cls.join(' ')}" ${interactive && dark ? `data-ck="${s}"` : ''}>${piece}</div>`;
      }
    }
    return `<div class="board chess checkers">${html}</div>`;
  }

  function boardHtml(msg, r, opts) {
    if (msg.game.type === 'chess') return chessBoard(msg, r, opts);
    if (msg.game.type === 'checkers') return checkersBoard(msg, r, opts);
    if (msg.game.type === 'tetris') return '';
    if (msg.game.type === 'ttt') return tttBoard(msg, r, opts);
    return c4Board(msg, r, opts);
  }

  // ------------------------------------------------------------------ chat card
  function cardHtml(msg) {
    if (msg.game.type === 'warlock') {
      const host = msg.from === S.me.id ? t('You') : esc(msg.fromName || peerName(msg.from));
      return `<div class="game-card warlock-card">
        <div class="wl-card-art"><span>🔥</span></div>
        <div class="gc-head"><div><b>Warlock</b><div class="gc-players">${esc(t('{name} opened an arena. Knock everyone into the lava!', { name: host }))}</div></div></div>
        <button class="fbtn wl-join" data-act="game">${esc(t('Join the arena'))}</button>
      </div>`;
    }
    const r = result(msg);
    const me = myIndex(msg);
    const myTurn = r && !r.status.over && r.status.turn === me;
    const players = [0, 1].map((i) => `${esc(sideName(msg, i))} <small>(${esc(colorName(msg.game.type, i))})</small>`).join(` ${esc(t('vs'))} `);
    return `<div class="game-card">
      <div class="gc-head"><span class="gc-icon">${ICONS[msg.game.type]}</span><div><b>${esc(t(TITLES[msg.game.type]))}</b>${msg.game.clock ? ` <span class="gc-clock">⏱ ${esc(clockLabel(msg.game.clock))}</span>` : ''}${msg.game.bestOf > 1 ? ` <span class="gc-clock">${esc(t('Best of {n}', { n: msg.game.bestOf }))}</span>` : ''}<div class="gc-players">${players}</div></div></div>
      ${r && msg.game.type !== 'tetris' ? `<div class="gc-preview">${boardHtml(msg, r)}</div>` : ''}
      ${msg.game.type === 'tetris' ? '<div class="gc-tetris"><i class="t1"></i><i class="t2"></i><i class="t3"></i><i class="t4"></i></div>' : ''}
      <div class="gc-status${myTurn ? ' turn' : ''}">${esc(statusText(msg, r))}</div>
      <button class="fbtn" data-act="game">${esc(myTurn || (msg.game.type === 'tetris' && r && !r.status.over) ? t('Play') : t('Open'))}</button>
    </div>`;
  }

  // ------------------------------------------------------------------ game window
  function show(conv, id) {
    const m = (S.msgs.get(conv) || []).find((x) => x.id === id);
    if (m && m.game && m.game.type === 'warlock') {
      call(api.openWarlock(conv, id));
      return;
    }
    if (m && m.game && m.game.type === 'tetris') {
      call(api.openTetris(conv, id));
      return;
    }
    close();
    const back = el('div', 'modal-back game-back');
    // Decided on pointerdown: a click on the board can redraw it, and the
    // mousedown that follows would then look like a click on the backdrop.
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    $('#modalRoot').append(back);
    open = { conv, id, back, selected: null };
    document.addEventListener('keydown', onKey, true);
    render();
  }

  function onKey(e) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      if (open.promo) {
        open.promo = null;
        render();
      } else close();
    }
  }

  function close() {
    if (!open) return;
    clearInterval(open.ticker);
    EndFx.close();
    leave(open.back);
    open = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function current() {
    if (!open) return null;
    return (S.msgs.get(open.conv) || []).find((m) => m.id === open.id) || null;
  }

  // ------------------------------------------------------------------ chess window (chess.com style)
  // Pieces each side has taken, and who is ahead on material.
  function material(board) {
    const left = { w: {}, b: {} };
    let score = 0;
    for (const p of board) {
      if (!p) continue;
      const c = p === p.toUpperCase() ? 'w' : 'b';
      const k = p.toLowerCase();
      left[c][k] = (left[c][k] || 0) + 1;
      score += (c === 'w' ? 1 : -1) * VALUE[k];
    }
    const taken = (c) => Object.entries(START_COUNT)
      .flatMap(([k, n]) => new Array(Math.max(0, n - (left[c][k] || 0))).fill(c === 'w' ? k.toUpperCase() : k));
    // White's captures are black pieces and the other way round.
    return { byWhite: taken('b'), byBlack: taken('w'), score };
  }

  function playerBar(msg, r, i) {
    const id = msg.game.players[i];
    const me = myIndex(msg);
    const mat = material(r.state.board);
    const caps = i === 0 ? mat.byWhite : mat.byBlack;
    const order = 'pnbrq';
    caps.sort((a, b) => order.indexOf(a.toLowerCase()) - order.indexOf(b.toLowerCase()));
    const adv = i === 0 ? mat.score : -mat.score;
    const moving = !r.status.over && r.status.turn === i;
    const peer = S.peers.get(id);
    let clock;
    if (r.clock) {
      const left = clockLeft(msg, r, i);
      clock = `<div class="cc-clock timed${r.clock.running === i ? ' on' : ''}${left < 20000 ? ' low' : ''}" data-clock="${i}">${pieceHtml(i === 0 ? 'K' : 'k')}<span>${fmtClock(left)}</span></div>`;
    } else {
      clock = `<div class="cc-clock${moving ? ' on' : ''}">${pieceHtml(i === 0 ? 'K' : 'k')}<span>${esc(moving ? (i === me ? t('Your turn') : t('To move')) : (i === 0 ? t('White') : t('Black')))}</span></div>`;
    }
    return `<div class="cc-player">
      ${avatarHtml('direct', id, id === S.me.id ? S.me.name : (peer ? peer.name : ''), null, 'cc-avatar')}
      <div class="cc-who"><div class="cc-name">${esc(id === S.me.id ? S.me.name : peerName(id))}${i === me ? ` <span class="cc-you">(${esc(t('You'))})</span>` : ''}</div>
        <div class="cc-captured">${caps.map((p) => pieceHtml(p)).join('')}${adv > 0 ? `<span class="cc-adv">+${adv}</span>` : ''}</div></div>
      ${clock}
    </div>`;
  }

  function movesHtml(r) {
    const log = r.state.log || [];
    if (!log.length) return `<div class="cc-empty">${esc(t('No moves yet'))}</div>`;
    // Piece letters become small piece pictures ("figurines"), as on chess.com.
    const fig = (san, white) => esc(san).replace(/^([KQRBN])/, (k) => pieceHtml(white ? k : k.toLowerCase(), 'mini'));
    let html = '';
    for (let i = 0; i < log.length; i += 2) {
      const cur = (j) => (j === log.length - 1 ? ' cur' : '');
      html += `<div class="cc-row"><span class="cc-num">${i / 2 + 1}.</span>
        <span class="cc-mv${cur(i)}">${fig(log[i], true)}</span>
        <span class="cc-mv${cur(i + 1)}">${log[i + 1] ? fig(log[i + 1], false) : ''}</span></div>`;
    }
    return html;
  }

  function renderChess(msg, r) {
    const me = myIndex(msg);
    const over = r.status.over;
    const myTurn = !over && r.status.turn === me;
    const offerFromOther = !over && r.drawOffer === 1 - me;
    const opp = 1 - (me < 0 ? 0 : me);
    const self = me < 0 ? 0 : me;
    const C = Games.RULES.chess;
    // A queued premove plays as soon as it is our turn, if it is still legal.
    if (open.premove && (myTurn || over)) {
      const pm = open.premove;
      open.premove = null;
      const legal = !over && C.legalMoves(r.state).find((mv) => mv.from === pm.from && mv.to === pm.to);
      if (legal) setTimeout(() => move({ from: C.squareName(pm.from), to: C.squareName(pm.to), ...(legal.promo ? { promo: 'q' } : {}) }), 50);
    }
    // Right-click marks and arrows are cleared when the position changes.
    if (open.seen !== msg.game.moves.length) {
      open.seen = msg.game.moves.length;
      open.marks = { sq: new Set(), arrows: [] };
    }
    open.back.innerHTML = `<div class="modal game-modal chesscom${open.drawn ? ' still' : ''}">
      <div class="modal-head"><h2>${esc(t('Chess'))}</h2>${settingsHtml(true)}<button class="icon-btn" data-close title="${esc(t('Close'))}">✕</button></div>
      <div class="cc-body">
        <div class="cc-left">
          ${playerBar(msg, r, opp)}
          <div class="game-board-wrap">${chessBoard(msg, r, { interactive: me >= 0 && !over, marks: open.marks, premove: open.premove })}${arrowsSvg(me === 1, open.marks)}
            ${open.promo ? `<div class="promo">${'qnrb'.split('').map((p) => `<button data-promo="${p}">${pieceHtml(me === 0 ? p.toUpperCase() : p)}</button>`).join('')}</div>` : ''}
          </div>
          ${playerBar(msg, r, self)}
        </div>
        <div class="cc-panel">
          <div class="cc-status${myTurn ? ' turn' : ''}${over ? ' over' : ''}">${esc(statusText(msg, r))}</div>
          ${offerFromOther ? `<div class="cc-offer"><span>½ ${esc(t('Accept the draw?'))}</span><button class="cc-btn green" data-draw="accept">${esc(t('Accept'))}</button><button class="cc-btn" data-draw="decline">${esc(t('Decline'))}</button></div>` : ''}
          <div class="cc-moves">${movesHtml(r)}</div>
          <div class="cc-actions">
            ${!over && r.drawOffer === null ? `<button class="cc-btn" data-action="draw" title="${esc(t('Offer draw'))}">½ ${esc(t('Draw'))}</button>` : ''}
            ${!over ? `<button class="cc-btn" data-action="resign" title="${esc(t('Resign'))}">⚑ ${esc(t('Resign'))}</button>` : `<button class="cc-btn green" data-action="rematch">${esc(t('New game'))}</button>`}
          </div>
        </div>
      </div></div>`;
    const modal = open.back.querySelector('.game-modal');
    open.drawn = true; // only the first drawing animates in
    modal.querySelector('[data-close]').onclick = close;
    modal.addEventListener('click', (e) => onClick(e, msg, r));
    const list = modal.querySelector('.cc-moves');
    list.scrollTop = list.scrollHeight;
    startTicker(modal, msg, r);
    if (me >= 0 && !over && !open.promo) bindChessBoard(modal.querySelector('.board.chess'), msg, r);
    if (open.selected !== null) showTargets(modal, r, open.selected, pieceMoves(msg, r, open.selected));
  }

  // Where a piece can go: its legal moves on our turn; otherwise where it
  // could go next turn (for looking ahead and premoves).
  function pieceMoves(msg, r, from) {
    const C = Games.RULES.chess;
    const st = r.state;
    const me = myIndex(msg);
    if (!r.status.over && r.status.turn === me) return C.legalMoves(st).filter((mv) => mv.from === from);
    const color = me === 0 ? 'w' : 'b';
    const list = C.legalMoves({ ...st, turn: color, ep: null }).filter((mv) => mv.from === from);
    // A pawn may premove a capture: an enemy piece may be on that square by then.
    const p = st.board[from];
    if (p && p.toLowerCase() === 'p') {
      for (const df of [-1, 1]) {
        const f = (from & 7) + df;
        const to = from + (color === 'w' ? 8 : -8) + df;
        const occ = st.board[to];
        const ownPiece = occ && (occ === occ.toUpperCase()) === (color === 'w');
        if (f >= 0 && f < 8 && to >= 0 && to < 64 && !ownPiece && !list.some((mv) => mv.to === to)) list.push({ from, to });
      }
    }
    return list;
  }

  function showTargets(root, r, from, moves = []) {
    for (const e of root.querySelectorAll('.sq.sel, .sq.dot, .sq.cap')) e.classList.remove('sel', 'dot', 'cap');
    if (from === null) return;
    const sqEl = (s) => root.querySelector(`.sq[data-sq="${s}"]`);
    if (sqEl(from)) sqEl(from).classList.add('sel');
    for (const mv of moves) {
      if (sqEl(mv.to)) sqEl(mv.to).classList.add(r.state.board[mv.to] || mv.ep ? 'cap' : 'dot');
    }
  }

  // Right-drag arrows, drawn over the board (knight moves bend like an L).
  function arrowsSvg(flip, marks) {
    if (!marks || !marks.arrows.length) return '';
    const pt = (s) => [(flip ? 7 - (s & 7) : (s & 7)) + 0.5, (flip ? (s >> 3) : 7 - (s >> 3)) + 0.5];
    const shapes = marks.arrows.map(([a, b]) => {
      const [x1, y1] = pt(a);
      const [x2, y2] = pt(b);
      const ax = Math.abs(x2 - x1);
      const ay = Math.abs(y2 - y1);
      const knight = (ax === 1 && ay === 2) || (ax === 2 && ay === 1);
      const corner = knight ? (ax > ay ? [x2, y1] : [x1, y2]) : [x1, y1];
      const len = Math.hypot(x2 - corner[0], y2 - corner[1]);
      const ux = (x2 - corner[0]) / len;
      const uy = (y2 - corner[1]) / len;
      const tip = [x2 + ux * 0.12, y2 + uy * 0.12]; // the point sits just past the square's centre
      const base = [tip[0] - ux * 0.42, tip[1] - uy * 0.42];
      const head = [[tip[0], tip[1]], [base[0] - uy * 0.26, base[1] + ux * 0.26], [base[0] + uy * 0.26, base[1] - ux * 0.26]];
      const start = knight ? [x1, y1] : [x1 + ux * 0.25, y1 + uy * 0.25];
      const pts = knight ? `${start} ${corner} ${base}` : `${start} ${base}`;
      return `<polyline points="${pts}"/><polygon points="${head.map((p) => p.join(',')).join(' ')}"/>`;
    }).join('');
    return `<svg class="cc-arrows" viewBox="0 0 8 8" aria-hidden="true">${shapes}</svg>`;
  }

  // ⚙ in the chess window: premoves and game sounds.
  function settingsHtml(chess) {
    const sw = (k, label) => `<label class="gset-row"><span>${esc(label)}</span><input type="checkbox" data-pref="${k}"${prefs[k] ? ' checked' : ''}></label>`;
    return `<div class="gset"><button class="icon-btn gset-btn" data-action="settings" title="${esc(t('Settings'))}">⚙</button>
      ${open && open.settings ? `<div class="gset-pop">${chess ? sw('premoves', t('Premoves (move before your turn)')) : ''}${sw('sounds', t('Game sounds'))}</div>` : ''}</div>`;
  }

  // Click-to-move and drag-and-drop on the chess board; right-click marks.
  function bindChessBoard(board, msg, r) {
    const st = r.state;
    const me = myIndex(msg);
    const C = Games.RULES.chess;
    const myTurn = !r.status.over && r.status.turn === me;
    const mine = (s) => st.board[s] && ((st.board[s] === st.board[s].toUpperCase()) === (me === 0));
    const sqAt = (x, y) => {
      const e = document.elementFromPoint(x, y);
      const sq = e && e.closest('.board.chess [data-sq]');
      return sq ? Number(sq.dataset.sq) : null;
    };
    const tryMove = (from, to) => {
      const legal = pieceMoves(msg, r, from).filter((mv) => mv.to === to);
      if (!legal.length) return false;
      if (!myTurn) {
        // Not our turn: queue it as a premove (if they are switched on).
        if (!prefs.premoves) return false;
        open.premove = { from, to };
        open.selected = null;
        Sfx.play('premove');
        render();
        return true;
      }
      const m = { from: C.squareName(from), to: C.squareName(to) };
      if (legal[0].promo) {
        open.promo = m;
        open.selected = null;
        render();
      } else {
        move(m);
      }
      return true;
    };
    let drag = null;
    let right = null;
    board.addEventListener('contextmenu', (e) => e.preventDefault());
    board.addEventListener('pointerdown', (e) => {
      const s = sqAt(e.clientX, e.clientY);
      if (e.button === 2) {
        right = s;
        return;
      }
      if (e.button !== 0) return;
      // A left click clears the right-click marks, as on chess.com.
      if (open.marks.sq.size || open.marks.arrows.length) {
        open.marks = { sq: new Set(), arrows: [] };
        board.querySelectorAll('.sq.mark').forEach((x) => x.classList.remove('mark'));
        board.parentElement.querySelector('.cc-arrows')?.remove();
      }
      if (s === null) return;
      if (open.selected !== null && open.selected !== s && tryMove(open.selected, s)) return;
      if (!mine(s)) {
        open.selected = null;
        showTargets(board, r, null);
        return;
      }
      e.preventDefault();
      const sqEl = board.querySelector(`[data-sq="${s}"]`);
      const piece = sqEl.querySelector('.pc');
      const size = sqEl.getBoundingClientRect().width;
      const ghost = el('div', `${piece.className} ghost`);
      ghost.style.width = `${size}px`;
      ghost.style.height = `${size}px`;
      drag = { from: s, x0: e.clientX, y0: e.clientY, ghost, piece, size, moved: false, wasSelected: open.selected === s, hover: null };
      open.selected = s;
      showTargets(board, r, s, pieceMoves(msg, r, s));
      board.setPointerCapture(e.pointerId);
    });
    board.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        document.body.append(drag.ghost);
        drag.piece.style.opacity = '0';
      }
      drag.ghost.style.left = `${e.clientX - drag.size / 2}px`;
      drag.ghost.style.top = `${e.clientY - drag.size / 2}px`;
      const s = sqAt(e.clientX, e.clientY);
      if (s !== drag.hover) {
        board.querySelectorAll('.sq.hover').forEach((x) => x.classList.remove('hover'));
        if (s !== null) board.querySelector(`[data-sq="${s}"]`).classList.add('hover');
        drag.hover = s;
      }
    });
    const finish = (e) => {
      if (e.button === 2 && e.type === 'pointerup') {
        // Right-click a square to mark it, right-drag to draw an arrow.
        const s = sqAt(e.clientX, e.clientY);
        const from = right;
        right = null;
        if (open.premove) {
          open.premove = null;
          render();
          return;
        }
        if (from === null || s === null) return;
        if (from === s) {
          if (!open.marks.sq.delete(s)) open.marks.sq.add(s);
        } else {
          const i = open.marks.arrows.findIndex(([a, b]) => a === from && b === s);
          if (i >= 0) open.marks.arrows.splice(i, 1);
          else open.marks.arrows.push([from, s]);
        }
        render();
        return;
      }
      if (!drag) return;
      const d = drag;
      drag = null;
      d.ghost.remove();
      d.piece.style.opacity = '';
      board.querySelectorAll('.sq.hover').forEach((x) => x.classList.remove('hover'));
      if (d.moved) {
        const s = e.type === 'pointerup' ? sqAt(e.clientX, e.clientY) : null;
        if (s !== null && s !== d.from && tryMove(d.from, s)) return;
        if (s !== null && s !== d.from) Sfx.play('illegal');
      } else if (d.wasSelected) {
        open.selected = null;
        showTargets(board, r, null);
      }
    };
    board.addEventListener('pointerup', finish);
    board.addEventListener('pointercancel', finish);
  }

  // ------------------------------------------------------------------ checkers window
  function checkersBar(msg, r, i) {
    const id = msg.game.players[i];
    const me = myIndex(msg);
    const own = i === 0 ? 'b' : 'r';
    const left = r.state.board.filter((p) => p && p.toLowerCase() === own).length;
    const lost = 12 - left;
    const theirLost = 12 - r.state.board.filter((p) => p && p.toLowerCase() === (own === 'b' ? 'r' : 'b')).length;
    const moving = !r.status.over && r.status.turn === i;
    const peer = S.peers.get(id);
    return `<div class="cc-player">
      ${avatarHtml('direct', id, id === S.me.id ? S.me.name : (peer ? peer.name : ''), null, 'cc-avatar')}
      <div class="cc-who"><div class="cc-name">${esc(id === S.me.id ? S.me.name : peerName(id))}${i === me ? ` <span class="cc-you">(${esc(t('You'))})</span>` : ''}</div>
        <div class="cc-captured">${new Array(theirLost).fill(`<span class="ck-piece mini ${own === 'b' ? 'p1' : 'p0'}"></span>`).join('')}${theirLost > lost ? `<span class="cc-adv">+${theirLost - lost}</span>` : ''}</div></div>
      ${r.clock
    ? `<div class="cc-clock timed${r.clock.running === i ? ' on' : ''}${clockLeft(msg, r, i) < 20000 ? ' low' : ''}" data-clock="${i}"><span class="ck-piece mini ${i === 0 ? 'p0' : 'p1'}"></span><span>${fmtClock(clockLeft(msg, r, i))}</span></div>`
    : `<div class="cc-clock${moving ? ' on' : ''}"><span class="ck-piece mini ${i === 0 ? 'p0' : 'p1'}"></span><span>${esc(moving ? (i === me ? t('Your turn') : t('To move')) : colorName('checkers', i))}</span></div>`}
    </div>`;
  }

  function renderCheckers(msg, r) {
    const me = myIndex(msg);
    const over = r.status.over;
    const myTurn = !over && r.status.turn === me;
    const offerFromOther = !over && r.drawOffer === 1 - me;
    const C = Games.RULES.checkers;
    const path = open.path || [];
    let view = null;
    let targets = null;
    if (myTurn) {
      const legal = C.legalMoves(r.state);
      if (path.length) {
        const cands = legal.filter((m) => path.every((v, i) => m[i] === v));
        targets = new Set(cands.filter((m) => m.length > path.length).map((m) => m[path.length]));
        // Show the piece where it has got to so far, and the pieces it has jumped.
        view = r.state.board.slice();
        const piece = view[path[0]];
        view[path[0]] = null;
        for (let i = 1; i < path.length; i++) {
          if (Math.abs((path[i] >> 3) - (path[i - 1] >> 3)) === 2) view[(path[i] + path[i - 1]) / 2] = null;
        }
        view[path[path.length - 1]] = piece;
      }
    }
    const log = r.state.log || [];
    let moves = '';
    for (let i = 0; i < log.length; i += 2) {
      const cur = (j) => (j === log.length - 1 ? ' cur' : '');
      moves += `<div class="cc-row"><span class="cc-num">${i / 2 + 1}.</span><span class="cc-mv${cur(i)}">${esc(log[i])}</span><span class="cc-mv${cur(i + 1)}">${log[i + 1] ? esc(log[i + 1]) : ''}</span></div>`;
    }
    const opp = 1 - (me < 0 ? 0 : me);
    const self = me < 0 ? 0 : me;
    open.back.innerHTML = `<div class="modal game-modal chesscom${open.drawn ? ' still' : ''}">
      <div class="modal-head"><h2>${esc(t('Checkers'))}</h2>${settingsHtml(false)}<button class="icon-btn" data-close title="${esc(t('Close'))}">✕</button></div>
      <div class="cc-body">
        <div class="cc-left">
          ${checkersBar(msg, r, opp)}
          <div class="game-board-wrap">${checkersBoard(msg, r, { interactive: myTurn, view, path, targets })}</div>
          ${checkersBar(msg, r, self)}
        </div>
        <div class="cc-panel">
          <div class="cc-status${myTurn ? ' turn' : ''}${over ? ' over' : ''}">${esc(statusText(msg, r))}${myTurn && path.length > 1 ? ` · ${esc(t('Keep jumping'))}` : ''}</div>
          ${offerFromOther ? `<div class="cc-offer"><span>½ ${esc(t('Accept the draw?'))}</span><button class="cc-btn green" data-draw="accept">${esc(t('Accept'))}</button><button class="cc-btn" data-draw="decline">${esc(t('Decline'))}</button></div>` : ''}
          <div class="cc-moves">${moves || `<div class="cc-empty">${esc(t('No moves yet'))}</div>`}</div>
          <div class="cc-actions">
            ${!over && r.drawOffer === null ? `<button class="cc-btn" data-action="draw">½ ${esc(t('Draw'))}</button>` : ''}
            ${!over ? `<button class="cc-btn" data-action="resign">⚑ ${esc(t('Resign'))}</button>` : `<button class="cc-btn green" data-action="rematch">${esc(t('New game'))}</button>`}
          </div>
        </div>
      </div></div>`;
    const modal = open.back.querySelector('.game-modal');
    open.drawn = true; // only the first drawing animates in
    modal.querySelector('[data-close]').onclick = close;
    modal.addEventListener('click', (e) => onClick(e, msg, r));
    const list = modal.querySelector('.cc-moves');
    list.scrollTop = list.scrollHeight;
    startTicker(modal, msg, r);
    if (myTurn) {
      modal.querySelector('.board').addEventListener('click', (e) => {
        const sq = e.target.closest('[data-ck]');
        if (!sq) return;
        const s = Number(sq.dataset.ck);
        const legal = C.legalMoves(r.state);
        const cur = open.path || [];
        if (cur.length) {
          const next = cur.concat(s);
          const cands = legal.filter((m) => next.every((v, i) => m[i] === v));
          if (cands.length) {
            const done = cands.find((m) => m.length === next.length);
            if (done) {
              open.path = null;
              move({ path: done });
            } else {
              open.path = next;
              render();
            }
            return;
          }
          if (cur.length > 1) return; // in the middle of a capture: finish it first
        }
        open.path = legal.some((m) => m[0] === s) && !(cur.length === 1 && cur[0] === s) ? [s] : null;
        render();
      });
    }
  }

  // Sounds for each new move, and the end screen when the game finishes
  // while the window is open.
  function pieceCount(r) {
    const cells = r.state.board || r.state.cells || [];
    return cells.filter((x) => x !== null && x !== undefined && x !== '').length;
  }

  function moveSound(type, r, before) {
    if (type === 'ttt') return 'place';
    if (type === 'c4') return 'drop';
    if (type === 'chess') {
      const san = (r.state.log || [])[r.state.log.length - 1] || '';
      if (/[+#]/.test(san)) return 'check';
      if (san.startsWith('O-O')) return 'castle';
      if (san.includes('=')) return 'promote';
    }
    return pieceCount(r) < before ? 'capture' : 'move';
  }

  function reactToChange(msg, r) {
    const n = msg.game.moves.length;
    const first = open.count === undefined;
    const prev = open.count;
    open.count = n;
    if (!r) return;
    if (first) {
      if (!n) Sfx.play('start');
      open.wasOver = r.status.over;
    } else if (n > prev) {
      const m = msg.game.moves[n - 1].m || {};
      if (m.draw === 'offer') Sfx.play('notify');
      else if (!m.resign && !m.draw && !m.timeout) Sfx.play(moveSound(msg.game.type, r, open.pieces));
    }
    open.pieces = pieceCount(r);
    if (r.status.over && !open.wasOver) {
      open.wasOver = true;
      setTimeout(() => endScreen(msg.id), 500);
    }
  }

  function endScreen(id) {
    const msg = current();
    if (!msg || msg.id !== id) return;
    const r = result(msg);
    if (!r) return;
    const me = myIndex(msg);
    const st = r.status;
    const outcome = st.winner === null ? 'draw' : st.winner === me ? 'win' : 'lose';
    const title = { win: t('You won!'), lose: t('You lost'), draw: t('Draw') }[outcome];
    EndFx.show({
      outcome,
      title,
      detail: reasonText(st),
      // "Close" closes the game window too; clicking beside the card only
      // hides the card, to look at the final position.
      buttons: [{ label: t('New game'), primary: true, action: () => rematch(msg) }, { label: t('Close'), action: close }],
    });
  }

  // Same settings, colours swapped (as on chess.com).
  function rematch(msg) {
    const conv = open ? open.conv : null;
    if (!conv) return;
    const me = myIndex(msg);
    const options = { side: me === 0 ? 'second' : 'first', clock: msg.game.clock || null };
    call(api.createGame(conv, msg.game.type, options)).then((g) => { if (g) show(conv, g.id); });
  }

  function render() {
    const msg = current();
    if (!open) return;
    if (!msg) return close();
    const r = result(msg);
    reactToChange(msg, r);
    if (msg.game.type === 'chess' && r) return renderChess(msg, r);
    if (msg.game.type === 'checkers' && r) return renderCheckers(msg, r);
    const me = myIndex(msg);
    const type = msg.game.type;
    const over = !r || r.status.over;
    const myTurn = r && !over && r.status.turn === me;
    let targets = null;
    if (type === 'chess' && myTurn && open.selected !== null) {
      targets = new Set(Games.RULES.chess.legalMoves(r.state).filter((mv) => mv.from === open.selected).map((mv) => mv.to));
    }
    const offerFromOther = r && !over && r.drawOffer === 1 - me;
    const log = type === 'chess' && r ? (r.state.log || []) : [];
    const moves = log.map((m, i) => (i % 2 === 0 ? `<li><span>${i / 2 + 1}.</span>${esc(m)}` : ` ${esc(m)}</li>`)).join('');
    const players = [0, 1].map((i) => `<div class="gp${r && !over && r.status.turn === i ? ' active' : ''}">
        <span class="gp-chip p${i} ${type}">${type === 'chess' ? pieceHtml(i === 0 ? 'K' : 'k') : type === 'ttt' ? (i === 0 ? '✕' : '◯') : ''}</span>
        <span>${esc(sideName(msg, i))}</span></div>`).join('');

    open.back.innerHTML = `<div class="modal game-modal${open.drawn ? ' still' : ''}">
      <div class="modal-head"><h2>${ICONS[type]} ${esc(t(TITLES[type]))}</h2>${settingsHtml(false)}<button class="icon-btn" data-close title="${esc(t('Close'))}">✕</button></div>
      <div class="game-body">
        <div class="game-board-wrap">${r ? boardHtml(msg, r, { interactive: myTurn, selected: open.selected, targets }) : ''}
          ${open.promo ? `<div class="promo">${'qrbn'.split('').map((p) => `<button data-promo="${p}">${pieceHtml(me === 0 ? p.toUpperCase() : p)}</button>`).join('')}</div>` : ''}
        </div>
        <div class="game-side">
          <div class="game-players">${players}</div>
          <div class="game-status${myTurn ? ' turn' : ''}">${esc(statusText(msg, r))}</div>
          ${offerFromOther ? `<div class="draw-offer"><span>${esc(t('Accept the draw?'))}</span><button class="btn primary" data-draw="accept">${esc(t('Accept'))}</button><button class="btn" data-draw="decline">${esc(t('Decline'))}</button></div>` : ''}
          ${type === 'chess' ? `<ol class="move-list">${moves || `<li class="empty">${esc(t('No moves yet'))}</li>`}</ol>` : ''}
          <div class="game-actions">
            ${!over && type === 'chess' && r.drawOffer === null ? `<button class="btn" data-action="draw">${esc(t('Offer draw'))}</button>` : ''}
            ${!over ? `<button class="btn danger" data-action="resign">${esc(t('Resign'))}</button>` : `<button class="btn primary" data-action="rematch">${esc(t('New game'))}</button>`}
          </div>
        </div>
      </div></div>`;

    const modal = open.back.querySelector('.game-modal');
    open.drawn = true; // only the first drawing animates in
    modal.querySelector('[data-close]').onclick = close;
    modal.addEventListener('click', (e) => onClick(e, msg, r));
    const list = modal.querySelector('.move-list');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function move(m) {
    const { conv, id } = open;
    open.selected = null;
    open.promo = null;
    open.path = null;
    return call(api.gameMove(conv, id, m));
  }

  function onClick(e, msg, r) {
    const me = myIndex(msg);
    const pref = e.target.closest('[data-pref]');
    if (pref) {
      prefs[pref.dataset.pref] = pref.checked;
      savePrefs();
      return undefined;
    }
    const b = e.target.closest('[data-cell],[data-col],[data-promo],[data-draw],[data-action]');
    if (!b || !r) return;
    if (b.dataset.action === 'settings') {
      open.settings = !open.settings;
      render();
      return undefined;
    }
    if (b.dataset.cell !== undefined) return move({ cell: Number(b.dataset.cell) });
    if (b.dataset.col !== undefined) return move({ col: Number(b.dataset.col) });
    if (b.dataset.draw) return move({ draw: b.dataset.draw });
    if (b.dataset.promo) return move({ ...open.promo, promo: b.dataset.promo });
    if (b.dataset.action === 'resign') {
      return confirmModal(t('Resign this game?'), t('{name} will win the game.', { name: sideName(msg, 1 - me) }), t('Resign'), () => move({ resign: true }));
    }
    if (b.dataset.action === 'draw') return move({ draw: 'offer' });
    if (b.dataset.action === 'rematch') return rematch(msg);
    return undefined;
  }

  function onMessage(conv, msg) {
    if (open && open.id === msg.id) render();
  }

  async function newGameModal(conv) {
    const back = el('div', 'modal-back');
    back.innerHTML = `<div class="modal"><div class="modal-head"><h2>${esc(t('Play a game'))}</h2><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-body"><div class="game-picker">${Games.TYPES.map((type) => `<button class="game-pick" data-type="${type}">
        <span class="gp-icon">${ICONS[type]}</span><b>${esc(t(TITLES[type]))}</b><span>${esc(t(ABOUT[type]))}</span></button>`).join('')}</div>
      <p class="modal-note" style="margin-top:12px">${esc(t('Moves are delivered like messages, so you can also play slowly across shifts.'))}</p></div></div>`;
    const done = () => leave(back);
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(); });
    back.querySelector('[data-close]').onclick = done;
    back.querySelector('.game-picker').onclick = async (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      const type = b.dataset.type;
      if (type === 'chess' || type === 'checkers' || type === 'tetris') return setupView(back, conv, type, done);
      done();
      const g = await call(api.createGame(conv, type));
      if (g) setTimeout(() => show(conv, g.id), 50);
      return undefined;
    };
    $('#modalRoot').append(back);
  }

  // Second step: time control and side for chess and checkers, match
  // length for Tetris Battle; then the invite.
  function setupView(back, conv, type, done) {
    const m = back.querySelector('.modal');
    if (type === 'tetris') return tetrisSetup(m, conv, done);
    const sides = type === 'chess'
      ? [['first', pieceHtml('K'), t('White')], ['random', '<span class="gs-q">?</span>', t('Random')], ['second', pieceHtml('k'), t('Black')]]
      : [['first', '<span class="ck-piece p0"></span>', t('Black')], ['random', '<span class="gs-q">?</span>', t('Random')], ['second', '<span class="ck-piece p1"></span>', t('Red')]];
    const draw = () => {
      m.innerHTML = `<div class="modal-head"><h2>${ICONS[type]} ${esc(t(TITLES[type]))}</h2><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body game-setup">
          <div class="gs-label">${esc(t('Time control'))}</div>
            ${CLOCKS[type].map(([kind, keys]) => `<div class="gs-row"><span class="gs-kind">${esc(t(kind))}</span>${keys.map((k) => `<button class="gs-opt${prefs[clockPref(type)] === k ? ' on' : ''}" data-clock="${k}">${esc(clockLabel(clockFromKey(k)))}</button>`).join('')}</div>`).join('')}
            <button class="gs-opt wide${!clockFromKey(prefs[clockPref(type)]) ? ' on' : ''}" data-clock="none">∞ ${esc(t('No time limit'))}</button>
          <div class="gs-label">${esc(t('I play as'))}</div>
          <div class="gs-sides">${sides.map(([k, icon, label]) => `<button class="gs-side${prefs.side === k ? ' on' : ''}" data-side="${k}">${icon}<span>${esc(label)}</span></button>`).join('')}</div>
        </div>
        <div class="modal-foot"><button class="btn" data-back>${esc(t('Back'))}</button><button class="btn primary" data-go>${esc(t('Send invite'))}</button></div>`;
      m.querySelector('[data-close]').onclick = done;
    };
    draw();
    m.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.clock) {
        prefs[clockPref(type)] = b.dataset.clock;
        savePrefs();
        draw();
      } else if (b.dataset.side) {
        prefs.side = b.dataset.side;
        savePrefs();
        draw();
      } else if (b.dataset.back !== undefined) {
        done();
        newGameModal(conv);
      } else if (b.dataset.go !== undefined) {
        done();
        const options = { side: prefs.side, clock: clockFromKey(prefs[clockPref(type)]) };
        const g = await call(api.createGame(conv, type, options));
        if (g) setTimeout(() => show(conv, g.id), 50);
      }
    };
  }

  function tetrisSetup(m, conv, done) {
    const draw = () => {
      m.innerHTML = `<div class="modal-head"><h2>${ICONS.tetris} ${esc(t(TITLES.tetris))}</h2><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body game-setup">
          <div class="gs-label">${esc(t('Match length'))}</div>
          <div class="gs-sides five">${Games.BEST_OF.map((n) => `<button class="gs-side${prefs.bestOf === n ? ' on' : ''}" data-bo="${n}">
            <b class="gs-bo">${n}</b><span>${esc(n === 1 ? t('One round') : t('Best of {n}', { n }))}</span><small>${esc(t('First to {n}', { n: (n + 1) / 2 }))}</small></button>`).join('')}</div>
        </div>
        <div class="modal-foot"><button class="btn" data-back>${esc(t('Back'))}</button><button class="btn primary" data-go>${esc(t('Send invite'))}</button></div>`;
      m.querySelector('[data-close]').onclick = done;
    };
    draw();
    m.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.bo) {
        prefs.bestOf = Number(b.dataset.bo);
        savePrefs();
        draw();
      } else if (b.dataset.back !== undefined) {
        done();
        newGameModal(conv);
      } else if (b.dataset.go !== undefined) {
        done();
        const g = await call(api.createGame(conv, 'tetris', { bestOf: prefs.bestOf }));
        if (g) setTimeout(() => show(conv, g.id), 50);
      }
    };
  }

  return { cardHtml, show, close, onMessage, newGameModal, isOpen: (id) => open && open.id === id };
})();
