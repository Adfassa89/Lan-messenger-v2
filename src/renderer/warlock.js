'use strict';
/* global api, I18N, Warlock, Sfx, EndFx */
// Warlock window: lobby, the live arena, the shop between rounds.
// The PC that opened the arena (the host) runs Warlock.Sim and sends a
// snapshot every tick; everyone (the host too) draws those snapshots and
// sends their mouse and key input to the host.

const params = new URLSearchParams(location.search);
const conv = params.get('conv');
const gameId = params.get('id');
let t = (k, v) => I18N.translate(params.get('lang') || 'en', k, v);
const $ = (id) => document.getElementById(id);
const { SPELLS, ITEMS, COLUMN_SPELLS, TILE, RADIUS, TICK } = Warlock;
const KEYS = ['Q', 'W', 'E', 'R', 'D', 'F', 'G', 'X']; // slot 0 Fireball … 7 Scourge
const KEY_TO_SLOT = { KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3, KeyD: 4, KeyF: 5, KeyG: 6, KeyX: 7 };

let info = null;
let isHost = false;
let me = null;
let players = []; // lobby: [{ id, name }]
let rounds = 5;
let started = false;
let sim = null;
let snaps = []; // last two snapshots, for smooth movement
let snapAt = 0;
let lastSnap = null;
let posted = false;
const names = {};

function send(peerId, data) { api.rtcSend(peerId, gameId, data); }
function toAll(data) { for (const p of players) if (p.id !== me) send(p.id, data); }
function toHost(data) { send(info.host, data); }

// ------------------------------------------------------------------ lobby
function renderLobby() {
  $('lobbySub').textContent = isHost
    ? t('Players join from the group chat. Start when everyone is in.')
    : started ? t('The match has started.') : t('Waiting for {name} to start the match…', { name: info.hostName });
  $('lobbyList').innerHTML = players.map((p, i) => `<li><i style="color:${Warlock.COLORS[i % 10]};background:${Warlock.COLORS[i % 10]}"></i>${esc(p.name)}${p.id === info.host ? `<small>${esc(t('Host'))}</small>` : ''}</li>`).join('');
  $('lobbyOpts').classList.toggle('hidden', !isHost);
  $('roundsSeg').innerHTML = [3, 5, 7, 11].map((n) => `<button data-r="${n}" class="${n === rounds ? 'on' : ''}">${n}</button>`).join('');
  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnStart').disabled = players.length < 2;
  $('btnStart').textContent = players.length < 2 ? t('Waiting for players…') : t('Start the match ({n} players)', { n: players.length });
  $('lobbyHelp').innerHTML = `${t('Right-click to move, aim with the mouse.')}<br>
    <kbd>Q</kbd> ${t('Fireball')} · <kbd>W</kbd><kbd>E</kbd><kbd>R</kbd><kbd>D</kbd><kbd>F</kbd><kbd>G</kbd> ${t('spells')} · <kbd>X</kbd> ${t('Scourge')} · <kbd>S</kbd> ${t('stop')}<br>
    ${t('Knock the others into the lava. Last warlock standing wins the round.')}`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

$('roundsSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-r]');
  if (!b) return;
  rounds = Number(b.dataset.r);
  renderLobby();
  toAll({ kind: 'wl-lobby', players, rounds });
});

$('btnStart').addEventListener('click', () => {
  if (!isHost || players.length < 2 || started) return;
  started = true;
  sim = new Warlock.Sim(players, { rounds, seed: Math.floor(Math.random() * 2 ** 31) });
  sim.start();
  toAll({ kind: 'wl-start' });
  enterGame();
  hostLoop();
});

function enterGame() {
  started = true;
  $('lobby').classList.add('hidden');
  $('hud').classList.remove('hidden');
  Sfx.play('wlHorn');
}

// ------------------------------------------------------------------ host loop
// Fixed 0.035 s steps, caught up from real time; a snapshot after each step.
function hostLoop() {
  let acc = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    let stepped = false;
    while (acc >= TICK) {
      acc -= TICK;
      sim.step();
      stepped = true;
    }
    if (!stepped) return;
    const snap = sim.snapshot();
    toAll({ kind: 'wl-snap', s: snap });
    onSnap(snap);
    if (snap.ph === 'over') {
      clearInterval(timer);
      postResults(snap);
    }
  }, 8);
}

