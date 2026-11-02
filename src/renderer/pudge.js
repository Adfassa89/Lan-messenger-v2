/* global api, I18N, PudgeWars, Sfx, EndFx */
import { View, TEAM_COL } from './pudge3d.js';
import { iconURL } from './warlock-icons.js';
// Pudge Wars window: lobby, the live match, the shop. Same network design as
// Warlock: the PC that opened the game (the host) runs PudgeWars.Sim and sends
// a snapshot every tick; everyone draws the snapshots and sends their input.

const params = new URLSearchParams(location.search);
const conv = params.get('conv');
const gameId = params.get('id');
let t = (k, v) => I18N.translate(params.get('lang') || 'en', k, v);
const $ = (id) => document.getElementById(id);
const { ITEMS, HOOK, CLEAVER, UPGRADES, UPGRADE_MAX, TICK, lv } = PudgeWars;
// Dota keys: Q Meat Hook, W Cleaver; E R D F learn the hook upgrades
// (damage, range, speed, size); items on T G Space 3 4 5; 1 selects your hero.
const UP_KEYS = ['damage', 'range', 'speed', 'radius'];
const UP_CODES = { KeyE: 'damage', KeyR: 'range', KeyD: 'speed', KeyF: 'radius' };
const ITEM_KEYS = ['T', 'G', 'Spc', '3', '4', '5'];
const ITEM_CODES = { KeyT: 0, KeyG: 1, Space: 2, Digit3: 3, Digit4: 4, Digit5: 5 };
const SHOP_ORDER = ['tiny_arm', 'grapple', 'lycan_paw', 'naix_jaw', 'lantern', 'mine', 'claw', 'turbine', 'totem', 'salve', 'tome_wisdom', 'tome_damage', 'tome_health'];

let info = null;
let isHost = false;
let me = null;
let players = []; // lobby: [{ id, name }]
let teams = {}; // player id -> 0 Radiant / 1 Dire
let target = 50;
let hookSpeed = 800; // host's choice: Original 800, Fast 1200, Dota 1450
let started = false;
let sim = null;
let snaps = [];
let snapAt = 0;
let lastSnap = null;
let posted = false;
const names = {};
const teamName = (i) => (i === 0 ? t('Radiant') : t('Dire'));

function send(peerId, data) { api.rtcSend(peerId, gameId, data); }
function toAll(data) { for (const p of players) if (p.id !== me) send(p.id, data); }
function toHost(data) { send(info.host, data); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ------------------------------------------------------------------ lobby
function balanceTeams() {
  players.forEach((p, i) => {
    if (teams[p.id] === 0 || teams[p.id] === 1) return;
    const n0 = players.filter((q) => teams[q.id] === 0).length;
    const n1 = players.filter((q) => teams[q.id] === 1).length;
    teams[p.id] = n0 <= n1 ? 0 : 1;
    if (i < 0) teams[p.id] = 0;
  });
}

function renderLobby() {
  balanceTeams();
  $('lobbySub').textContent = isHost
    ? t('Players join from the chat. Start when everyone is in.')
    : started ? t('The match has started.') : t('Waiting for {name} to start the match…', { name: info.hostName });
  const chip = (p) => {
    const tm = teams[p.id];
    const style = `style="background:${TEAM_COL[tm]}"`;
    return isHost ? `<button class="team" data-team="${esc(p.id)}" ${style} title="${esc(t('Click to change team'))}">${esc(teamName(tm))}</button>` : `<span class="team" ${style}>${esc(teamName(tm))}</span>`;
  };
  const list = [0, 1].flatMap((tm) => players.filter((p) => teams[p.id] === tm)).map((p) => `<li><i style="color:${TEAM_COL[teams[p.id]]};background:${TEAM_COL[teams[p.id]]}"></i>${esc(p.name)}${chip(p)}${p.id === info.host ? `<small>${esc(t('Host'))}</small>` : ''}</li>`).join('');
  if ($('lobbyList').dataset.html !== list) { $('lobbyList').innerHTML = list; $('lobbyList').dataset.html = list; }
  $('lobbyOpts').classList.toggle('hidden', !isHost);
  const seg = [10, 25, 50, 75, 100].map((n) => `<button data-n="${n}" class="${n === target ? 'on' : ''}">${n}</button>`).join('');
  if ($('targetSeg').dataset.html !== seg) { $('targetSeg').innerHTML = seg; $('targetSeg').dataset.html = seg; }
  const hs = [[800, t('Original')], [1200, t('Fast')], [1450, t('Dota')]].map(([v, l]) => `<button data-hs="${v}" class="wide${v === hookSpeed ? ' on' : ''}" title="${v}">${esc(l)} · ${v}</button>`).join('');
  if ($('hookSeg').dataset.html !== hs) { $('hookSeg').innerHTML = hs; $('hookSeg').dataset.html = hs; }
  $('lobbyRules').textContent = `${t('Radiant against Dire. A kill is 1 point, a headshot 2, first blood +4. First team to {n} wins.', { n: target })} ${t('Hook speed at the start: {n} (each speed upgrade +70).', { n: hookSpeed })}`;
  const both = players.length >= 2 && [0, 1].every((tm) => players.some((p) => teams[p.id] === tm));
  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnStart').disabled = !both;
  $('btnStart').textContent = players.length < 2 ? t('Waiting for players…') : !both ? t('Both teams need a player') : t('Start the match ({n} players)', { n: players.length });
  $('lobbyHelp').innerHTML = `${t('Right-click to move, right-click an enemy to attack.')} ${t('Mouse wheel zooms.')}<br>
    <kbd>Q</kbd> ${t('Meat Hook')} · <kbd>W</kbd> ${t('Cleaver')} · <kbd>E</kbd><kbd>R</kbd><kbd>D</kbd><kbd>F</kbd> ${t('upgrade the hook')}<br>
    <kbd>T</kbd><kbd>G</kbd><kbd>Space</kbd><kbd>3</kbd><kbd>4</kbd><kbd>5</kbd> ${t('items')} · <kbd>B</kbd> ${t('Shop')} · <kbd>S</kbd> ${t('stop')} · <kbd>1</kbd> ${t('select your hero')} · <kbd>Esc</kbd> ${t('Menu')}<br>
    ${t('Hook enemies across the river and finish them off. Hook runes in the river for power-ups.')}<br>
    ${t('Watch out for the trap plates: spikes, fire, venom and the pendulums over the river hurt everyone.')}`;
}

const lobbyMsg = () => ({ kind: 'pw-lobby', players, teams, target, hookSpeed });
$('hookSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hs]');
  if (!b || !isHost) return;
  hookSpeed = Number(b.dataset.hs);
  renderLobby();
  toAll(lobbyMsg());
});
$('targetSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-n]');
  if (!b || !isHost) return;
  target = Number(b.dataset.n);
  renderLobby();
  toAll(lobbyMsg());
});
$('lobbyList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-team]');
  if (!b || !isHost) return;
  teams[b.dataset.team] = teams[b.dataset.team] === 0 ? 1 : 0;
  renderLobby();
  toAll(lobbyMsg());
});

