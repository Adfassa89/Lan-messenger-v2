'use strict';
/* global api, I18N, TetrisRules, Controls */
// Tetris Battle window: timing, controls, drawing, and the live link to the
// opponent. The rules themselves are in src/shared/tetris.js.

const params = new URLSearchParams(location.search);
const conv = params.get('conv');
const gameId = params.get('id');
let t = (k, v) => I18N.translate(params.get('lang') || 'en', k, v);

const { Tetris, W, H, VISIBLE } = TetrisRules;
const ROWS = VISIBLE + 2; // two rows above the field, where pieces appear
const COLORS = {
  I: '#3fd0f2', J: '#4f6cf5', L: '#f5922f', O: '#f5cf3a', S: '#62d64b', T: '#b552e0', Z: '#ef4565', G: '#686480',
};
// Key repeat and soft drop timing come from the player's control settings.
const H_ = () => Controls.handling;
const LOCK_DELAY = 500;
const MAX_RESETS = 15;
const STATE_EVERY = 90;

const $ = (id) => document.getElementById(id);
let info = null;
let me = 0;
let oppId = null;
let game = null;
let phase = 'waiting'; // waiting | countdown | playing | over
let startedAt = 0;
let peerHere = false;
let helloTimer = null;
let lastFrame = 0;
let gravityAcc = 0;
let lockTimer = 0;
let resets = 0;
let lowestY = -1;
let softAcc = 0;
let lastStateSent = 0;
let opp = null; // last state received from the opponent
let audio = null;
const held = new Set();
const das = { dir: 0, timer: 0, arr: 0 };

function send(data) {
  api.rtcSend(oppId, gameId, data);
}

// ------------------------------------------------------------------ drawing
let cell = 30;
function sizeBoards() {
  const avail = window.innerHeight - 150;
  cell = Math.max(18, Math.min(34, Math.floor(avail / ROWS)));
  for (const [id, size] of [['board', cell], ['oppBoard', Math.round(cell * 0.72)]]) {
    const c = $(id);
    c.width = W * size;
    c.height = ROWS * size;
  }
}

function block(ctx, x, y, size, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = 'rgba(255,255,255,.25)';
  ctx.fillRect(x, y, size, Math.max(2, size * 0.14));
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.fillRect(x, y + size - Math.max(2, size * 0.14), size, Math.max(2, size * 0.14));
  ctx.globalAlpha = 1;
}

function drawGrid(ctx, size) {
  ctx.clearRect(0, 0, W * size, ROWS * size);
  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  ctx.lineWidth = 1;
  for (let x = 1; x < W; x++) {
    ctx.beginPath();
    ctx.moveTo(x * size + 0.5, 2 * size);
    ctx.lineTo(x * size + 0.5, ROWS * size);
    ctx.stroke();
  }
  for (let y = 3; y < ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * size + 0.5);
    ctx.lineTo(W * size, y * size + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,61,90,.35)';
  ctx.fillRect(0, 2 * size - 1, W * size, 2);
}

function drawMine() {
  const ctx = $('board').getContext('2d');
  drawGrid(ctx, cell);
  const top = H - ROWS;
  for (let y = top; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = game.board[y * W + x];
      if (c) block(ctx, x * cell, (y - top) * cell, cell, COLORS[c]);
    }
  }
  if (game.active && phase === 'playing') {
    if (H_().ghost) {
      const gy = game.ghostY();
      for (const [x, y] of game.cells({ ...game.active, y: gy })) {
        if (y >= top) block(ctx, x * cell, (y - top) * cell, cell, COLORS[game.active.type], 0.22);
      }
    }
    for (const [x, y] of game.cells()) {
      if (y >= top) block(ctx, x * cell, (y - top) * cell, cell, COLORS[game.active.type]);
    }
  }
  $('meter').style.height = `${Math.min(100, (game.pendingGarbage() / VISIBLE) * 100)}%`;
}

function drawPiece(ctx, type, cx, cy, size) {
  if (!type) return;
  const cells = TetrisRules.SHAPES[type][0];
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const w = (Math.max(...xs) - Math.min(...xs) + 1) * size;
  const h = (Math.max(...ys) - Math.min(...ys) + 1) * size;
  for (const [x, y] of cells) {
    block(ctx, cx - w / 2 + (x - Math.min(...xs)) * size, cy - h / 2 + (y - Math.min(...ys)) * size, size, COLORS[type]);
  }
}