function postResults(snap) {
  if (posted) return;
  posted = true;
  const order = snap.p.slice().sort((a, b) => b.sc - a.sc || b.k - a.k);
  const lines = order.map((p, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${names[p.id] || '?'} – ${t('{n} rounds', { n: p.sc })}, ${t('{n} kills', { n: p.k })}`);
  api.warlockResult(conv, gameId, `🔥 Warlock – ${t('{name} wins!', { name: names[order[0].id] || '?' })}\n${lines.join('\n')}`).catch(() => {});
}

// ------------------------------------------------------------------ network
api.on(({ type, payload }) => {
  if (type !== 'rtc' || payload.sid !== gameId) return;
  const from = payload.peerId;
  const d = payload.data || {};
  if (isHost) {
    switch (d.kind) {
      case 'wl-join':
        if (!players.some((p) => p.id === from)) {
          if (started) return send(from, { kind: 'wl-full' });
          players.push({ id: from, name: String(d.name || '?').slice(0, 40) });
          names[from] = players[players.length - 1].name;
          Sfx.play('notify');
        }
        renderLobby();
        toAll({ kind: 'wl-lobby', players, rounds });
        break;
      case 'wl-leave':
        if (!started) {
          players = players.filter((p) => p.id !== from);
          renderLobby();
          toAll({ kind: 'wl-lobby', players, rounds });
        } else if (sim) sim.leave(from);
        break;
      case 'wl-in':
        if (sim) sim.input(from, d.i || {});
        break;
      case 'wl-buy':
        if (sim) sim.buy(from, String(d.k || ''));
        break;
      case 'wl-ready':
        if (sim) sim.setReady(from);
        break;
      default:
        break;
    }
    return;
  }
  if (from !== info.host) return;
  switch (d.kind) {
    case 'wl-lobby':
      players = Array.isArray(d.players) ? d.players : [];
      for (const p of players) names[p.id] = p.name;
      rounds = d.rounds || rounds;
      renderLobby();
      break;
    case 'wl-start':
      if (!started) enterGame();
      break;
    case 'wl-snap':
      if (!started) enterGame();
      onSnap(d.s);
      break;
    case 'wl-full':
      $('lobbySub').textContent = t('This match has already started.');
      break;
    case 'wl-closed':
      $('lobbySub').textContent = t('{name} closed the arena.', { name: info.hostName });
      $('lobby').classList.remove('hidden');
      break;
    default:
      break;
  }
});

function sendInput(i) {
  if (isHost) { if (sim) sim.input(me, i); } else toHost({ kind: 'wl-in', i });
}

// ------------------------------------------------------------------ snapshots
function onSnap(s) {
  snaps.push(s);
  if (snaps.length > 2) snaps.shift();
  snapAt = performance.now();
  for (const e of s.fx || []) effect(e, s);
  lastSnap = s;
  renderHud(s);
}

// ------------------------------------------------------------------ camera
const canvas = $('view');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;
let scale = 0.2;
let dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  W = innerWidth;
  H = innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  tileSprites.clear();
}
window.addEventListener('resize', resize);
// The camera follows your warlock (like Warlock Brawl); while you are dead
// or shopping it shows the whole platform.
let camX = 0;
let camY = 0;
function fitScale(s) {
  const n = s ? s.p.length : 2;
  const R = (13 + n + 1) * 100 + 260;
  return Math.min(W, H - 120) / (2 * R);
}
function followScale() { return Math.max(H - 110, 300) / 2300; }
const sx = (x) => W / 2 + (x - camX) * scale;
const sy = (y) => H / 2 - 30 + (y - camY) * scale;
const wx = (px) => (px - W / 2) / scale + camX;
const wy = (py) => (py - H / 2 + 30) / scale + camY;

// ------------------------------------------------------------------ input
let mouse = { x: 0, y: 0 };
let moveMark = null;
canvas.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (e.buttons & 2) moveTo(e);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) moveTo(e);
});
function moveTo(e) {
  const x = wx(e.clientX);
  const y = wy(e.clientY);
  sendInput({ move: [Math.round(x), Math.round(y)] });
  moveMark = { x, y, t: performance.now() };
}
document.addEventListener('keydown', (e) => {
  if (!started || e.repeat) return;
  if (e.code === 'KeyS') { sendInput({ stop: true }); return; }
  const slot = KEY_TO_SLOT[e.code];
  if (slot === undefined) return;
  e.preventDefault();
  sendInput({ cast: slot, x: Math.round(wx(mouse.x)), y: Math.round(wy(mouse.y)) });
});

// ------------------------------------------------------------------ art
// Lava: a pre-drawn texture that drifts slowly.
const lava = document.createElement('canvas');
(function paintLava() {
  lava.width = lava.height = 512;
  const g = lava.getContext('2d');
  g.fillStyle = '#4a0b03';
  g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Glowing molten patches, wrapped so the texture tiles seamlessly.
  const blob = (x, y, r, inner) => {
    for (const ox of [-512, 0, 512]) {
      for (const oy of [-512, 0, 512]) {
        const grd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grd.addColorStop(0, inner);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(x + ox, y + oy, r, 0, 7); g.fill();
      }
    }
  };
  for (let i = 0; i < 90; i++) blob(rnd() * 512, rnd() * 512, 40 + rnd() * 90, 'rgba(170,30,6,.55)');
  for (let i = 0; i < 70; i++) blob(rnd() * 512, rnd() * 512, 18 + rnd() * 40, 'rgba(255,110,20,.45)');
  for (let i = 0; i < 28; i++) blob(rnd() * 512, rnd() * 512, 6 + rnd() * 16, 'rgba(255,215,110,.7)');
  // Dark cooling crust.
  for (let i = 0; i < 40; i++) blob(rnd() * 512, rnd() * 512, 20 + rnd() * 50, 'rgba(25,4,2,.45)');
}());

// Stone tiles, three variants, drawn once per size.
const tileSprites = new Map();
function tileSprite(size, v) {
  const key = `${size}|${v}`;
  if (tileSprites.has(key)) return tileSprites.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(4, Math.ceil(size));
  const g = c.getContext('2d');
  const base = ['#5b4f47', '#544841', '#62564c'][v];
  const grd = g.createLinearGradient(0, 0, size, size);
  grd.addColorStop(0, '#8a7b6e');
  grd.addColorStop(0.15, base);
  grd.addColorStop(1, '#3a312b');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(0,0,0,.45)';
  g.lineWidth = Math.max(1, size * 0.04);
  g.strokeRect(0.5, 0.5, size - 1, size - 1);
  g.strokeStyle = 'rgba(255,255,255,.12)';
  g.beginPath(); g.moveTo(1, size - 1); g.lineTo(1, 1); g.lineTo(size - 1, 1); g.stroke();
  // Cracks and pebbles.
  g.strokeStyle = 'rgba(20,14,10,.5)';
  g.lineWidth = Math.max(1, size * 0.015);
  g.beginPath();
  g.moveTo(size * (0.2 + v * 0.2), size * 0.1);
  g.lineTo(size * (0.35 + v * 0.1), size * 0.45);
  g.lineTo(size * (0.25 + v * 0.15), size * 0.8);
  g.stroke();
  tileSprites.set(key, c);
  return c;
}

const sinking = []; // tiles of the ring that just sank: { gx, gy, t0 }
let shownLayer = 0;

function drawArena(s, now) {
  // Lava drifting.
  const off = (now / 90) % 512;
  const pat = ctx.createPattern(lava, 'repeat');
  ctx.save();
  ctx.translate(-off, -off * 0.6);
  ctx.fillStyle = pat;
  ctx.fillRect(off, off * 0.6, W, H);
  ctx.restore();
  // Heat pulse.
  ctx.fillStyle = `rgba(255,80,10,${0.06 + 0.04 * Math.sin(now / 600)})`;
  ctx.fillRect(0, 0, W, H);

  const size = TILE * scale;
  const n = Math.ceil(s.layer * 100 / TILE) + 1;
  // Hot glow where the lava meets the stone.
  const pr = s.layer * 100 * scale + size * 0.5;
  const glow = ctx.createRadialGradient(sx(0), sy(0), pr * 0.85, sx(0), sy(0), pr + 90 * scale + 30);
  glow.addColorStop(0, 'rgba(255,160,50,.55)');
  glow.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(sx(0), sy(0), pr + 90 * scale + 30, 0, 7); ctx.fill();
  for (let gx = -n; gx <= n; gx++) {
    for (let gy = -n; gy <= n; gy++) {
      if (Math.hypot(gx * TILE, gy * TILE) > s.layer * 100) continue;
      const v = Math.abs((gx * 7 + gy * 13) % 3);
      const x = sx(gx * TILE - TILE / 2);
      const y = sy(gy * TILE - TILE / 2);
      ctx.drawImage(tileSprite(size, v), x, y, size, size);
    }
  }
  // The ring that just sank: tiles darken, shrink and glow red.
  for (let i = sinking.length - 1; i >= 0; i--) {
    const k = (now - sinking[i].t0) / 1400;
    if (k >= 1) { sinking.splice(i, 1); continue; }
    const { gx, gy } = sinking[i];
    const sz = size * (1 - k * 0.6);
    const x = sx(gx * TILE) - sz / 2;
    const y = sy(gy * TILE) - sz / 2;
    ctx.globalAlpha = 1 - k;
    ctx.drawImage(tileSprite(size, 0), x, y, sz, sz);
    ctx.fillStyle = `rgba(255,90,20,${0.6 * (1 - k)})`;
    ctx.fillRect(x, y, sz, sz);
    ctx.globalAlpha = 1;
  }
}

function sinkRing(oldLayer, newLayer) {
  const n = Math.ceil(oldLayer * 100 / TILE) + 1;
  const now = performance.now();
  for (let gx = -n; gx <= n; gx++) {
    for (let gy = -n; gy <= n; gy++) {
      const d = Math.hypot(gx * TILE, gy * TILE);
      if (d <= oldLayer * 100 && d > newLayer * 100) sinking.push({ gx, gy, t0: now });
    }
  }
}

function colorOf(id, s) {
  const i = s.p.findIndex((p) => p.id === id);
  return Warlock.COLORS[(i < 0 ? 0 : i) % 10];
}

// A warlock: a hooded figure in its player colour holding a glowing staff.
function drawWarlock(p, x, y, s, now) {
  const r = Math.max(10, RADIUS * scale * 1.6);
  const col = colorOf(p.id, s);
  const mine = p.id === me;
  const invisible = p.m.includes('windwalk');
  if (invisible && !mine) return;
  ctx.save();
  ctx.globalAlpha = invisible ? 0.4 : 1;
  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.15, y + r * 0.35, r * 1.05, r * 0.7, 0, 0, 7);
  ctx.fill();
  if (p.m.includes('rush')) {
    ctx.fillStyle = `rgba(255,80,30,${0.35 + 0.15 * Math.sin(now / 80)})`;
    ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, 7); ctx.fill();
  }
  if (p.m.includes('spawnShield')) {
    ctx.strokeStyle = 'rgba(255,240,180,.7)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r * 1.5, 0, 7); ctx.stroke();
  }
  ctx.translate(x, y);
  ctx.rotate(p.f);
  // Robe.
  const robe = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
  robe.addColorStop(0, shade(col, 0.35));
  robe.addColorStop(1, shade(col, -0.45));
  ctx.fillStyle = robe;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.6)';
  ctx.lineWidth = Math.max(1, r * 0.12);
  ctx.stroke();
  // Hood, pointing where the warlock faces.
  ctx.fillStyle = shade(col, -0.6);
  ctx.beginPath();
  ctx.moveTo(r * 0.95, 0);
  ctx.lineTo(-r * 0.2, -r * 0.55);
  ctx.lineTo(-r * 0.2, r * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,200,120,.9)'; // glowing eyes
  ctx.fillRect(r * 0.35, -r * 0.18, r * 0.12, r * 0.1);
  ctx.fillRect(r * 0.35, r * 0.08, r * 0.12, r * 0.1);
  // Staff with a glowing tip.
  ctx.strokeStyle = '#3b2414';
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.beginPath(); ctx.moveTo(-r * 0.2, r * 0.75); ctx.lineTo(r * 1.35, r * 0.75); ctx.stroke();
  const glow = p.cast ? 1 : 0.6;
  ctx.fillStyle = `rgba(255,${p.cast ? 230 : 170},80,${glow})`;
  ctx.shadowColor = '#ff9a3c';
  ctx.shadowBlur = p.cast ? 18 : 8;
  ctx.beginPath(); ctx.arc(r * 1.4, r * 0.75, r * 0.22, 0, 7); ctx.fill();
  ctx.restore();
  // Shield bubble.
  if (p.sh) {
    ctx.save();
    const sr = p.sh * scale;
    const g = ctx.createRadialGradient(x, y, sr * 0.6, x, y, sr);
    g.addColorStop(0, 'rgba(120,200,255,0)');
    g.addColorStop(1, 'rgba(140,220,255,.45)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, sr, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(190,240,255,.8)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
  // Name, health bar and knockback points.
  const bw = Math.max(40, r * 2.6);
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(x - bw / 2, y - r - 14, bw, 6);
  const f = Math.max(0, p.hp / p.mx);
  ctx.fillStyle = f > 0.5 ? '#5fd46f' : f > 0.25 ? '#f2c230' : '#e8443a';
  ctx.fillRect(x - bw / 2 + 1, y - r - 13, (bw - 2) * f, 4);
  ctx.font = '600 11px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = mine ? '#ffe7a8' : '#fff';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 3;
  ctx.fillText(names[p.id] || '', x, y - r - 18);
  if (p.dp > 0) {
    ctx.fillStyle = '#ff9a5c';
    ctx.font = '700 10px "Segoe UI", sans-serif';
    ctx.fillText(`+${Math.round(p.dp / 10)}%`, x + bw / 2 + 14, y - r - 9);
  }
  ctx.shadowBlur = 0;
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)));
  return `rgb(${c.join(',')})`;
}

const PROJ_STYLE = {
  fireball: ['#fff2b0', '#ff8a1c', '#ff3d0a'],
  homing: ['#f2d9ff', '#b066ff', '#5a1aa8'],
  cluster: ['#fff7c2', '#ffd23a', '#e89a10'],
  bouncer: ['#e2ffd0', '#6cff5a', '#1d9a1a'],
  boomerang: ['#ffffff', '#c7d2e0', '#6c7a8c'],
  swap: ['#e0faff', '#5ad2ff', '#1a6ca8'],
  link: ['#e8f4ff', '#9ec9ff', '#3a6ab0'],
};

function drawProjectiles(s, dtSnap, now) {
  for (const b of s.b) {
    const [k, bx, by, vx, vy, r, owner, extra] = b;
    const x = sx(bx + vx * dtSnap);
    const y = sy(by + vy * dtSnap);
    if (k === 'meteor') {
      // A shadow that grows, then the rock falling from the sky.
      const left = extra;
      const prog = 1 - left / SPELLS.meteor.delay;
      ctx.fillStyle = `rgba(255,60,10,${0.15 + 0.25 * prog})`;
      ctx.beginPath(); ctx.arc(x, y, r * scale, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,170,60,.8)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r * scale * prog, 0, 7); ctx.stroke();
      const h = (1 - prog) * 260 * scale * 4;
      ctx.fillStyle = '#4a2a1a';
      ctx.shadowColor = '#ff6a10';
      ctx.shadowBlur = 20;
      ctx.beginPath(); ctx.arc(x - h * 0.4, y - h, Math.max(4, 40 * scale), 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      continue;
    }
    if (k === 'gravity') {
      const rr = 550 * scale;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, 'rgba(10,0,30,.85)');
      g.addColorStop(0.15, 'rgba(90,40,160,.35)');
      g.addColorStop(1, 'rgba(60,20,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(190,140,255,.6)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const a = now / 300 + (i * Math.PI * 2) / 3;
        ctx.beginPath(); ctx.arc(x, y, rr * 0.25, a, a + 1.4); ctx.stroke();
      }
      continue;
    }
    if (k === 'linked' || k === 'link') {
      const o = s.p.find((p) => p.id === owner);
      const tgt = k === 'linked' ? s.p.find((p) => p.id === extra) : null;
      if (o) {
        const tx = tgt ? sx(tgt.x) : x;
        const ty = tgt ? sy(tgt.y) : y;
        ctx.strokeStyle = 'rgba(160,210,255,.9)';
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 6]);
        ctx.lineDashOffset = -now / 20;
        ctx.beginPath(); ctx.moveTo(sx(o.x), sy(o.y)); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (k === 'linked') continue;
    }
    const st = PROJ_STYLE[k] || PROJ_STYLE.fireball;
    const rr = Math.max(4, r * scale * 1.6);
    if (k === 'boomerang') {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(now / 50);
      ctx.fillStyle = st[1];
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 1.2); ctx.arc(rr * 0.3, 0, rr * 0.7, Math.PI * 1.2, 0, true); ctx.fill();
      ctx.restore();
      continue;
    }
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr * 1.8);
    g.addColorStop(0, st[0]);
    g.addColorStop(0.35, st[1]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rr * 1.8, 0, 7); ctx.fill();
    // Trail sparks.
    if (Math.random() < 0.8) particles.push({ x: bx + vx * dtSnap, y: by + vy * dtSnap, vx: -vx * 0.05 + (Math.random() - 0.5) * 60, vy: -vy * 0.05 + (Math.random() - 0.5) * 60, t0: now, life: 300, c: st[2], s: 3 });
  }
}

// ------------------------------------------------------------------ effects
const particles = [];
const rings = [];
const bolts = [];
const floaters = [];
let shakeUntil = 0;
let shakeAmp = 0;

function burst(x, y, n, colors, speed = 300, life = 600, size = 4) {
  const now = performance.now();
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random());
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t0: now, life: life * (0.6 + Math.random() * 0.6), c: colors[i % colors.length], s: size });
  }
}
function ring(x, y, r, color, life = 500) { rings.push({ x, y, r, color, t0: performance.now(), life }); }
function shake(amp, ms) { shakeAmp = Math.max(shakeAmp, amp); shakeUntil = performance.now() + ms; }
function feed(text) {
  const el = document.createElement('div');
  el.textContent = text;
  $('feed').append(el);
  setTimeout(() => el.remove(), 5000);
}
function banner(text, sub = '', ms = 1800) {
  $('banner').innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  $('banner').classList.remove('hidden');
  $('banner').style.animation = 'none';
  void $('banner').offsetWidth;
  $('banner').style.animation = '';
  clearTimeout(banner.timer);
  banner.timer = setTimeout(() => $('banner').classList.add('hidden'), ms);
}

function effect(e, s) {
  const near = (x, y) => (lastSnap ? true : true) && x !== undefined && y !== undefined;
  switch (e.e) {
    case 'cast':
      Sfx.play({ fireball: 'wlFire', cluster: 'wlFire', homing: 'wlWhoosh', bouncer: 'wlWhoosh', boomerang: 'wlWhoosh', link: 'wlChain', gravity: 'wlGravity', windwalk: 'wlWind', rush: 'wlRush', shield: 'wlShield', thrust: 'wlWind' }[e.k] || 'wlWhoosh');
      if (e.k === 'shield') ring(e.x, e.y, 220, 'rgba(160,230,255,.8)', 400);
      if (e.k === 'windwalk') burst(e.x, e.y, 18, ['#dfe9ff', '#a9b8d6'], 120, 600, 3);
      break;
    case 'boom':
      if (!near(e.x, e.y)) break;
      burst(e.x, e.y, 24, e.k === 'homing' ? ['#d9a8ff', '#8a3dff'] : e.k === 'bouncer' ? ['#c4ff9e', '#3fc23a'] : ['#fff2b0', '#ff8a1c', '#ff3d0a'], 380);
      ring(e.x, e.y, 90, 'rgba(255,200,120,.9)', 350);
      Sfx.play(e.k === 'clash' ? 'wlClash' : 'wlBoom');
      break;
    case 'bolt':
      bolts.push({ ...e, t0: performance.now() });
      Sfx.play('wlBolt');
      break;
    case 'blink':
      burst(e.x1, e.y1, 20, ['#fff', '#b7f0ff'], 200, 500, 3);
      burst(e.x2, e.y2, 20, ['#fff', '#b7f0ff'], 200, 500, 3);
      Sfx.play('wlBlink');
      break;
    case 'swap':
      ring(e.x1, e.y1, 80, 'rgba(90,210,255,.9)', 450);
      ring(e.x2, e.y2, 80, 'rgba(90,210,255,.9)', 450);
      Sfx.play('wlBlink');
      break;
    case 'scourge':
      ring(e.x, e.y, e.r, 'rgba(255,40,40,.9)', 450);
      burst(e.x, e.y, 30, ['#ff5a5a', '#8a0a0a'], 420, 450, 4);
      shake(5, 200);
      Sfx.play('wlScourge');
      break;
    case 'meteor':
      ring(e.x, e.y, e.r, 'rgba(255,150,40,.95)', 600);
      burst(e.x, e.y, 60, ['#ffe08a', '#ff7a1a', '#5a2a1a'], 520, 800, 5);
      shake(12, 350);
      Sfx.play('wlMeteor');
      break;
    case 'reflect':
      ring(e.x, e.y, 40, 'rgba(200,245,255,1)', 250);
      Sfx.play('wlShield');
      break;
    case 'link':
      Sfx.play('wlChain');
      break;
    case 'hit':
      floaters.push({ x: e.x, y: e.y, text: `-${e.n}`, t0: performance.now() });
      if (e.id === me) { shake(4, 150); Sfx.play('wlHurt'); }
      break;
    case 'burn':
      if (s) {
        const p = s.p.find((q) => q.id === e.id);
        if (p) burst(p.x, p.y, 4, ['#ffb35c', '#ff4a10'], 90, 500, 3);
        if (e.id === me) Sfx.play('wlBurn');
      }
      break;
    case 'death':
      burst(e.x, e.y, 50, ['#ff8a1c', '#ffd27a', '#3a1a0a'], 420, 900, 5);
      ring(e.x, e.y, 160, 'rgba(255,120,40,.9)', 600);
      shake(8, 300);
      Sfx.play('wlDeath');
      feed(e.by ? `💀 ${names[e.by] || '?'} ➜ ${names[e.id] || '?'}` : `🔥 ${t('{name} burned in the lava', { name: names[e.id] || '?' })}`);
      break;
    case 'shrink':
      sinkRing(shownLayer || e.layer + 1, e.layer);
      shownLayer = e.layer;
      shake(3, 400);
      Sfx.play('wlShrink');
      break;
    case 'fight':
      shownLayer = 0;
      EndFx.close();
      banner(t('FIGHT!'), t('Round {n}', { n: e.round }));
      Sfx.play('wlHorn');
      break;
    case 'shop':
      readySent = false;
      Sfx.play('notify');
      break;
    case 'roundEnd': {
      const w = e.winner;
      banner(w === me ? t('ROUND WON!') : w ? t('{name} wins the round', { name: names[w] || '?' }) : t('Nobody survived'), '', 2600);
      Sfx.play(w === me ? 'roundWin' : 'roundLose');
      break;
    }
    case 'over': {
      const order = s.p.slice().sort((a, b) => b.sc - a.sc || b.k - a.k);
      const won = order[0] && order[0].id === me;
      EndFx.show({
        outcome: won ? 'win' : 'lose',
        title: won ? t('You won!') : t('{name} wins!', { name: names[order[0].id] || '?' }),
        detail: order.map((p) => `${names[p.id] || '?'} ${p.sc}`).join(' · '),
        buttons: [{ label: t('Close'), primary: true, action: () => window.close() }],
      });
      break;
    }
    default:
      break;
  }
}

function drawEffects(now, dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    const k = (now - p.t0) / p.life;
    if (k >= 1) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.96;
    p.vy *= 0.96;
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = p.c;
    const s = p.s * (1 - k * 0.5);
    ctx.fillRect(sx(p.x) - s / 2, sy(p.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    const k = (now - r.t0) / r.life;
    if (k >= 1) { rings.splice(i, 1); continue; }
    ctx.strokeStyle = r.color;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 3 * (1 - k) + 1;
    ctx.beginPath(); ctx.arc(sx(r.x), sy(r.y), r.r * scale * (0.3 + 0.7 * k), 0, 7); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i];
    const k = (now - b.t0) / 220;
    if (k >= 1) { bolts.splice(i, 1); continue; }
    ctx.strokeStyle = `rgba(200,230,255,${1 - k})`;
    ctx.shadowColor = '#8fd0ff';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx(b.x1), sy(b.y1));
    const segs = 9;
    for (let j = 1; j <= segs; j++) {
      const f = j / segs;
      const jit = j === segs ? 0 : (Math.random() - 0.5) * 40;
      ctx.lineTo(sx(b.x1 + (b.x2 - b.x1) * f) + jit * scale * 2, sy(b.y1 + (b.y2 - b.y1) * f) + jit * scale * 2);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.font = '800 14px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    const k = (now - f.t0) / 900;
    if (k >= 1) { floaters.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - k;
    ctx.fillStyle = '#ff5a4a';
    ctx.fillText(f.text, sx(f.x), sy(f.y) - 30 - k * 30);
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ frame
let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!started || !snaps.length) return;
  const s = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[0] : s;
  // Smooth positions between the last two snapshots.
  const k = Math.min(1, (now - snapAt) / (TICK * 1000));
  const mine = myPawn(s);
  const follow = mine && !mine.d && s.ph === 'fight';
  const targetScale = follow ? followScale() : fitScale(s);
  scale += (targetScale - scale) * Math.min(1, dt * 4);
  const mp = follow ? (prev.p.find((q) => q.id === me) || mine) : null;
  const tx = follow ? mp.x + (mine.x - mp.x) * k : 0;
  const ty = follow ? mp.y + (mine.y - mp.y) * k : 0;
  camX += (tx - camX) * Math.min(1, dt * 6);
  camY += (ty - camY) * Math.min(1, dt * 6);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  if (now < shakeUntil) ctx.translate((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp);
  else shakeAmp = 0;
  drawArena(s, now);
  if (moveMark && now - moveMark.t < 500) {
    const a = 1 - (now - moveMark.t) / 500;
    ctx.strokeStyle = `rgba(120,255,140,${a})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx(moveMark.x), sy(moveMark.y), 6 + (1 - a) * 10, 0, 7); ctx.stroke();
  }
  drawProjectiles(s, (now - snapAt) / 1000, now);
  for (const p of s.p) {
    if (p.d || p.l) continue;
    const q = prev.p.find((x) => x.id === p.id) || p;
    const x = q.d ? p.x : q.x + (p.x - q.x) * k;
    const y = q.d ? p.y : q.y + (p.y - q.y) * k;
    drawWarlock(p, sx(x), sy(y), s, now);
  }
  drawEffects(now, dt);
  ctx.restore();
  updateCooldowns(s, now);
}