$('btnStart').addEventListener('click', () => {
  if (!isHost || started || $('btnStart').disabled) return;
  started = true;
  sim = new PudgeWars.Sim(players.map((p) => ({ ...p, team: teams[p.id] })), { target, hookSpeed, seed: Math.floor(Math.random() * 2 ** 31) });
  toAll({ kind: 'pw-start' });
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
    toAll({ kind: 'pw-snap', s: snap });
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
  const win = snap.score[0] >= snap.target ? 0 : 1;
  const order = snap.p.slice().sort((a, b) => b.k - a.k);
  const lines = order.map((p) => `${p.tm === 0 ? '🟢' : '🔴'} ${names[p.id] || '?'} – ${t(p.k === 1 ? '{n} kill' : '{n} kills', { n: p.k })}, ${t(p.dd === 1 ? '{n} death' : '{n} deaths', { n: p.dd })}`);
  api.warlockResult(conv, gameId, `🪝 Pudge Wars – ${t('{team} wins {a} : {b}', { team: teamName(win), a: snap.score[win], b: snap.score[1 - win] })}\n${lines.join('\n')}`).catch(() => {});
}

// ------------------------------------------------------------------ network
api.on(({ type, payload }) => {
  if (type !== 'rtc' || payload.sid !== gameId) return;
  const from = payload.peerId;
  const d = payload.data || {};
  if (isHost) {
    switch (d.kind) {
      case 'pw-join':
        if (!players.some((p) => p.id === from)) {
          if (started) return send(from, { kind: 'pw-full' });
          players.push({ id: from, name: String(d.name || '?').slice(0, 40) });
          names[from] = players[players.length - 1].name;
          Sfx.play('notify');
        }
        renderLobby();
        toAll(lobbyMsg());
        break;
      case 'pw-leave':
        if (!started) {
          players = players.filter((p) => p.id !== from);
          delete teams[from];
          renderLobby();
          toAll(lobbyMsg());
        } else if (sim) sim.leave(from);
        break;
      case 'pw-in':
        if (sim) sim.input(from, d.i || {});
        break;
      default:
        break;
    }
    return;
  }
  if (from !== info.host) return;
  switch (d.kind) {
    case 'pw-lobby':
      players = Array.isArray(d.players) ? d.players : [];
      for (const p of players) names[p.id] = p.name;
      teams = d.teams || {};
      target = d.target || target;
      hookSpeed = d.hookSpeed || hookSpeed;
      renderLobby();
      break;
    case 'pw-start':
      if (!started) enterGame();
      break;
    case 'pw-snap':
      if (!started) enterGame();
      onSnap(d.s);
      break;
    case 'pw-full':
      $('lobbySub').textContent = t('This match has already started.');
      break;
    case 'pw-closed':
      $('lobbySub').textContent = t('{name} closed the arena.', { name: info.hostName });
      $('lobby').classList.remove('hidden');
      break;
    default:
      break;
  }
});

function sendInput(i) {
  if (isHost) { if (sim) sim.input(me, i); } else toHost({ kind: 'pw-in', i });
}

function onSnap(s) {
  snaps.push(s);
  if (snaps.length > 2) snaps.shift();
  snapAt = performance.now();
  for (const e of s.fx || []) effect(e, s);
  lastSnap = s;
  renderHud(s);
}

// ------------------------------------------------------------------ 3D view
const canvas = $('view');
let view = null;
try {
  view = new View(canvas, $('labels'));
} catch (err) {
  console.error(err);
}
window.addEventListener('resize', () => view && view.resize());

// ------------------------------------------------------------------ controls
const PREFS_KEY = 'lanmsg.pudgewars.v1';
const prefs = { quickCast: false, repeatMove: true, lockCursor: true, camSpeed: 1 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* defaults */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

const mouse = { x: innerWidth / 2, y: innerHeight / 2, inside: true, right: false };
const cursorEl = $('cursor');
const locked = () => document.pointerLockElement === canvas;
const pick = (cx, cy) => (view ? view.pick(cx, cy) : { x: 0, y: 0 });
function placeCursor() {
  cursorEl.style.transform = `translate(${mouse.x}px, ${mouse.y}px)`;
  cursorEl.classList.toggle('hidden', !locked());
  cursorEl.classList.toggle('aim', !!aiming);
  document.body.classList.toggle('aiming', !!aiming);
}
document.addEventListener('mousemove', (e) => {
  if (locked()) {
    mouse.x = Math.max(0, Math.min(innerWidth - 1, mouse.x + e.movementX));
    mouse.y = Math.max(0, Math.min(innerHeight - 1, mouse.y + e.movementY));
  } else {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
  mouse.inside = true;
  placeCursor();
  if (mouse.right && prefs.repeatMove) moveOrder(false);
});
document.addEventListener('mouseleave', () => { mouse.inside = false; });
document.addEventListener('mouseenter', () => { mouse.inside = true; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  if (view) view.zoom = Math.min(1.35, Math.max(0.55, view.zoom * (e.deltaY > 0 ? 1.08 : 1 / 1.08)));
}, { passive: true });

const panelsClosed = () => $('shop').classList.contains('hidden') && $('menu').classList.contains('hidden');
const fighting = () => started && lastSnap && lastSnap.ph === 'fight' && panelsClosed();
function grabCursor() {
  if (!prefs.lockCursor || locked() || !fighting()) return;
  try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch { /* not supported */ }
}
let releasingOnPurpose = false;
document.addEventListener('pointerlockchange', () => {
  placeCursor();
  if (!locked() && started && lastSnap && lastSnap.ph === 'fight' && !releasingOnPurpose) openMenu();
  releasingOnPurpose = false;
});
function releaseQuietly() { if (locked()) { releasingOnPurpose = true; document.exitPointerLock(); } }

// Orders go to the selected unit, as in Dota.
let selected = null;
const selId = () => selected || me;
const commanding = () => selId() === me;
function select(id) {
  selected = id === me ? null : id;
  if (view) view.selected = selId();
  if (lastSnap) renderHud(lastSnap);
}

let lastMoveSent = 0;
function moveOrder(click) {
  if (!commanding() || !started) return;
  const now = performance.now();
  if (!click && now - lastMoveSent < 90) return;
  lastMoveSent = now;
  // Right-clicking an enemy attacks it.
  const under = view && view.pawnAt(mouse.x, mouse.y, me);
  const enemy = under && lastSnap && lastSnap.p.find((q) => q.id === under && q.tm !== (myPawn(lastSnap) || {}).tm);
  if (enemy && click) { sendInput({ attack: enemy.id }); return; }
  const { x, y } = pick(mouse.x, mouse.y);
  sendInput({ move: [Math.round(x), Math.round(y)] });
  if (click && view) view.showMove(x, y);
}
setInterval(() => { if (mouse.right && prefs.repeatMove && started) moveOrder(false); }, 100);

canvas.addEventListener('mousedown', (e) => {
  if (!started) return;
  if (locked()) {
    const el = document.elementFromPoint(mouse.x, mouse.y);
    const btn = el && el !== canvas && el.closest('button, [data-up]');
    if (btn && e.button === 0) { btn.click(); return; }
  } else grabCursor();
  if (e.button === 0) {
    if (aiming) { castAiming(); return; }
    const id = view && view.pawnAt(mouse.x, mouse.y, null);
    if (id) select(id);
  }
  if (e.button === 2) {
    mouse.right = true;
    if (aiming) { aiming = null; placeCursor(); }
    moveOrder(true);
  }
});
document.addEventListener('mouseup', (e) => { if (e.button === 2) mouse.right = false; });
window.addEventListener('blur', () => { mouse.right = false; keys.clear(); });

// Spells and items: quick cast fires at the cursor; otherwise the key shows
// the aim indicator and a left click casts.
let aiming = null; // { what, key }
function castAt(what) {
  const { x, y } = pick(mouse.x, mouse.y);
  sendInput({ cast: what, x: Math.round(x), y: Math.round(y) });
}
function castAiming() {
  if (!aiming) return;
  castAt(aiming.what);
  aiming = null;
  placeCursor();
}
function startCast(what) {
  const p = myPawn(lastSnap);
  if (!p || p.d) return;
  let key = what;
  if (what[0] === 'i') {
    const it = p.it[Number(what.slice(1))];
    if (!it || !ITEMS[it[0]].active) return;
    key = it[0];
  }
  if (prefs.quickCast || key === 'salve') { castAt(what); return; }
  aiming = { what, key };
  placeCursor();
}
function learn(what) {
  sendInput({ upgrade: what });
  Sfx.play('wlBlink');
}

const keys = new Set();
const cam = { x: 0, y: 0, snap: false };
let lastOneTap = 0;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { e.preventDefault(); onEscape(); return; }
  if (!started) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) { e.preventDefault(); keys.add(e.code); return; }
  if (e.repeat) return;
  if (e.code === 'Space' || e.code.startsWith('Digit') || e.code === 'F1' || e.code === 'F4') e.preventDefault();
  if (e.code === 'KeyB' || e.code === 'F4') { toggleShop(); return; }
  if (e.code === 'Digit1' || e.code === 'F1') {
    select(me);
    const now = performance.now();
    if (now - lastOneTap < 450) cam.snap = true;
    lastOneTap = now;
    return;
  }
  if (!$('menu').classList.contains('hidden') || !commanding()) return;
  if (e.code === 'KeyS') { aiming = null; placeCursor(); sendInput({ stop: true }); return; }
  if (e.code === 'KeyQ') { startCast('hook'); return; }
  if (e.code === 'KeyW') { startCast('cleaver'); return; }
  if (UP_CODES[e.code]) { learn(UP_CODES[e.code]); return; }
  if (ITEM_CODES[e.code] !== undefined) startCast(`i${ITEM_CODES[e.code]}`);
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

function onEscape() {
  if (aiming) { aiming = null; placeCursor(); return; }
  if (!$('shop').classList.contains('hidden')) { toggleShop(false); return; }
  if ($('menu').classList.contains('hidden')) openMenu(); else closeMenu();
}
function openMenu() {
  aiming = null;
  mouse.right = false;
  releaseQuietly();
  renderMenu();
  $('menu').classList.remove('hidden');
}
function closeMenu() {
  $('menu').classList.add('hidden');
  $('menuConfirm').classList.add('hidden');
}
function renderMenu() {
  const row = (k, label, hint) => `<label class="menu-opt"><input type="checkbox" data-pref="${k}" ${prefs[k] ? 'checked' : ''}><span><b>${esc(label)}</b><small>${esc(hint)}</small></span></label>`;
  $('menuOpts').innerHTML = [
    row('quickCast', t('Quick cast'), t('Spells go off at the cursor as soon as you press the key. Off: the key shows an aim arrow and a left click casts.')),
    row('repeatMove', t('Repeat move command'), t('Holding the right mouse button keeps sending move orders.')),
    row('lockCursor', t('Keep the cursor in the window'), t('The mouse cannot leave the game window while you fight.')),
  ].join('') + `<div class="menu-opt"><span><b>${esc(t('Camera speed'))}</b></span><div class="seg" id="camSpeedSeg">${[[0.6, t('Slow')], [1, t('Normal')], [1.6, t('Fast')]].map(([v, l]) => `<button data-cam="${v}" class="${prefs.camSpeed === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>`;
}
$('menuOpts').addEventListener('change', (e) => {
  const k = e.target.dataset.pref;
  if (!k) return;
  prefs[k] = e.target.checked;
  savePrefs();
});
$('menuOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cam]');
  if (!b) return;
  prefs.camSpeed = Number(b.dataset.cam);
  savePrefs();
  renderMenu();
});
$('btnResume').addEventListener('click', () => { closeMenu(); grabCursor(); });
$('btnLeave').addEventListener('click', () => $('menuConfirm').classList.remove('hidden'));
$('btnLeaveNo').addEventListener('click', () => $('menuConfirm').classList.add('hidden'));
$('btnLeaveYes').addEventListener('click', () => window.close());