function drawSide() {
  const hold = $('hold').getContext('2d');
  hold.clearRect(0, 0, 120, 80);
  if (game.hold) {
    hold.globalAlpha = game.holdUsed ? 0.35 : 1;
    drawPiece(hold, game.hold, 60, 40, 22);
    hold.globalAlpha = 1;
  }
  const next = $('next').getContext('2d');
  next.clearRect(0, 0, 120, 400);
  game.next(5).forEach((type, i) => drawPiece(next, type, 60, 40 + i * 78, 22));
}

function drawOpponent() {
  const size = Math.round(cell * 0.72);
  const ctx = $('oppBoard').getContext('2d');
  drawGrid(ctx, size);
  if (opp && opp.b) {
    for (let i = 0; i < opp.b.length; i++) {
      const c = opp.b[i];
      if (c === '.') continue;
      const x = i % W;
      const y = Math.floor(i / W);
      block(ctx, x * size, y * size, size, COLORS[c.toUpperCase()], 1);
    }
  }
  const next = $('oppNext').getContext('2d');
  next.clearRect(0, 0, 80, 250);
  if (opp && opp.n) opp.n.slice(0, 3).forEach((type, i) => drawPiece(next, type, 40, 34 + i * 72, 15));
  $('oppMeter').style.height = `${Math.min(100, ((opp && opp.g) || 0) / VISIBLE * 100)}%`;
  if (opp && opp.s) $('oppStats').innerHTML = statsHtml(opp.s);
}

function statsHtml(s) {
  return `<div class="stat"><span>${t('PIECES')}</span><b>${s.pieces} <small>${s.pps}/s</small></b></div>
    <div class="stat"><span>${t('ATTACK')}</span><b>${s.sent} <small>${s.apm}/min</small></b></div>
    <div class="stat"><span>${t('LINES')}</span><b>${s.lines}</b></div>`;
}

function myStats() {
  const secs = Math.max(1, (performance.now() - startedAt) / 1000);
  return {
    pieces: game.stats.pieces,
    pps: (game.stats.pieces / secs).toFixed(2),
    sent: game.stats.sent,
    apm: Math.round((game.stats.sent * 60) / secs),
    lines: game.stats.lines,
  };
}

function setOverlay(id, text, cls = '') {
  const o = $(id);
  o.className = `overlay ${cls}`;
  o.textContent = text;
}

let actionTimer = null;
function showAction(r) {
  const parts = [];
  const names = ['', t('SINGLE'), t('DOUBLE'), t('TRIPLE'), t('QUAD')];
  if (r.spin) parts.push(`<div class="spin">${r.spin === 'mini' ? t('T-SPIN MINI') : 'T-SPIN'} ${names[r.lines] || ''}</div>`);
  else if (r.lines >= 2) parts.push(`<div class="big">${names[r.lines]}</div>`);
  if (r.b2b > 0) parts.push(`<div class="b2b">B2B ×${r.b2b}</div>`);
  if (r.combo >= 1) parts.push(`<div class="combo">${t('{n} COMBO', { n: r.combo })}</div>`);
  if (r.perfect) parts.push(`<div class="pc">${t('ALL CLEAR')}</div>`);
  if (r.sent > 0) parts.push(`<div class="sent">+${r.sent} ${t('sent')}</div>`);
  if (!parts.length) return;
  $('action').innerHTML = parts.join('');
  clearTimeout(actionTimer);
  actionTimer = setTimeout(() => { $('action').innerHTML = ''; }, 1600);
}

function beep(freq, len = 0.06, vol = 0.05) {
  if (!info || !info.sound) return;
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + len);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + len);
  } catch { /* no audio */ }
}

// ------------------------------------------------------------------ game flow
function onLocked(r) {
  if (r.lines) beep(520 + r.lines * 120, 0.12, 0.06);
  else beep(180, 0.04, 0.03);
  if (r.sent > 0) send({ kind: 'tt-attack', lines: r.sent });
  showAction(r);
  sendState(true);
  resetLock();
  if (r.ko) lose();
}

function resetLock() {
  lockTimer = 0;
  resets = 0;
  lowestY = game.active ? game.active.y : -1;
  gravityAcc = 0;
}

// Moving or rotating a piece on the ground gives it more time, up to a limit.
function afterShift(ok) {
  if (!ok) return;
  if (game.grounded()) {
    if (resets < MAX_RESETS) {
      lockTimer = 0;
      resets++;
    }
  }
}