// ------------------------------------------------------------------ HUD
function myPawn(s) { return s && s.p.find((p) => p.id === me); }

function renderHud(s) {
  const p = myPawn(s);
  $('roundInfo').textContent = s.round ? t('Round {n} of {m}', { n: s.round, m: s.rounds }) : t('Get ready');
  $('phaseInfo').textContent = s.ph === 'shop' ? t('Shop closes in {n} s', { n: Math.ceil(s.left) })
    : s.ph === 'fight' ? (s.layer > 1 ? t('Platform sinks in {n} s', { n: Math.ceil(s.shrink) }) : t('Last tile!'))
      : s.ph === 'over' ? t('Match over') : '';
  const order = s.p.slice().sort((a, b) => b.sc - a.sc || b.k - a.k);
  $('scores').innerHTML = order.map((q) => `<div class="row${q.d && s.ph === 'fight' ? ' dead' : ''}"><i style="background:${colorOf(q.id, s)}"></i>${esc(names[q.id] || '?')}${q.id === me ? ' ★' : ''}<small>${q.k}💀</small><b>${q.sc}</b></div>`).join('');
  if (p) {
    $('hpFill').style.width = `${Math.max(0, (p.hp / p.mx) * 100)}%`;
    $('hpText').textContent = p.d ? t('Dead – wait for the next round') : `${p.hp} / ${p.mx}`;
    $('dpText').textContent = `${t('Knockback')} +${Math.round(p.dp / 10)}%`;
  }
  renderSpellBar(p);
  const inShop = s.ph === 'shop';
  $('shop').classList.toggle('hidden', !inShop);
  if (inShop) renderShop(s, p);
}