// Camera: always on your Pudge; while you are dead you can look around.
function updateCamera(s, dt) {
  const mine = myPawn(s);
  if (s.ph === 'over' || !mine) return { mode: 'overview' };
  if (!mine.d) {
    cam.x = mine.x;
    cam.y = mine.y;
    const snap = cam.snap || !cam.started;
    cam.started = true;
    cam.snap = false;
    return { mode: 'follow', x: cam.x, y: cam.y, snap };
  }
  cam.snap = false;
  const sp = 2200 * prefs.camSpeed * (view ? view.zoom : 1) * dt;
  const edge = 14;
  const canEdge = mouse.inside && panelsClosed();
  if (keys.has('ArrowLeft') || (canEdge && mouse.x <= edge)) cam.x -= sp;
  if (keys.has('ArrowRight') || (canEdge && mouse.x >= innerWidth - 1 - edge)) cam.x += sp;
  if (keys.has('ArrowUp') || (canEdge && mouse.y <= edge)) cam.y += sp;
  if (keys.has('ArrowDown') || (canEdge && mouse.y >= innerHeight - 1 - edge)) cam.y -= sp;
  cam.x = Math.max(-2000, Math.min(2000, cam.x));
  cam.y = Math.max(-1900, Math.min(1900, cam.y));
  return { mode: 'free', x: cam.x, y: cam.y };
}

