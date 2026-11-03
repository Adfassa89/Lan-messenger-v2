/* global api, I18N, Tanks, TankLevels, Sfx, EndFx */
import { View, THEMES, POWER_ICON } from './tanks3d.js';
// Tank window: lobby, the live game and the scores. Same network design as
// Warlock and Pudge Wars: the PC that opened the game (the host) runs
// Tanks.Game and sends a snapshot every tick; the other PC sends its keys.

const params = new URLSearchParams(location.search);
const conv = params.get('conv');
const gameId = params.get('id');
let t = (k, v) => I18N.translate(params.get('lang') || 'en', k, v);
const $ = (id) => document.getElementById(id);
const { TICK } = Tanks;
const PREFS_KEY = 'lanmsg.tanks.v1';
const THEME_LIST = ['classic', 'mine', 'toy'];
const THEME_NAMES = { classic: 'Classic', mine: 'Mine site', toy: 'Toy tanks' };
const ARENA_NAMES = ['Crossroads', 'Islands', 'Fortress'];
const POWER_NAMES = { shield: 'Shield', power: 'Power shell', rapid: 'Rapid fire', ricochet: 'Ricochet', freeze: 'Freeze', fortify: 'Fortify', airstrike: 'Airstrike', life: 'Extra life' };
const KIND_NAMES = { scout: 'Scout', trooper: 'Trooper', heavy: 'Heavy', rocket: 'Rocket', drone: 'Drone' };

let info = null;
let isHost = false;
let me = null;
let players = []; // [{ id, name, best }]
const opts = { mode: 'coop', theme: 'classic', level: 1, arena: 0, minutes: 5 };
let started = false;
let game = null;
let prev = null;
let cur = null;
let curAt = 0;
let gap = TICK * 1000;
let grid = '';
let posted = false;
let menuOpen = false;
const names = {};
const prefs = { best: 1, theme: 'classic' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* defaults */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };
opts.theme = THEME_LIST.includes(prefs.theme) ? prefs.theme : 'classic';