let spellBarKey = '';
function renderSpellBar(p) {
  if (!p) return;
  const key = JSON.stringify(p.sp);
  if (key === spellBarKey) return;
  spellBarKey = key;
  $('spellBar').innerHTML = KEYS.map((k, slot) => {
    const sp = p.sp[slot];
    const def = sp && SPELLS[sp[0]];
    return `<div class="spell${def ? '' : ' empty'}" data-slot="${slot}" title="${def ? esc(def.name) : ''}"><span class="key">${k}</span>${def ? def.icon : ''}${def ? `<span class="lvl">${sp[1]}</span>` : ''}<div class="cd"></div></div>`;
  }).join('');
}

function updateCooldowns(s, now) {
  const p = myPawn(s);
  if (!p) return;
  const since = (now - snapAt) / 1000;
  for (const el of $('spellBar').children) {
    const slot = el.dataset.slot;
    const sp = p.sp[slot];
    const cdEl = el.lastElementChild;
    if (!sp) continue;
    const left = Math.max(0, (p.cd[slot] || 0) - since);
    const total = Warlock.lv(SPELLS[sp[0]].cd, sp[1]);
    cdEl.style.setProperty('--cd', `${(left / total) * 100}%`);
    cdEl.textContent = left > 0.05 ? (left < 1 ? left.toFixed(1) : Math.ceil(left)) : '';
    el.classList.toggle('ready', left <= 0.05);
  }
}