// The aim indicator: the hook's corridor (its size and range), the cleaver's line,
// or a target circle for the items.
function aimShape(key, p) {
  if (key === 'hook') {
    const up = p.up || [0, 0, 0, 0];
    return { kind: 'line', width: (HOOK.radius + UPGRADES.radius * up[3]) / 2, range: HOOK.range + UPGRADES.range * up[1] };
  }
  if (key === 'cleaver') return { kind: 'line', width: CLEAVER.radius / 2, range: CLEAVER.range };
  const it = p.it.find((i) => i[0] === key);
  const level = it ? it[1] : 1;
  if (key === 'grapple') return { kind: 'line', width: ITEMS.grapple.radius, range: ITEMS.grapple.range };
  if (key === 'tiny_arm') return { kind: 'area', radius: level >= 5 ? 200 : 80, range: lv(ITEMS.tiny_arm.range, level) };
  if (key === 'totem') return { kind: 'area', radius: ITEMS.totem.radius, range: ITEMS.totem.range };
  if (key === 'mine') return { kind: 'area', radius: ITEMS.mine.radius, range: ITEMS.mine.range };
  return null;
}

// ------------------------------------------------------------------ effects
function feed(text) {
  const el = document.createElement('div');
  el.textContent = text;
  $('feed').append(el);
  setTimeout(() => el.remove(), 5000);
  while ($('feed').children.length > 6) $('feed').firstChild.remove();
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
const RUNE_NAMES = { haste: 'Haste', gold: 'Gold', shield: 'Shield', fire: 'Fire', dynamite: 'Dynamite', lightning: 'Lightning' };

function effect(e, s) {
  if (view) view.fx(e, s);
  switch (e.e) {
    case 'start':
      banner(t('FIGHT!'), t('First team to {n} wins', { n: s.target }));
      Sfx.play('wlHorn');
      break;
    case 'cast':
      Sfx.play({ hook: 'wlChain', cleaver: 'wlWhoosh', grapple: 'wlChain', tiny_arm: 'wlWhoosh', totem: 'wlShrink', mine: 'wlCoin', salve: 'wlShield' }[e.k] || 'wlWhoosh');
      break;
    case 'hooked':
      Sfx.play(e.ally ? 'wlChain' : 'wlHurt');
      if (e.by === me && !e.ally) Sfx.play('wlClash');
      break;
    case 'headshot':
      Sfx.play('wlBoom');
      feed(`🎯 ${t('{name} HEADSHOT!', { name: names[e.by] || '?' })}`);
      break;
    case 'deny':
      feed(`🚫 ${t('{name} denied {victim}', { name: names[e.by] || '?', victim: names[e.id] || '?' })}`);
      break;
    case 'firstBlood':
      banner(t('FIRST BLOOD!'), names[e.id] || '', 2000);
      Sfx.play('wlScourge');
      break;
    case 'bounce':
      Sfx.play('wlClash');
      break;
    case 'hit':
      if (e.id === me && e.n >= 50) { if (view) view.shake(8, 0.15); }
      break;
    case 'death':
      Sfx.play('wlDeath');
      feed(e.by ? `💀 ${names[e.by] || '?'} ➜ ${names[e.id] || '?'}${e.headshot ? ' 🎯' : ''}` : `💀 ${t('{name} died', { name: names[e.id] || '?' })}`);
      break;
    case 'mineBoom':
    case 'dynamite':
      Sfx.play('wlBoom');
      break;
    case 'lightning':
      Sfx.play('wlBolt');
      break;
    case 'rune':
      Sfx.play('wlShield');
      feed(`✨ ${t('{name} took the {rune} rune', { name: names[e.id] || '?', rune: t(RUNE_NAMES[e.type] || e.type) })}`);
      break;
    case 'trap':
      Sfx.play(e.k === 'fire' ? 'wlFire' : e.k === 'venom' ? 'wlWind' : e.k === 'pendulum' ? 'wlChain' : 'wlClash');
      break;
    case 'trapSpike':
      Sfx.play('wlShrink');
      break;
    case 'trapSlice':
      Sfx.play('wlBoom');
      break;
    case 'runeSpawn':
      Sfx.play('wlBlink');
      break;
    case 'level':
      if (e.id === me) Sfx.play('roundWin');
      break;
    case 'buy':
      if (e.id === me) Sfx.play('wlCoin');
      break;
    case 'land':
    case 'toss':
      Sfx.play('wlRush');
      break;
    case 'over': {
      const won = (myPawn(s) || {}).tm === e.team;
      EndFx.show({
        outcome: won ? 'win' : 'lose',
        title: won ? t('You won!') : t('{team} wins!', { team: teamName(e.team) }),
        detail: `${t('Radiant')} ${s.score[0]} : ${s.score[1]} ${t('Dire')}`,
        buttons: [{ label: t('Close'), primary: true, action: () => window.close() }],
      });
      break;
    }
    default:
      break;
  }
}

// ------------------------------------------------------------------ frame
let lastFrame = performance.now();
const idle = { ph: 'lobby', p: [], h: [], c: [], g: [], mi: [], b: [], r: [] };
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!view) return;
  if (!started || !snaps.length) {
    view.frame({ s: idle, prev: idle, k: 1, dt, me, names, cam: { mode: 'overview' } });
    return;
  }
  const s = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[0] : s;
  const k = Math.min(1, (now - snapAt) / (TICK * 1000));
  const mine = myPawn(s);
  if (aiming && (!mine || mine.d || s.ph !== 'fight')) { aiming = null; placeCursor(); }
  const shape = aiming && mine ? aimShape(aiming.key, mine) : null;
  const aim = shape ? { ...shape, at: pick(mouse.x, mouse.y) } : null;
  view.frame({ s, prev, k, dt, me, names, cam: updateCamera(s, dt), aim });
  if (s.ph !== 'fight' || !panelsClosed()) releaseQuietly();
  updateCooldowns(s, now);
}

