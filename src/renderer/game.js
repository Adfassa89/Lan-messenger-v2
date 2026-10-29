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
    chess: 'Classic chess, colors drawn at random',
    checkers: 'Captures are compulsory, kings move both ways',
    ttt: 'Three in a row wins',
    c4: 'Four in a row wins',
    tetris: 'Real-time battle: clear lines to send garbage',
  };
  let open = null; // { conv, id, back, selected }

  function result(msg) {
    try {
      return Games.replay(msg.game.type, msg.game.moves);
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

  function statusText(msg, r) {
    if (!r) return t('This game could not be loaded');
    const me = myIndex(msg);
    const st = r.status;
    if (st.over) {
      const why = {
        checkmate: t('Checkmate'), stalemate: t('Stalemate'), insufficient: t('Not enough pieces to win'),
        fifty: t('50-move rule'), resign: t('Resigned'), agreed: t('Draw agreed'), line: '', full: t('Board full'),
        blocked: t('No moves left'), quiet: t('40 moves without a capture'), ko: 'K.O.',
      }[st.reason] || '';
      let head;
      if (st.winner === null) head = t('Draw');
      else if (st.winner === me) head = t('You won! 🎉');
      else head = t('{name} won', { name: sideName(msg, st.winner) });
      return why ? `${head} · ${why}` : head;
    }
    if (r.drawOffer !== null && r.drawOffer !== undefined) {
      return r.drawOffer === me ? t('Draw offered – waiting for an answer') : t('{name} offers a draw', { name: sideName(msg, r.drawOffer) });
    }
    if (msg.game.type === 'tetris') return t('Battle ready – both players press Play');
    const turn = st.turn;
    const check = st.check ? ` · ${t('Check!')}` : '';
    return (turn === me ? t('Your turn') : t('Waiting for {name}', { name: sideName(msg, turn) })) + check;
  }

  // ------------------------------------------------------------------ boards
  function chessBoard(msg, r, { interactive, selected, targets } = {}) {
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
    const r = result(msg);
    const me = myIndex(msg);
    const myTurn = r && !r.status.over && r.status.turn === me;
    const players = [0, 1].map((i) => `${esc(sideName(msg, i))} <small>(${esc(colorName(msg.game.type, i))})</small>`).join(` ${esc(t('vs'))} `);
    return `<div class="game-card">
      <div class="gc-head"><span class="gc-icon">${ICONS[msg.game.type]}</span><div><b>${esc(t(TITLES[msg.game.type]))}</b><div class="gc-players">${players}</div></div></div>
      ${r && msg.game.type !== 'tetris' ? `<div class="gc-preview">${boardHtml(msg, r)}</div>` : ''}
      ${msg.game.type === 'tetris' ? '<div class="gc-tetris"><i class="t1"></i><i class="t2"></i><i class="t3"></i><i class="t4"></i></div>' : ''}
      <div class="gc-status${myTurn ? ' turn' : ''}">${esc(statusText(msg, r))}</div>
      <button class="fbtn" data-act="game">${esc(myTurn || (msg.game.type === 'tetris' && r && !r.status.over) ? t('Play') : t('Open'))}</button>
    </div>`;
  }

  // ------------------------------------------------------------------ game window
  function show(conv, id) {
    const m = (S.msgs.get(conv) || []).find((x) => x.id === id);
    if (m && m.game && m.game.type === 'tetris') {
      call(api.openTetris(conv, id));
      return;
    }
    close();
    const back = el('div', 'modal-back game-back');
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
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
    return `<div class="cc-player">
      ${avatarHtml('direct', id, id === S.me.id ? S.me.name : (peer ? peer.name : ''), null, 'cc-avatar')}
      <div class="cc-who"><div class="cc-name">${esc(id === S.me.id ? S.me.name : peerName(id))}${i === me ? ` <span class="cc-you">(${esc(t('You'))})</span>` : ''}</div>
        <div class="cc-captured">${caps.map((p) => pieceHtml(p)).join('')}${adv > 0 ? `<span class="cc-adv">+${adv}</span>` : ''}</div></div>
      <div class="cc-clock${moving ? ' on' : ''}">${pieceHtml(i === 0 ? 'K' : 'k')}<span>${esc(moving ? (i === me ? t('Your turn') : t('To move')) : (i === 0 ? t('White') : t('Black')))}</span></div>
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
    open.back.innerHTML = `<div class="modal game-modal chesscom${open.drawn ? ' still' : ''}">
      <div class="modal-head"><h2>${esc(t('Chess'))}</h2><button class="icon-btn" data-close title="${esc(t('Close'))}">✕</button></div>
      <div class="cc-body">
        <div class="cc-left">
          ${playerBar(msg, r, opp)}
          <div class="game-board-wrap">${chessBoard(msg, r, { interactive: myTurn })}
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
    if (myTurn && !open.promo) bindChessBoard(modal.querySelector('.board.chess'), msg, r);
    if (open.selected !== null) showTargets(modal, r, open.selected);
  }

  function showTargets(root, r, from) {
    for (const e of root.querySelectorAll('.sq.sel, .sq.dot, .sq.cap')) e.classList.remove('sel', 'dot', 'cap');
    if (from === null) return;
    const sqEl = (s) => root.querySelector(`.sq[data-sq="${s}"]`);
    if (sqEl(from)) sqEl(from).classList.add('sel');
    for (const mv of Games.RULES.chess.legalMoves(r.state)) {
      if (mv.from === from && sqEl(mv.to)) sqEl(mv.to).classList.add(r.state.board[mv.to] || mv.ep ? 'cap' : 'dot');
    }
  }

  // Click-to-move and drag-and-drop on the chess board.
  function bindChessBoard(board, msg, r) {
    const st = r.state;
    const me = myIndex(msg);
    const C = Games.RULES.chess;
    const mine = (s) => st.board[s] && ((st.board[s] === st.board[s].toUpperCase()) === (me === 0));
    const sqAt = (x, y) => {
      const e = document.elementFromPoint(x, y);
      const sq = e && e.closest('.board.chess [data-sq]');
      return sq ? Number(sq.dataset.sq) : null;
    };
    const tryMove = (from, to) => {
      const legal = C.legalMoves(st).filter((mv) => mv.from === from && mv.to === to);
      if (!legal.length) return false;
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
    board.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const s = sqAt(e.clientX, e.clientY);
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
      showTargets(board, r, s);
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
      if (!drag) return;
      const d = drag;
      drag = null;
      d.ghost.remove();
      d.piece.style.opacity = '';
      board.querySelectorAll('.sq.hover').forEach((x) => x.classList.remove('hover'));
      if (d.moved) {
        const s = e.type === 'pointerup' ? sqAt(e.clientX, e.clientY) : null;
        if (s !== null && s !== d.from && tryMove(d.from, s)) return;
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
      <div class="cc-clock${moving ? ' on' : ''}"><span class="ck-piece mini ${i === 0 ? 'p0' : 'p1'}"></span><span>${esc(moving ? (i === me ? t('Your turn') : t('To move')) : colorName('checkers', i))}</span></div>
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
      <div class="modal-head"><h2>${esc(t('Checkers'))}</h2><button class="icon-btn" data-close title="${esc(t('Close'))}">✕</button></div>
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

  function render() {
    const msg = current();
    if (!open) return;
    if (!msg) return close();
    const r = result(msg);
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
      <div class="modal-head"><h2>${ICONS[type]} ${esc(t(TITLES[type]))}</h2><button class="icon-btn" data-close title="${esc(t('Close'))}">✕</button></div>
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
    const b = e.target.closest('[data-cell],[data-col],[data-promo],[data-draw],[data-action]');
    if (!b || !r) return;
    if (b.dataset.cell !== undefined) return move({ cell: Number(b.dataset.cell) });
    if (b.dataset.col !== undefined) return move({ col: Number(b.dataset.col) });
    if (b.dataset.draw) return move({ draw: b.dataset.draw });
    if (b.dataset.promo) return move({ ...open.promo, promo: b.dataset.promo });
    if (b.dataset.action === 'resign') {
      return confirmModal(t('Resign this game?'), t('{name} will win the game.', { name: sideName(msg, 1 - me) }), t('Resign'), () => move({ resign: true }));
    }
    if (b.dataset.action === 'draw') return move({ draw: 'offer' });
    if (b.dataset.action === 'rematch') {
      const { conv } = open;
      return call(api.createGame(conv, msg.game.type)).then((g) => { if (g) show(conv, g.id); });
    }
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
      done();
      const g = await call(api.createGame(conv, b.dataset.type));
      if (g) setTimeout(() => show(conv, g.id), 50);
    };
    $('#modalRoot').append(back);
  }

  return { cardHtml, show, close, onMessage, newGameModal, isOpen: (id) => open && open.id === id };
})();