function send(peerId, data) { api.rtcSend(peerId, gameId, data); }
function toOther(data) { for (const p of players) if (p.id !== me) send(p.id, data); }
function toHost(data) { send(info.host, data); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const bestLevel = () => Math.max(1, ...players.map((p) => Number(p.best) || 1), prefs.best || 1);

// ------------------------------------------------------------------ lobby
function seg(id, items, value, attr) {
  const html = items.map(([v, label]) => `<button data-${attr}="${v}" class="wide${String(v) === String(value) ? ' on' : ''}"${isHost ? '' : ' disabled'}>${esc(label)}</button>`).join('');
  if ($(id).dataset.html !== html) { $(id).innerHTML = html; $(id).dataset.html = html; }
}

function renderLobby() {
  $('lobbySub').textContent = isHost
    ? (players.length < 2 ? t('Waiting for {name} to join…', { name: info.otherName || t('the other player') }) : t('Both players are here. Choose and start.'))
    : started ? t('The match has started.') : t('Waiting for {name} to start the match…', { name: info.hostName });
  const cols = THEMES[opts.theme].players;
  const list = players.map((p, i) => `<li><i style="color:${cols[i]};background:${cols[i]}"></i>${esc(p.name)} <b style="color:${cols[i]}">P${i + 1}</b>${p.id === info.host ? `<small>${esc(t('Host'))}</small>` : ''}</li>`).join('');
  if ($('lobbyList').dataset.html !== list) { $('lobbyList').innerHTML = list; $('lobbyList').dataset.html = list; }
  seg('modeSeg', [['coop', t('Co-op: defend the base')], ['versus', t('1 v 1')]], opts.mode, 'mode');
  seg('themeSeg', THEME_LIST.map((k) => [k, t(THEME_NAMES[k])]), opts.theme, 'theme');
  seg('arenaSeg', ARENA_NAMES.map((n, i) => [i, t(n)]), opts.arena, 'arena');
  seg('timeSeg', [3, 5, 8].map((m) => [m, t('{n} min', { n: m })]), opts.minutes, 'min');
  const coop = opts.mode === 'coop';
  $('levelRow').classList.toggle('hidden', !coop);
  $('arenaRow').classList.toggle('hidden', coop);
  $('timeRow').classList.toggle('hidden', coop);
  const best = bestLevel();
  $('lvNum').textContent = opts.level;
  $('lvDown').disabled = !isHost || opts.level <= 1;
  $('lvUp').disabled = !isHost || opts.level >= best;
  $('lvBest').textContent = t('Reached: level {n} of 50', { n: best });
  $('lobbyRules').textContent = coop
    ? t('Work together: stop every enemy tank and keep the base safe. 50 levels, each a little harder. 3 lives each, plus one every 5 levels.')
    : t('Each player has a base. Destroy the other base, or have the most kills when time runs out. Drones attack whoever is closest; power-ups appear in the middle.');
  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnStart').disabled = players.length < 2;
  $('btnStart').textContent = players.length < 2 ? t('Waiting for players…') : t('Start');
  $('lobbyHelp').innerHTML = helpHtml();
}

function helpHtml() {
  return `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> ${esc(t('drive'))} · <kbd>Space</kbd> / <kbd>J</kbd> ${esc(t('fire'))}`
    + `${opts.mode === 'versus' ? ` · <kbd>E</kbd> / <kbd>K</kbd> ${esc(t('build a brick wall'))}` : ''} · <kbd>Esc</kbd> ${esc(t('Menu'))}<br>`
    + `${esc(t('Bricks break, steel needs 3 power shells, water blocks tanks, bushes hide you, ice is slippery, and teleporters link in pairs.'))}<br>`
    + `${esc(t('Power-ups:'))} ${Object.keys(POWER_ICON).map((k) => `${POWER_ICON[k]} ${esc(t(POWER_NAMES[k]))}`).join(' · ')}`;
}

const lobbyMsg = () => ({ kind: 'tk-lobby', players, opts });
function setOpt(k, v) {
  if (!isHost || started) return;
  opts[k] = v;
  if (k === 'theme') { prefs.theme = v; savePrefs(); if (view) view.setTheme(v); }
  renderLobby();
  toOther(lobbyMsg());
  Sfx.play('tkTally');
}
$('modeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setOpt('mode', b.dataset.mode); });
$('themeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-theme]'); if (b) setOpt('theme', b.dataset.theme); });
$('arenaSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-arena]'); if (b) setOpt('arena', Number(b.dataset.arena)); });
$('timeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-min]'); if (b) setOpt('minutes', Number(b.dataset.min)); });
$('lvDown').addEventListener('click', () => setOpt('level', Math.max(1, opts.level - 1)));
$('lvUp').addEventListener('click', () => setOpt('level', Math.min(bestLevel(), opts.level + 1)));

$('btnStart').addEventListener('click', () => {
  if (!isHost || started || players.length < 2) return;
  started = true;
  game = new Tanks.Game(players.map((p) => ({ id: p.id, name: p.name })), { ...opts, seed: Math.floor(Math.random() * 2 ** 31) });
  toOther({ kind: 'tk-start', opts });
  enterGame();
  hostLoop();
});

function enterGame() {
  started = true;
  $('lobby').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (view && view.themeName !== opts.theme) view.setTheme(opts.theme);
}

// ------------------------------------------------------------------ host loop
function hostLoop() {
  let acc = 0;
  let last = performance.now();
  let sentGv = -1;
  let n = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    let stepped = false;
    const events = [];
    while (acc >= TICK) {
      acc -= TICK;
      game.step();
      events.push(...game.takeEvents());
      stepped = true;
    }
    if (!stepped) return;
    n++;
    // The field goes along when it changed, and now and then anyway.
    const withGrid = game.gridVersion !== sentGv || n % 30 === 0;
    sentGv = game.gridVersion;
    const snap = game.snapshot(withGrid);
    snap.fx = events.concat(snap.fx);
    toOther({ kind: 'tk-snap', s: snap });
    onSnap(snap);
    if (snap.over) {
      clearInterval(timer);
      postResults(snap);
    }
  }, 8);
}