// ------------------------------------------------------------------ HUD
function myPawn(s) { return s && s.p.find((p) => p.id === me); }

function renderHud(s) {
  const p = myPawn(s);
  $('scoreRad').textContent = s.score[0];
  $('scoreDire').textContent = s.score[1];
  $('phaseInfo').textContent = s.ph === 'pre' ? t('Get ready… {n}', { n: Math.ceil(s.left) })
    : s.ph === 'over' ? t('Match over') : `${t('First to {n}', { n: s.target })} · ${t('Rune in {n} s', { n: Math.max(0, Math.ceil(s.rune)) })}`;
  $('btnShop').textContent = `🛒 ${t('Shop')} (B)`;
  // Scoreboard: Radiant, then Dire.
  const row = (q) => `<div class="row${q.d ? ' dead' : ''}" style="border-left-color:${TEAM_COL[q.tm]}"><i style="background:${TEAM_COL[q.tm]}"></i>${esc(names[q.id] || '?')}${q.id === me ? ' ★' : ''}<small>${q.d && q.rs ? `⟳${q.rs}` : `${q.lv}`}</small><b>${q.k}/${q.dd}</b></div>`;
  $('scores').innerHTML = [0, 1].map((tm) => `<div class="team-head" style="background:${TEAM_COL[tm]}33;color:${TEAM_COL[tm]}">${esc(teamName(tm))} · ${s.score[tm]}</div>${s.p.filter((q) => q.tm === tm && !q.l).map(row).join('')}`).join('');
  let u = s.p.find((q) => q.id === selId());
  if (!u || u.l || (u.id !== me && u.d)) { selected = null; if (view) view.selected = me; u = p; }
  renderCard(s, u);
  if (!$('shop').classList.contains('hidden')) renderShop(p);
}

