'use strict';
/* global Games, api, el, esc, t, call, S, peerName, confirmModal, $ */
// Games inside private chats: the card shown in the chat, and the game
// window with the interactive board.

const Game = (() => {
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const TITLES = { chess: 'Chess', ttt: 'Tic-tac-toe', c4: 'Connect Four' };
  const ICONS = { chess: '♞', ttt: '#', c4: '●' };
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

  function pieceHtml(p) {
    if (!p) return '';
    const white = p === p.toUpperCase();
    // ︎ keeps Windows from drawing the pawn as a colored emoji.
    return `<span class="pc ${white ? 'w' : 'b'}">${GLYPH[p.toLowerCase()]}︎</span>`;
  }

  function sideName(msg, i) {
    const id = msg.game.players[i];
    return id === S.me.id ? t('You') : peerName(id);
  }

  function colorName(type, i) {
    if (type === 'chess') return i === 0 ? t('White') : t('Black');
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

  function boardHtml(msg, r, opts) {
    if (msg.game.type === 'chess') return chessBoard(msg, r, opts);
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
      ${r ? `<div class="gc-preview">${boardHtml(msg, r)}</div>` : ''}
      <div class="gc-status${myTurn ? ' turn' : ''}">${esc(statusText(msg, r))}</div>
      <button class="fbtn" data-act="game">${esc(myTurn ? t('Play') : t('Open'))}</button>
    </div>`;
  }

  // ------------------------------------------------------------------ game window
  function show(conv, id) {
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
    open.back.remove();
    open = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function current() {
    if (!open) return null;
    return (S.msgs.get(open.conv) || []).find((m) => m.id === open.id) || null;
  }

  function render() {
    const msg = current();
    if (!open) return;
    if (!msg) return close();
    const r = result(msg);
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

    open.back.innerHTML = `<div class="modal game-modal">
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
    modal.querySelector('[data-close]').onclick = close;
    modal.addEventListener('click', (e) => onClick(e, msg, r));
    const list = modal.querySelector('.move-list');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function move(m) {
    const { conv, id } = open;
    open.selected = null;
    open.promo = null;
    return call(api.gameMove(conv, id, m));
  }

  function onClick(e, msg, r) {
    const me = myIndex(msg);
    const b = e.target.closest('[data-sq],[data-cell],[data-col],[data-promo],[data-draw],[data-action]');
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
    if (b.dataset.sq !== undefined) {
      const s = Number(b.dataset.sq);
      const st = r.state;
      const mine = st.board[s] && ((st.board[s] === st.board[s].toUpperCase()) === (me === 0));
      if (open.selected !== null && open.selected !== s) {
        const legal = Games.RULES.chess.legalMoves(st).filter((mv) => mv.from === open.selected && mv.to === s);
        if (legal.length) {
          const m = { from: Games.RULES.chess.squareName(open.selected), to: Games.RULES.chess.squareName(s) };
          if (legal[0].promo) {
            open.promo = m;
            return render();
          }
          return move(m);
        }
      }
      open.selected = mine && open.selected !== s ? s : null;
      render();
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
        <span class="gp-icon">${ICONS[type]}</span><b>${esc(t(TITLES[type]))}</b><span>${esc(t({ chess: 'Classic chess, colors drawn at random', ttt: 'Three in a row wins', c4: 'Four in a row wins' }[type]))}</span></button>`).join('')}</div>
      <p class="modal-note" style="margin-top:12px">${esc(t('Moves are delivered like messages, so you can also play slowly across shifts.'))}</p></div></div>`;
    const done = () => back.remove();
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