function postResults(s) {
  if (posted) return;
  posted = true;
  const nm = (id) => names[id] || '?';
  let text;
  if (s.mode === 'coop') {
    const lines = s.pl.map((p) => `${p.slot === 0 ? '🟡' : '🟢'} ${nm(p.id)} – ${t('{n} points', { n: p.score })}, ${t('{n} tanks', { n: Object.values(p.kills).reduce((a, b) => a + b, 0) })}`);
    const head = s.over.reason === 'won' ? t('All 50 levels cleared!') : t('Reached level {n}', { n: s.over.level });
    text = `🪖 ${t('Tank')} (${t('co-op')}) – ${head}\n${lines.join('\n')}`;
  } else {
    const [a, b] = s.pl;
    const head = s.over.winner ? t('{name} wins!', { name: nm(s.over.winner) }) : t('Draw');
    text = `🪖 ${t('Tank')} 1v1 – ${head} ${a.score} : ${b.score}\n${nm(a.id)} – ${nm(b.id)}`;
  }
  api.warlockResult(conv, gameId, text).catch(() => {});
}

// ------------------------------------------------------------------ network
api.on(({ type, payload }) => {
  if (type !== 'rtc' || payload.sid !== gameId) return;
  const from = payload.peerId;
  const d = payload.data || {};
  if (isHost) {
    switch (d.kind) {
      case 'tk-join':
        if (!players.some((p) => p.id === from)) {
          if (started || players.length >= 2) { send(from, { kind: 'tk-full' }); return; }
          players.push({ id: from, name: String(d.name || '?').slice(0, 40), best: Math.max(1, Math.min(50, Number(d.best) || 1)) });
          names[from] = players[players.length - 1].name;
          Sfx.play('notify');
        }
        renderLobby();
        toOther(lobbyMsg());
        break;
      case 'tk-leave':
        if (!started) {
          players = players.filter((p) => p.id !== from);
          renderLobby();
        } else if (game) game.leave(from);
        break;
      case 'tk-in':
        if (game) game.input(from, d.i || {});
        break;
      default:
        break;
    }
    return;
  }
  if (from !== info.host) return;
  switch (d.kind) {
    case 'tk-lobby':
      players = Array.isArray(d.players) ? d.players : [];
      for (const p of players) names[p.id] = p.name;
      if (d.opts) {
        const themeChanged = d.opts.theme !== opts.theme;
        Object.assign(opts, d.opts);
        if (themeChanged && view) view.setTheme(opts.theme);
      }
      renderLobby();
      break;
    case 'tk-start':
      if (d.opts) Object.assign(opts, d.opts);
      if (!started) enterGame();
      break;
    case 'tk-snap':
      if (!started) enterGame();
      onSnap(d.s);
      break;
    case 'tk-full':
      $('lobbySub').textContent = t('This match has already started.');
      break;
    case 'tk-closed':
      $('lobbySub').textContent = t('{name} closed the arena.', { name: info.hostName });
      $('lobby').classList.remove('hidden');
      $('btnStart').classList.add('hidden');
      break;
    default:
      break;
  }
});

function sendInput(i) {
  if (isHost) { if (game) game.input(me, i); } else toHost({ kind: 'tk-in', i });
}

// ------------------------------------------------------------------ snapshots
function onSnap(s) {
  const now = performance.now();
  if (cur) gap = Math.max(16, Math.min(120, gap * 0.8 + (now - curAt) * 0.2));
  prev = cur;
  cur = s;
  curAt = now;
  if (s.grid) grid = s.grid;
  if (view && grid) view.setGrid(grid, s.pads, s.bases);
  for (const e of s.fx || []) effect(e, s);
  renderHud(s);
}