function hardDrop() {
  beep(240, 0.05, 0.05);
  onLocked(game.hardDrop());
}

function start(seed) {
  if (phase !== 'waiting') return;
  clearInterval(helloTimer);
  game = new Tetris(seed);
  phase = 'countdown';
  let n = 3;
  setOverlay('overlay', String(n), 'count');
  setOverlay('oppOverlay', '');
  drawMine();
  drawSide();
  const tick = setInterval(() => {
    n--;
    if (n > 0) {
      setOverlay('overlay', String(n), 'count');
      beep(440, 0.08);
    } else {
      clearInterval(tick);
      setOverlay('overlay', '');
      beep(880, 0.15);
      phase = 'playing';
      startedAt = performance.now();
      game.spawn();
      resetLock();
    }
  }, 1000);
  beep(440, 0.08);
}

function finish(won, why) {
  if (phase === 'over') return;
  phase = 'over';
  held.clear();
  $('result').classList.remove('hidden');
  $('resultTitle').textContent = won ? t('VICTORY') : t('DEFEAT');
  $('resultTitle').className = `result-title ${won ? 'win' : 'lose'}`;
  $('resultSub').textContent = why;
  beep(won ? 660 : 160, 0.4, 0.07);
}

function lose() {
  if (phase === 'over') return;
  setOverlay('overlay', 'K.O.', 'ko');
  send({ kind: 'tt-ko' });
  api.gameMove(conv, gameId, { ko: true }).catch(() => {});
  finish(false, t('{name} wins this round', { name: info.people[oppId].name }));
}

function sendState(force = false) {
  const now = performance.now();
  if (!force && now - lastStateSent < STATE_EVERY) return;
  lastStateSent = now;
  send({ kind: 'tt-state', b: game.snapshot(), n: game.next(3), g: game.pendingGarbage(), s: myStats() });
}