let cardKey = '';
function renderCard(s, u) {
  if (!u) return;
  const mine = u.id === me;
  $('card').classList.toggle('enemy', u.tm !== (myPawn(s) || {}).tm);
  $('hpFill').style.width = `${Math.max(0, (u.hp / u.mx) * 100)}%`;
  $('hpText').textContent = u.d ? t('Respawn in {n} s', { n: u.rs }) : `${u.hp} / ${u.mx}`;
  const xpK = u.nx ? (u.xp - u.px) / (u.nx - u.px) : 1;
  $('xpFill').style.width = `${Math.max(0, Math.min(1, xpK)) * 100}%`;
  $('xpText').textContent = `${t('Level {n}', { n: u.lv })}${u.nx ? ` · ${u.xp - u.px} / ${u.nx - u.px}` : ''}`;
  const buffs = (u.m || []).filter((m) => ['haste', 'shield', 'fire', 'dynamite', 'lightning'].includes(m));
  $('uStats').innerHTML = `${mine ? `<span>💰 <b>${u.g}</b></span>` : ''}<span>💀 ${u.k}/${u.dd}</span><span>⚔ ${70 + 25 * u.dt}</span>${buffs.length ? `<span class="rune-buffs">${buffs.map((b) => `<img src="${iconURL(`r_${b}`, 40)}" title="${esc(t(RUNE_NAMES[b]))}" alt="">`).join('')}</span>` : ''}`;
  const key = JSON.stringify([u.id, u.up, u.pts, u.it.map((i) => [i[0], i[1]]), mine]);
  if (key === cardKey) return;
  cardKey = key;
  $('pImg').src = iconURL('pudge', 168);
  $('portrait').style.borderColor = TEAM_COL[u.tm];
  $('pTag').textContent = mine ? t('YOU') : teamName(u.tm).toUpperCase();
  $('uName').innerHTML = `<i style="background:${TEAM_COL[u.tm]}"></i>${esc(names[u.id] || '?')}`;
  const spell = (k, key, label) => `<div class="spell" data-cast="${k}" title="${esc(label)}"><img src="${iconURL(k)}" alt=""><span class="key">${mine ? key : ''}</span>${mine ? '<div class="cd"></div>' : ''}</div>`;
  const ups = UP_KEYS.map((k, i) => {
    const level = u.up[i];
    const can = mine && u.pts > 0 && level < UPGRADE_MAX;
    return `<div class="spell up${can ? ' learn' : ''}" ${mine ? `data-up="${k}"` : ''} title="${esc(upTip(k))}"><img src="${iconURL(`up_${k}`, 96)}" alt=""><span class="key">${mine ? ['E', 'R', 'D', 'F'][i] : ''}</span>${can ? '<span class="plus">+</span>' : ''}<div class="pips">${Array.from({ length: UPGRADE_MAX }, (_, j) => `<i class="${j < level ? 'on' : ''}"></i>`).join('')}</div></div>`;
  }).join('');
  $('spellBar').innerHTML = spell('hook', 'Q', t('Meat Hook')) + spell('cleaver', 'W', t('Cleaver')) + ups + (mine && u.pts > 0 ? `<span class="points">+${u.pts}</span>` : '');
  $('itemGrid').innerHTML = ITEM_KEYS.map((k, i) => {
    const it = u.it[i];
    if (!it) return `<div class="item empty"><span class="key">${mine ? k : ''}</span></div>`;
    const def = ITEMS[it[0]];
    return `<div class="item${def.active ? '' : ' passive'}" ${def.active ? `data-slot="${i}"` : ''} title="${esc(itemName(it[0]))}"><img src="${iconURL(it[0], 96)}" alt=""><span class="key">${mine ? k : ''}</span><span class="lvl">${it[1]}</span>${mine && def.active ? '<div class="cd"></div>' : ''}</div>`;
  }).join('');
}
$('spellBar').addEventListener('click', (e) => {
  const up = e.target.closest('[data-up]');
  if (up) { learn(up.dataset.up); return; }
  const c = e.target.closest('[data-cast]');
  if (c && commanding()) startCast(c.dataset.cast);
});
$('itemGrid').addEventListener('click', (e) => {
  const c = e.target.closest('[data-slot]');
  if (c && commanding()) startCast(`i${c.dataset.slot}`);
});