// Positions between the last two snapshots, so movement is smooth at any frame rate.
function interpolated() {
  if (!cur) return null;
  const k = prev ? Math.min(1, (performance.now() - curAt) / gap) : 1;
  const before = new Map((prev ? prev.tk : []).map((x) => [x[0], x]));
  const lerp = (a, b) => a + (b - a) * k;
  const tanks = cur.tk.map((x) => {
    const p = before.get(x[0]);
    if (!p || Math.abs(p[3] - x[3]) > 3 || Math.abs(p[4] - x[4]) > 3) return x; // teleported
    const out = x.slice();
    out[3] = lerp(p[3], x[3]);
    out[4] = lerp(p[4], x[4]);
    return out;
  });
  const shellsBefore = new Map((prev ? prev.bl : []).map((x) => [x[0], x]));
  const bullets = cur.bl.map((x) => {
    const p = shellsBefore.get(x[0]);
    if (!p) return x;
    const out = x.slice();
    out[1] = lerp(p[1], x[1]);
    out[2] = lerp(p[2], x[2]);
    return out;
  });
  const slotNames = [];
  for (const p of cur.pl) slotNames[p.slot] = names[p.id] || `P${p.slot + 1}`;
  return { tanks, bullets, powerups: cur.pu, bases: cur.bases, freeze: cur.freeze, mode: cur.mode, names: slotNames };
}

// ------------------------------------------------------------------ sounds and effects
const lastSound = {};
function sound(name, gapMs = 40) {
  const now = performance.now();
  if (now - (lastSound[name] || 0) < gapMs) return;
  lastSound[name] = now;
  Sfx.play(name);
}
let bannerTimer = 0;
function banner(html, ms = 2200) {
  const b = $('banner');
  b.innerHTML = html;
  b.classList.remove('hidden');
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
}
function mySlot(s) { const p = s && s.pl.find((q) => q.id === me); return p ? p.slot : 0; }

function effect(e, s) {
  if (view) view.fx(e, s);
  switch (e.e) {
    case 'fire': sound(e.kind === 'player' ? 'tkFire' : e.kind === 'rocket' ? 'tkRocket' : 'tkFireEnemy', e.kind === 'player' ? 30 : 90); break;
    case 'wall': sound(e.steel ? 'tkSteel' : 'tkBrick', 50); break;
    case 'boom': sound(e.kind === 'heavy' || e.big ? 'tkBigBoom' : 'tkBoom', 60); break;
    case 'clash': sound('tkClash'); break;
    case 'bounce': sound('tkBounce'); break;
    case 'armor': sound('tkArmor'); break;
    case 'shieldHit': sound('tkShield'); break;
    case 'tele': sound('tkTele'); break;
    case 'spawn': sound('tkSpawn', 200); break;
    case 'powerup': sound('tkPowerup'); break;
    case 'build': sound('tkBuild'); break;
    case 'baseHit': sound('tkBaseHit'); break;
    case 'baseDown': sound('tkBaseDown'); break;
    case 'sudden': sound('tkSudden'); banner(`${esc(t('Sudden death!'))}<small>${esc(t('The next kill wins.'))}</small>`, 3000); break;
    case 'got': {
      const name = { freeze: 'tkFreeze', airstrike: 'tkAirstrike', fortify: 'tkFortify', life: 'tkLife', shield: 'tkShield' }[e.type] || 'tkPick';
      Sfx.play(name);
      const tk = s.tk.find((x) => x[0] === e.id);
      if (view && tk) view.floater(tk[3] + 1, tk[4] + 1, `${POWER_ICON[e.type] || ''} ${t(POWER_NAMES[e.type] || '')}`, THEMES[opts.theme].players[e.slot] || '#fff');
      break;
    }
    case 'level':
      Sfx.play('tkStart');
      $('tally').classList.add('hidden');
      banner(e.mode === 'coop' ? `${esc(t('Level {n}', { n: e.level }))}<small>${esc(t('of 50'))}</small>` : `${esc(t('1 v 1'))}<small>${esc(t(ARENA_NAMES[opts.arena] || ''))}</small>`);
      if (e.mode === 'coop' && e.level > (prefs.best || 1)) { prefs.best = e.level; savePrefs(); }
      break;
    case 'clear':
      Sfx.play('tkClear');
      showTally(s, e.level);
      if (e.level + 1 > (prefs.best || 1) && e.level < 50) { prefs.best = e.level + 1; savePrefs(); }
      break;
    case 'over': gameOver(e, s); break;
    default: break;
  }
}