let readySent = false;
function renderShop(s, p) {
  if (!p) return;
  $('gold').textContent = `💰 ${p.c}`;
  $('shopTime').textContent = t('Next round in {n} s', { n: Math.ceil(s.left) });
  const cols = [1, 2, 3, 4, 5, 6];
  const html = cols.map((col) => {
    const owned = p.sp[col];
    return `<div class="shop-col"><h4>${KEYS[col]}</h4>${COLUMN_SPELLS[col].map((k) => {
      const def = SPELLS[k];
      const mine = owned && owned[0] === k;
      const level = mine ? owned[1] : 0;
      const price = mine ? (level >= 7 ? null : def.up[level - 1]) : def.buy;
      const locked = owned && !mine;
      return `<button class="buy${mine ? ' owned' : ''}${locked ? ' locked' : ''}${price !== null && p.c < price ? ' poor' : ''}" data-buy="${k}" data-tip="${esc(spellTip(k))}">
        <span class="ic">${def.icon}</span><span class="nm">${esc(def.name)}</span>
        <span class="pr">${locked ? '—' : price === null ? t('Max') : `💰 ${price}`}</span>${mine ? `<span class="lv">${'●'.repeat(level)}${'○'.repeat(7 - level)}</span>` : ''}</button>`;
    }).join('')}</div>`;
  }).join('');
  const fb = p.sp[0];
  const sc = p.sp[7];
  const items = [
    ['fireball', SPELLS.fireball, fb ? fb[1] : 1, 7],
    ['scourge', SPELLS.scourge, sc ? sc[1] : 1, 3],
    ...Object.entries(ITEMS).map(([k, def]) => [k, def, p.it[k] || 0, def.max]),
  ].map(([k, def, level, max]) => {
    const price = level >= max ? null : (SPELLS[k] ? def.up[level - 1] : def.buy);
    return `<button class="buy${level ? ' owned' : ''}${price !== null && p.c < price ? ' poor' : ''}" data-buy="${k}" data-tip="${esc(itemTip(k))}"><span class="ic">${def.icon}</span>
      <span class="nm">${esc(def.name)} ${level ? `(${level}/${max})` : ''}</span><span class="pr">${price === null ? t('Max') : `💰 ${price}`}</span></button>`;
  }).join('');
  if ($('shopCols').dataset.html !== html) { $('shopCols').innerHTML = html; $('shopCols').dataset.html = html; }
  if ($('shopItems').dataset.html !== items) { $('shopItems').innerHTML = items; $('shopItems').dataset.html = items; }
  $('btnReady').textContent = readySent ? `✓ ${t('Ready')}` : t('Ready');
  $('btnReady').classList.toggle('done', readySent);
}