// Cooldowns, only for your own hero (as in Dota).
function updateCooldowns(s, now) {
  const p = myPawn(s);
  if (!p || selId() !== me) return;
  const since = (now - snapAt) / 1000;
  const set = (el, left, total) => {
    const cdEl = el.querySelector('.cd');
    if (!cdEl) return;
    left = Math.max(0, left - since);
    cdEl.style.setProperty('--cd', `${(left / total) * 100}%`);
    cdEl.textContent = left > 0.05 ? (left < 1 ? left.toFixed(1) : Math.ceil(left)) : '';
    el.classList.toggle('ready', left <= 0.05);
  };
  for (const el of document.querySelectorAll('#spellBar [data-cast]')) {
    const k = el.dataset.cast;
    set(el, p.cd[k] || 0, k === 'hook' ? HOOK.cd : CLEAVER.cd);
  }
  for (const el of document.querySelectorAll('#itemGrid [data-slot]')) {
    const it = p.it[Number(el.dataset.slot)];
    if (it) set(el, it[2], lv(ITEMS[it[0]].cd, it[1]) || 1);
  }
}

// ------------------------------------------------------------------ shop
function toggleShop(open) {
  const show = open === undefined ? $('shop').classList.contains('hidden') : open;
  $('shop').classList.toggle('hidden', !show);
  if (show) { releaseQuietly(); renderShop(myPawn(lastSnap)); } else grabCursor();
}
$('btnShop').addEventListener('click', () => toggleShop());
$('btnCloseShop').addEventListener('click', () => toggleShop(false));