function showTally(s, level) {
  const kinds = ['scout', 'trooper', 'heavy', 'rocket'];
  const pts = { scout: 100, trooper: 200, heavy: 400, rocket: 300 };
  const head = `<tr><th></th>${s.pl.map((p) => `<th style="color:${THEMES[opts.theme].players[p.slot]}">${esc(names[p.id] || `P${p.slot + 1}`)}</th>`).join('')}</tr>`;
  const rows = kinds.map((k) => `<tr><td>${esc(t(KIND_NAMES[k]))} <small>×${pts[k]}</small></td>${s.pl.map((p) => `<td>${p.kills[k] || 0}</td>`).join('')}</tr>`).join('');
  const total = `<tr class="total"><td>${esc(t('Points'))}</td>${s.pl.map((p) => `<td>${p.score}</td>`).join('')}</tr>`;
  $('tally').innerHTML = `<h2>${esc(t('Level {n} cleared!', { n: level }))}</h2><table>${head}${rows}${total}</table><div class="next">${esc(level >= 50 ? t('That was the last level!') : t('Level {n} starts in a moment…', { n: level + 1 }))}</div>`;
  $('tally').classList.remove('hidden');
  let i = 0;
  const tick = setInterval(() => { Sfx.play('tkTally'); if (++i >= 6) clearInterval(tick); }, 120);
}

function gameOver(e, s) {
  $('tally').classList.add('hidden');
  stopEngine();
  if (s.mode === 'coop') {
    const won = e.reason === 'won';
    const why = { base: t('The base was destroyed.'), lives: t('No lives left.'), left: t('The other player left.') }[e.reason] || '';
    EndFx.show({
      outcome: won ? 'win' : 'lose',
      title: won ? t('All 50 levels cleared!') : t('Game over'),
      detail: won ? '' : `${why} ${t('You reached level {n}.', { n: s.over.level })}`,
      buttons: [{ label: t('Close'), primary: true, action: () => window.close() }],
    });
  } else {
    const won = e.winner === me;
    const why = { base: t('Base destroyed.'), time: t('Time is up.'), sudden: t('Sudden death.'), left: t('The other player left.') }[e.reason] || '';
    const [a, b] = s.pl;
    EndFx.show({
      outcome: !e.winner ? 'draw' : won ? 'win' : 'lose',
      title: !e.winner ? t('Draw') : won ? t('You won!') : t('{name} wins!', { name: names[e.winner] || '?' }),
      detail: `${why} ${a.score} : ${b.score}`,
      buttons: [{ label: t('Close'), primary: true, action: () => window.close() }],
    });
  }
}