function spellTip(k) {
  const d = SPELLS[k];
  const bits = [];
  if (d.dmg) bits.push(`${t('Damage')} ${d.dmg[0]}–${d.dmg[d.dmg.length - 1]}`);
  bits.push(`${t('Cooldown')} ${d.cd[0]}–${d.cd[d.cd.length - 1]} s`);
  const about = {
    lightning: t('Instant bolt that hits the first warlock in a line.'),
    homing: t('Slow orb that follows the nearest enemy.'),
    boomerang: t('Flies out in a curve and comes back to you.'),
    teleport: t('Blink to the cursor.'),
    thrust: t('Charge forward and slam into a warlock.'),
    swap: t('Swap places with the warlock you hit (or jump to its end).'),
    cluster: t('Four small fireballs in a fan.'),
    bouncer: t('Jumps from warlock to warlock, weaker each time.'),
    meteor: t('Falls from the sky after a moment; huge push in the middle.'),
    windwalk: t('Invisible and faster; your next touch hits hard.'),
    shield: t('Turns enemy spells around and sends them back.'),
    rush: t('Faster; absorbs half the damage you take.'),
    gravity: t('A black hole that pulls warlocks and spells in.'),
    link: t('Chains a warlock and pulls them to you.'),
  }[k] || '';
  return `${d.name}: ${about} ${bits.join(' · ')}`;
}