// ------------------------------------------------------------------ main loop
function frame(now) {
  const dt = Math.min(100, now - (lastFrame || now));
  lastFrame = now;
  if (phase === 'playing' && game.active) {
    // Auto-repeat for held left / right.
    if (das.dir) {
      das.timer -= dt;
      if (das.timer <= 0) {
        das.arr -= dt;
        while (das.arr <= 0) {
          if (!game.move(das.dir)) { das.arr = 0; break; }
          afterShift(true);
          if (H_().arr === 0) continue; // instant: slide all the way
          das.arr += H_().arr;
        }
      }
    }
    // Gravity speeds up over the match.
    const secs = (now - startedAt) / 1000;
    const rowsPerSec = Math.min(20, (0.02 + secs * 0.0012) * 60);
    if (held.has('soft')) {
      softAcc += dt;
      while (softAcc >= H_().soft) {
        softAcc -= H_().soft;
        if (game.drop()) gravityAcc = 0;
      }
    }
    gravityAcc += (dt / 1000) * rowsPerSec;
    while (gravityAcc >= 1) {
      gravityAcc -= 1;
      if (!game.drop()) { gravityAcc = 0; break; }
    }
    if (game.active.y > lowestY) {
      lowestY = game.active.y;
      resets = 0;
    }
    if (game.grounded()) {
      lockTimer += dt;
      if (lockTimer >= LOCK_DELAY || resets >= MAX_RESETS) onLocked(game.lock());
    } else {
      lockTimer = 0;
    }
    sendState();
    const s = Math.floor(secs);
    $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('stats').innerHTML = statsHtml(myStats());
  }
  if (game) {
    drawMine();
    drawSide();
  }
  drawOpponent();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ keyboard (keys chosen in Controls)
document.addEventListener('keydown', (e) => {
  if (Controls.isOpen()) return;
  const action = Controls.actionFor(e.code);
  if (!action) return;
  e.preventDefault();
  if (phase !== 'playing' || e.repeat) return;
  held.add(action);
  if (action === 'left' || action === 'right') {
    const dir = action === 'left' ? -1 : 1;
    afterShift(game.move(dir));
    das.dir = dir;
    das.timer = H_().das;
    das.arr = 0;
  } else if (action === 'soft') {
    softAcc = H_().soft;
  } else if (action === 'hard') {
    hardDrop();
  } else if (action === 'cw' || action === 'ccw' || action === '180') {
    afterShift(game.rotate(action === 'cw' ? 1 : action === 'ccw' ? -1 : 2));
  } else if (action === 'hold') {
    if (game.holdPiece()) {
      resetLock();
      if (game.dead) lose();
    }
  }
});

document.addEventListener('keyup', (e) => {
  const action = Controls.actionFor(e.code);
  if (!action) return;
  held.delete(action);
  if ((action === 'left' && das.dir === -1) || (action === 'right' && das.dir === 1)) {
    // If the other direction is still held, switch to it.
    const other = action === 'left' ? 'right' : 'left';
    das.dir = held.has(other) ? (other === 'left' ? -1 : 1) : 0;
    das.timer = H_().das;
  }
});

// ------------------------------------------------------------------ network
api.on(({ type, payload }) => {
  if (type !== 'rtc' || payload.sid !== gameId || payload.peerId !== oppId) return;
  const d = payload.data;
  switch (d.kind) {
    case 'tt-hello':
      if (!peerHere) {
        peerHere = true;
        setOverlay('oppOverlay', t('Ready'));
        send({ kind: 'tt-hello' });
      }
      // Player 1 picks the shared piece order and starts the countdown.
      if (me === 0 && phase === 'waiting') {
        const seed = Math.floor(Math.random() * 2 ** 31);
        send({ kind: 'tt-start', seed });
        start(seed);
      }
      break;
    case 'tt-start':
      peerHere = true;
      start(Number(d.seed) || 1);
      break;
    case 'tt-state':
      opp = d;
      break;
    case 'tt-attack':
      if (phase === 'playing' || phase === 'countdown') {
        game.receive(Math.max(0, Math.min(20, Number(d.lines) || 0)));
        beep(110, 0.12, 0.06);
      }
      break;
    case 'tt-ko':
      setOverlay('oppOverlay', 'K.O.', 'ko');
      finish(true, t('You knocked out {name}', { name: info.people[oppId].name }));
      break;
    case 'tt-leave':
      if (phase === 'playing' || phase === 'countdown') {
        setOverlay('oppOverlay', t('Left the game'));
        finish(true, t('{name} left the game', { name: info.people[oppId].name }));
      } else if (phase === 'waiting') {
        peerHere = false;
        setOverlay('oppOverlay', t('Waiting for {name}…', { name: info.people[oppId].name }));
      }
      break;
    default:
      break;
  }
});

async function init() {
  info = await api.tetrisInfo(conv, gameId);
  if (!info) return window.close();
  t = (k, v) => I18N.translate(info.language, k, v);
  document.title = t('Tetris Battle');
  me = info.players.indexOf(info.me);
  oppId = info.players[1 - me];
  $('meName').textContent = info.people[info.me].name;
  $('oppName').textContent = info.people[oppId].name;
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t(e.dataset.t);
  const showKeys = () => { $('keys').innerHTML = Controls.hintHtml(t); };
  showKeys();
  $('btnControls').textContent = `⚙ ${t('Controls')}`;
  $('btnControls').onclick = () => {
    held.clear();
    das.dir = 0;
    Controls.open(t, showKeys);
  };
  $('btnRematch').textContent = t('Rematch');
  $('btnClose').textContent = t('Close');
  $('btnClose').onclick = () => window.close();
  $('btnRematch').onclick = async () => {
    const msg = await api.createGame(conv, 'tetris').catch(() => null);
    if (msg) {
      await api.openTetris(conv, msg.id);
      window.close();
    }
  };
  sizeBoards();
  window.addEventListener('resize', sizeBoards);
  game = new Tetris(1);
  if (info.over) {
    setOverlay('overlay', t('This battle has finished'));
    $('result').classList.remove('hidden');
    $('resultTitle').textContent = t('Finished');
    $('resultSub').textContent = '';
    phase = 'over';
  } else {
    setOverlay('overlay', t('Waiting for {name}…', { name: info.people[oppId].name }));
    setOverlay('oppOverlay', t('Waiting for {name}…', { name: info.people[oppId].name }));
    send({ kind: 'tt-hello' });
    helloTimer = setInterval(() => { if (phase === 'waiting') send({ kind: 'tt-hello' }); }, 1000);
  }
  window.addEventListener('beforeunload', () => {
    send({ kind: 'tt-leave' });
    if (phase === 'playing' || phase === 'countdown') api.gameMove(conv, gameId, { ko: true }).catch(() => {});
  });
  requestAnimationFrame(frame);
}

init();