// ------------------------------------------------------------------ HUD
function renderHud(s) {
  const cols = THEMES[opts.theme].players;
  const nm = (p) => esc(names[p.id] || `P${p.slot + 1}`);
  let top;
  if (s.mode === 'coop') {
    top = `<span class="lvl">${esc(t('Level {n}', { n: s.level }))} / 50</span><span>🎯 ${esc(t('{n} enemies left', { n: s.enemies }))}</span>${s.freeze > 0 ? `<span>❄️ ${Math.ceil(s.freeze)}</span>` : ''}${s.fortify > 0 ? `<span>🧱 ${Math.ceil(s.fortify)}</span>` : ''}`;
  } else {
    const [a, b] = s.pl;
    const m = Math.floor(s.ends / 60);
    const sec = String(s.ends % 60).padStart(2, '0');
    top = `<span class="vs"><b style="color:${cols[0]}">${a.score}</b><i>${esc(t('kills'))}</i><b style="color:${cols[1]}">${b.score}</b></span><span class="clock${s.ends <= 30 ? ' low' : ''}">${s.sudden ? esc(t('Sudden death!')) : `⏱ ${m}:${sec}`}</span>`;
  }
  if ($('topBar').dataset.html !== top) { $('topBar').innerHTML = top; $('topBar').dataset.html = top; }
  for (const p of s.pl) {
    const el = p.slot === 0 ? $('sideP1') : $('sideP2');
    const rows = [];
    if (s.mode === 'coop') rows.push(`<div class="row">❤️ <b>${p.lives}</b> <span>⭐ ${'★'.repeat(p.power)}${'☆'.repeat(3 - p.power)}</span>${p.rapid ? '⚡' : ''}</div>`, `<div class="row">${esc(t('Points'))}: <b>${p.score}</b></div>`);
    else rows.push(`<div class="row">💥 <b>${p.score}</b> <span class="pw">${'★'.repeat(p.power)}${'☆'.repeat(3 - p.power)}</span>${p.rapid ? '⚡' : ''}</div>`, `<div class="row">🧱 <b>${p.walls}</b> / 10</div>`);
    if (!p.alive) rows.push(`<div class="wait">${p.lives > 0 && p.respawn ? esc(t('Back in {n} s', { n: p.respawn })) : s.mode === 'coop' && p.lives <= 0 ? esc(t('Out of lives')) : ''}</div>`);
    const html = `<div class="nm"><i style="color:${cols[p.slot]};background:${cols[p.slot]}"></i>${nm(p)}${p.id === me ? ' ★' : ''}</div>${rows.join('')}`;
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    el.classList.toggle('dead', !p.alive);
  }
  // Co-op: the enemies still to come, and the base's health.
  let box = '';
  if (s.mode === 'coop') {
    const base = s.bases[0];
    box = `${'<i></i>'.repeat(Math.min(25, s.queue))}<div class="base-hp">🏠 ${base ? Array.from({ length: base[5] }, (_, i) => `<u class="${i < base[4] ? '' : 'off'}"></u>`).join('') : ''}</div>`;
  } else {
    box = s.bases.map((b) => `<div class="base-hp"><span style="color:${cols[b[2]]}">🏠</span> ${Array.from({ length: b[5] }, (_, i) => `<u class="${i < b[4] ? '' : 'off'}" style="${i < b[4] ? `background:${cols[b[2]]}` : ''}"></u>`).join('')}</div>`).join('');
  }
  if ($('enemyBox').dataset.html !== box) { $('enemyBox').innerHTML = box; $('enemyBox').dataset.html = box; }
  $('freezeTint').classList.toggle('hidden', !(s.freeze > 0));
  const mine = s.pl.find((p) => p.id === me);
  engineTarget = mine && mine.alive ? 1 : 0;
}

// ------------------------------------------------------------------ engine hum
let engine = null;
let engineTarget = 0;
function startEngine() {
  if (engine) return;
  const a = Sfx.context();
  if (!a) return;
  const o = a.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = 42;
  const o2 = a.createOscillator();
  o2.type = 'square';
  o2.frequency.value = 21;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 180;
  const g = a.createGain();
  g.gain.value = 0;
  o.connect(f);
  o2.connect(f);
  f.connect(g).connect(a.destination);
  o.start();
  o2.start();
  engine = { a, o, o2, f, g };
}
function updateEngine(moving) {
  if (!engine) return;
  const now = engine.a.currentTime;
  const vol = engineTarget ? (moving ? 0.05 : 0.018) : 0;
  engine.g.gain.setTargetAtTime(vol, now, 0.12);
  engine.o.frequency.setTargetAtTime(moving ? 62 : 40, now, 0.25);
  engine.o2.frequency.setTargetAtTime(moving ? 31 : 20, now, 0.25);
  engine.f.frequency.setTargetAtTime(moving ? 320 : 160, now, 0.25);
}
function stopEngine() {
  if (!engine) return;
  try { engine.o.stop(); engine.o2.stop(); } catch { /* already stopped */ }
  engine = null;
}