function itemTip(k) {
  return {
    fireball: t('Fireball: your basic spell (Q). Upgrades add damage.'),
    scourge: t('Scourge: damages everyone around you, and you (X).'),
    ring: t('Ring of Health: more maximum health.'),
    cape: t('Cape: faster health regeneration.'),
    armor: t('Armor: less knockback.'),
    boots: t('Boots: faster movement.'),
  }[k] || '';
}

$('shop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-buy]');
  if (b) {
    const k = b.dataset.buy;
    if (isHost) sim.buy(me, k);
    else toHost({ kind: 'wl-buy', k });
    Sfx.play('wlCoin');
  }
});
$('shop').addEventListener('mouseover', (e) => {
  const b = e.target.closest('[data-tip]');
  $('shopTip').textContent = b ? b.dataset.tip : '';
});
$('btnReady').addEventListener('click', () => {
  readySent = true;
  if (isHost) sim.setReady(me);
  else toHost({ kind: 'wl-ready' });
});

// ------------------------------------------------------------------ start
async function init() {
  info = await api.warlockInfo(conv, gameId);
  if (!info) return window.close();
  t = (k, v) => I18N.translate(info.language, k, v);
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t(e.dataset.t);
  me = info.me;
  isHost = info.host === me;
  names[me] = info.myName;
  names[info.host] = info.hostName;
  resize();
  if (isHost) {
    players = [{ id: me, name: info.myName }];
  } else {
    players = [];
    const join = () => { if (!started) toHost({ kind: 'wl-join', name: info.myName }); };
    join();
    const timer = setInterval(() => (started ? clearInterval(timer) : join()), 1500);
  }
  renderLobby();
  window.addEventListener('beforeunload', () => {
    if (isHost) toAll({ kind: 'wl-closed' });
    else toHost({ kind: 'wl-leave' });
  });
  requestAnimationFrame(frame);
}

init();