function itemName(k) {
  return t(ITEMS[k].name);
}
function renderShop(p) {
  if (!p) return;
  $('gold').textContent = `💰 ${p.g}`;
  $('shopTime').textContent = t('Buying an item again upgrades it (up to level 5).');
  const html = SHOP_ORDER.map((k) => {
    const def = ITEMS[k];
    const have = p.it.find((i) => i[0] === k);
    const level = have ? have[1] : 0;
    const full = !have && !def.consumable && p.it.length >= 6;
    const max = def.consumable ? (k === 'tome_damage' && p.dt >= def.max) : level >= (def.max || 1);
    const pips = !def.consumable && def.max > 1 ? `<span class="lv">${'●'.repeat(level)}${'○'.repeat(def.max - level)}</span>` : k === 'tome_damage' ? `<span class="lv">${p.dt}/${def.max}</span>` : k === 'tome_health' ? `<span class="lv">×${p.ht}</span>` : '';
    return `<button class="buy${level ? ' owned' : ''}${max || full || p.g < def.cost ? ' poor' : ''}" data-buy="${k}" data-tip="${esc(itemTip(k))}"><img class="ic" src="${iconURL(k, 96)}" alt=""><span class="nm">${esc(itemName(k))}</span><span class="pr">${max ? t('Max') : `💰 ${def.cost}`}</span>${pips}</button>`;
  }).join('');
  if ($('shopItems').dataset.html !== html) { $('shopItems').innerHTML = html; $('shopItems').dataset.html = html; }
}
$('shop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-buy]');
  if (b) sendInput({ buy: b.dataset.buy });
});
$('shop').addEventListener('mouseover', (e) => {
  const b = e.target.closest('[data-tip]');
  $('shopTip').textContent = b ? b.dataset.tip : '';
});

function upTip(k) {
  return {
    damage: t('Hook damage: +{n} per level.', { n: UPGRADES.damage }),
    range: t('Hook range: +{n} per level.', { n: UPGRADES.range }),
    speed: t('Hook speed: +{n} per level.', { n: UPGRADES.speed }),
    radius: t('Hook size: +{n} per level; a bigger hook hits more easily.', { n: UPGRADES.radius }),
  }[k];
}

function itemTip(k) {
  return {
    tiny_arm: t("Tiny's Arm (usable): throw a Pudge or barrel standing next to you far away (1000 – 3000). Level 5: it stuns and hurts where it lands."),
    grapple: t('Grappling Hook (usable): latch onto a unit, totem, the rock or a wall and pull yourself there – even across the river.'),
    lycan_paw: t("Lycan's Paw: +50 to +150 movement speed."),
    naix_jaw: t("Naix's Jaw: heal 20 – 40 % of your hook damage."),
    lantern: t("Barathrum's Lantern: the faster your hook, the more it hurts (25 – 45 % of its speed)."),
    mine: t('Techies Explosive Barrel (usable): plant a barrel that blows up enemies who come near (500 – 800 damage). Barrels can be hooked.'),
    claw: t("Strygwyr's Claw: an enemy you drag bleeds for the distance pulled."),
    turbine: t('Ricochet Turbine: every bounce makes your hook hit harder (+10 – 50 %).'),
    totem: t('Earthshaker Totem (usable): raise a wooden totem that hooks bounce off. Enemy hooks break it.'),
    salve: t('Instant Greater Salve (usable): heal 400 at once.'),
    tome_wisdom: t('Tome of Wisdom: gain a level.'),
    tome_damage: t('Tome of Damage: +25 attack damage (up to 10).'),
    tome_health: t('Tome of Health: +100 maximum health.'),
  }[k] || '';
}

// ------------------------------------------------------------------ start
async function init() {
  info = await api.warlockInfo(conv, gameId);
  if (!info) return window.close();
  t = (k, v) => I18N.translate(info.language, k, v);
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t(e.dataset.t);
  me = info.me;
  isHost = info.host === me;
  names[me] = info.myName;
  if (view) view.selected = me;
  names[info.host] = info.hostName;
  if (isHost) {
    players = [{ id: me, name: info.myName }];
  } else {
    players = [];
    const join = () => { if (!started) toHost({ kind: 'pw-join', name: info.myName }); };
    join();
    const timer = setInterval(() => (started ? clearInterval(timer) : join()), 1500);
  }
  renderLobby();
  if (!view) $('lobbySub').textContent = t('3D graphics are not available on this PC.');
  window.addEventListener('beforeunload', () => {
    if (isHost) toAll({ kind: 'pw-closed' });
    else toHost({ kind: 'pw-leave' });
  });
  requestAnimationFrame(frame);
}

// A small read-only handle for automated tests.
window.PWW = {
  get players() { return players; },
  get lastSnap() { return lastSnap; },
  get sim() { return sim; },
  get me() { return me; },
  get view() { return view; },
  myPawn,
  toScreen: (x, y) => (view ? view.toScreen(x, y) : [0, 0]),
  prefs,
  get aiming() { return aiming; },
  get mouse() { return mouse; },
};

init();