// ------------------------------------------------------------------ 3D view
let view = null;
try {
  view = new View($('view'), $('labels'), opts.theme);
} catch (err) {
  console.error(err);
}
window.addEventListener('resize', () => view && view.resize());

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const state = interpolated();
  if (view) view.frame(dt, state);
  if (state) {
    const mine = cur.tk.find((x) => x[11] === mySlot(cur));
    updateEngine(!!(mine && mine[6]));
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ keys
const DIR_KEYS = { KeyW: 0, ArrowUp: 0, KeyD: 1, ArrowRight: 1, KeyS: 2, ArrowDown: 2, KeyA: 3, ArrowLeft: 3 };
const FIRE_KEYS = ['Space', 'KeyJ', 'Enter', 'NumpadEnter', 'ControlLeft', 'ControlRight'];
const BUILD_KEYS = ['KeyE', 'KeyK', 'ShiftLeft', 'ShiftRight'];
const held = []; // directions in the order pressed; the newest wins
let firing = false;
let sentDir = -2;
let sentFire = null;
function pushInput() {
  const dir = menuOpen ? -1 : (held.length ? held[held.length - 1] : -1);
  const fire = !menuOpen && firing;
  if (dir === sentDir && fire === sentFire) return;
  sentDir = dir;
  sentFire = fire;
  sendInput({ dir, fire });
}
// Re-send now and then, in case a message was lost.
setInterval(() => { if (started) { sentDir = -2; pushInput(); } }, 500);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { toggleMenu(); e.preventDefault(); return; }
  if (!started || menuOpen) return;
  startEngine();
  if (DIR_KEYS[e.code] !== undefined) {
    const d = DIR_KEYS[e.code];
    const i = held.indexOf(d);
    if (i >= 0) held.splice(i, 1);
    held.push(d);
    e.preventDefault();
  } else if (FIRE_KEYS.includes(e.code)) { firing = true; e.preventDefault(); } else if (BUILD_KEYS.includes(e.code) && !e.repeat) { sendInput({ build: true }); e.preventDefault(); }
  pushInput();
});
document.addEventListener('keyup', (e) => {
  if (DIR_KEYS[e.code] !== undefined) {
    const d = DIR_KEYS[e.code];
    // Both keys for a direction (W and ↑) may be held; drop it only when neither is.
    const other = Object.entries(DIR_KEYS).some(([code, v]) => v === d && code !== e.code && down.has(code));
    if (!other) { const i = held.indexOf(d); if (i >= 0) held.splice(i, 1); }
  } else if (FIRE_KEYS.includes(e.code)) {
    firing = FIRE_KEYS.some((c) => c !== e.code && down.has(c));
  }
  pushInput();
});
const down = new Set();
document.addEventListener('keydown', (e) => down.add(e.code), true);
document.addEventListener('keyup', (e) => down.delete(e.code), true);
window.addEventListener('blur', () => { held.length = 0; firing = false; down.clear(); pushInput(); });
document.addEventListener('mousedown', () => startEngine());

// ------------------------------------------------------------------ menu
function toggleMenu(open) {
  if (!started) return;
  menuOpen = open === undefined ? !menuOpen : open;
  $('menu').classList.toggle('hidden', !menuOpen);
  $('menuConfirm').classList.add('hidden');
  $('menuHelp').innerHTML = helpHtml();
  pushInput();
}
$('btnResume').addEventListener('click', () => toggleMenu(false));
$('btnLeave').addEventListener('click', () => $('menuConfirm').classList.remove('hidden'));
$('btnLeaveNo').addEventListener('click', () => $('menuConfirm').classList.add('hidden'));
$('btnLeaveYes').addEventListener('click', () => window.close());

// ------------------------------------------------------------------ start
async function init() {
  info = await api.warlockInfo(conv, gameId);
  if (!info) return window.close();
  t = (k, v) => I18N.translate(info.language, k, v);
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t(e.dataset.t);
  document.title = t('Tank');
  me = info.me;
  isHost = info.host === me;
  names[me] = info.myName;
  names[info.host] = info.hostName;
  if (isHost) {
    players = [{ id: me, name: info.myName, best: prefs.best || 1 }];
  } else {
    players = [];
    const join = () => { if (!started) toHost({ kind: 'tk-join', name: info.myName, best: prefs.best || 1 }); };
    join();
    const timer = setInterval(() => (started ? clearInterval(timer) : join()), 1500);
  }
  renderLobby();
  if (!view) $('lobbySub').textContent = t('3D graphics are not available on this PC.');
  window.addEventListener('beforeunload', () => {
    if (isHost) toOther({ kind: 'tk-closed' });
    else toHost({ kind: 'tk-leave' });
    if (game && !game.over) game.leave(me);
  });
  requestAnimationFrame(frame);
}

// A small read-only handle for automated tests.
window.TKW = {
  get players() { return players; },
  get snap() { return cur; },
  get game() { return game; },
  get me() { return me; },
  get view() { return view; },
  get opts() { return opts; },
};

init();
