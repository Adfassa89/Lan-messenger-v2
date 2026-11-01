/* global api, I18N, Warlock, Sfx, EndFx */
import { View } from './warlock3d.js';
import { iconURL } from './warlock-icons.js';
// Warlock window: lobby, the live arena, the shop between rounds.
// The PC that opened the arena (the host) runs Warlock.Sim and sends a
// snapshot every tick; everyone (the host too) draws those snapshots and
// sends their mouse and key input to the host.

const params = new URLSearchParams(location.search);
const conv = params.get('conv');
const gameId = params.get('id');
let t = (k, v) => I18N.translate(params.get('lang') || 'en', k, v);
const $ = (id) => document.getElementById(id);
const { SPELLS, ITEMS, COLUMN_SPELLS, TICK } = Warlock;
// Dota 2 default keys: spells on Q W E R D F, items on T G Space 3 4 5
// (Fireball and Scourge are items, like in Warlock Brawl); 1 selects your hero.
const SPELL_KEYS = ['Q', 'W', 'E', 'R', 'D', 'F']; // spell columns 1 – 6
const SPELL_CODES = { KeyQ: 1, KeyW: 2, KeyE: 3, KeyR: 4, KeyD: 5, KeyF: 6 };
const ITEM_KEYS = ['T', 'G', 'Spc', '3', '4', '5'];
const ITEM_CODES = { KeyT: 0, KeyG: 1, Space: 2, Digit3: 3, Digit4: 4, Digit5: 5 };
const ITEM_ORDER = ['ring', 'cursed', 'cape', 'armor', 'boots', 'watch', 'redirector', 'pact'];
const ITEM_SLOT = { redirector: 8, pact: 9 }; // usable items cast from these slots

let info = null;
let isHost = false;
let me = null;
let players = []; // lobby: [{ id, name }]
let rounds = 5; // the number of rounds, or the score to reach
// Host's game settings, as in Warlock Brawl's lobby.
let settings = { mode: 'rounds', teams: 'shuffle', win: 'rounds' };
let lobbyTeams = {}; // 'Teams' mode: player id -> team index
const TEAM_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];
const teamName = (i) => t(TEAM_NAMES[i] || 'Team {n}', { n: i + 1 });
const teamColor = (i) => Warlock.TEAM_COLORS[i % 10];
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
  const picking = settings.teams === 'lobby';
  players.forEach((p, i) => { if (!Number.isInteger(lobbyTeams[p.id])) lobbyTeams[p.id] = i % 2; });
  const chip = (p) => {
    const tm = lobbyTeams[p.id];
    const style = `style="background:${teamColor(tm)}"`;
    return isHost ? `<button class="team" data-team="${esc(p.id)}" ${style} title="${esc(t('Click to change team'))}">${esc(teamName(tm))}</button>` : `<span class="team" ${style}>${esc(teamName(tm))}</span>`;
  };
  const list = players.map((p, i) => `<li><i style="color:${Warlock.COLORS[i % 10]};background:${Warlock.COLORS[i % 10]}"></i>${esc(p.name)}${picking ? chip(p) : ''}${p.id === info.host ? `<small>${esc(t('Host'))}</small>` : ''}</li>`).join('');
  if ($('lobbyList').dataset.html !== list) { $('lobbyList').innerHTML = list; $('lobbyList').dataset.html = list; }
  $('lobbyOpts').classList.toggle('hidden', !isHost);
  const seg = [3, 5, 7, 11].map((n) => `<button data-r="${n}" class="${n === rounds ? 'on' : ''}">${n}</button>`).join('');
  if ($('roundsSeg').dataset.html !== seg) { $('roundsSeg').innerHTML = seg; $('roundsSeg').dataset.html = seg; }
  const opts = (id, key, list) => {
    const html = list.map(([v, label]) => `<button class="wide${settings[key] === v ? ' on' : ''}" data-set="${key}" data-v="${v}">${esc(label)}</button>`).join('');
    if ($(id).dataset.html !== html) { $(id).innerHTML = html; $(id).dataset.html = html; }
  };
  opts('modeSeg', 'mode', [['rounds', t('Rounds')], ['dm', t('Deathmatch')]]);
  opts('teamSeg', 'teams', [['shuffle', t('Shuffle')], ['ffa', t('Free for all')], ['lobby', t('Pick teams')]]);
  opts('winSeg', 'win', [['rounds', t('Rounds')], ['score', t('Score')]]);
  const rules = [
    settings.mode === 'dm' ? t('Deathmatch: 60 s rounds, respawn after 10 s, 1 point per kill, the shop stays open.') : t('Rounds: the last team standing wins the round.'),
    { shuffle: t('Random teams every round.'), ffa: t('Everyone for themselves.'), lobby: t('The host picks the teams.') }[settings.teams],
    settings.win === 'score' ? t('First to {n} points wins.', { n: rounds }) : t('{n} rounds; most points wins.', { n: rounds }),
  ].join(' ');
  $('lobbyRules').textContent = rules;
  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnStart').disabled = players.length < 2;
  $('btnStart').textContent = players.length < 2 ? t('Waiting for players…') : t('Start the match ({n} players)', { n: players.length });
  $('lobbyHelp').innerHTML = `${t('Right-click to move, aim with the mouse.')} ${t('Mouse wheel zooms.')}<br>
    <kbd>Q</kbd><kbd>W</kbd><kbd>E</kbd><kbd>R</kbd><kbd>D</kbd><kbd>F</kbd> ${t('spells')} · <kbd>T</kbd> ${t('Fireball')} · <kbd>G</kbd> ${t('Scourge')} · <kbd>S</kbd> ${t('stop')}<br>
    ${t('spell key, then left-click to cast (quick cast in Esc menu)')}<br>
    <kbd>1</kbd> ${t('select your hero')}<br>
    ${t('Left-click a warlock to see its health, spells and items.')} · <kbd>Esc</kbd> ${t('Menu')}<br>
    ${t('Knock the others into the lava. Last warlock standing wins the round.')}`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const lobbyMsg = () => ({ kind: 'wl-lobby', players, rounds, settings, lobbyTeams });
$('roundsSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-r]');
  if (!b) return;
  rounds = Number(b.dataset.r);
  renderLobby();
  toAll(lobbyMsg());
});
$('lobbyOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-set]');
  if (!b || !isHost) return;
  settings[b.dataset.set] = b.dataset.v;
  renderLobby();
  toAll(lobbyMsg());
});
$('lobbyList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-team]');
  if (!b || !isHost) return;
  lobbyTeams[b.dataset.team] = ((lobbyTeams[b.dataset.team] || 0) + 1) % TEAM_NAMES.length;
  renderLobby();
  toAll(lobbyMsg());
});

$('btnStart').addEventListener('click', () => {
  if (!isHost || players.length < 2 || started) return;
  started = true;
  sim = new Warlock.Sim(players, { ...settings, target: rounds, lobbyTeams, seed: Math.floor(Math.random() * 2 ** 31) });
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
  const lines = order.map((p, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${names[p.id] || '?'} – ${t('{n} points', { n: p.sc })}, ${t('{n} kills', { n: p.k })}`);
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
        toAll(lobbyMsg());
        break;
      case 'wl-leave':
        if (!started) {
          players = players.filter((p) => p.id !== from);
          renderLobby();
          toAll(lobbyMsg());
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
      if (d.settings) settings = d.settings;
      if (d.lobbyTeams) lobbyTeams = d.lobbyTeams;
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
// Player settings (Esc menu), kept on this PC.
const PREFS_KEY = 'lanmsg.warlock.v1';
const prefs = { quickCast: false, repeatMove: true, lockCursor: true, camSpeed: 1 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* defaults */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };

// The mouse: the real cursor, or a drawn one while it is locked inside the window.
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

// Keep the cursor inside the game window while fighting (Pointer Lock with a
// drawn cursor); losing the lock (Esc, Alt+Tab) opens the menu.
const fighting = () => started && lastSnap && lastSnap.ph === 'fight' && $('shop').classList.contains('hidden') && $('menu').classList.contains('hidden');
function grabCursor() {
  if (!prefs.lockCursor || locked() || !fighting()) return;
  try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch { /* not supported */ }
}
function releaseCursor() { if (locked()) document.exitPointerLock(); }
document.addEventListener('pointerlockchange', () => {
  placeCursor();
  if (!locked() && started && lastSnap && lastSnap.ph === 'fight' && !releasingOnPurpose) openMenu();
  releasingOnPurpose = false;
});
let releasingOnPurpose = false;
function releaseQuietly() { if (locked()) { releasingOnPurpose = true; document.exitPointerLock(); } }

// Like Dota, orders go to the selected unit: with an enemy selected your
// clicks and keys do nothing until you select your own hero again (1).
let selected = null; // null = your own hero
const selId = () => selected || me;
const commanding = () => selId() === me;
function select(id) {
  selected = id === me ? null : id;
  if (view) view.selected = selId();
  if (lastSnap) renderHud(lastSnap);
}

// Move orders. Holding the right button repeats them, so steering is fluid.
let lastMoveSent = 0;
function moveOrder(click) {
  if (!commanding() || !started) return;
  const now = performance.now();
  if (!click && now - lastMoveSent < 90) return;
  lastMoveSent = now;
  const { x, y } = pick(mouse.x, mouse.y);
  sendInput({ move: [Math.round(x), Math.round(y)] });
  if (click && view) view.showMove(x, y);
}
setInterval(() => { if (mouse.right && prefs.repeatMove && started) moveOrder(false); }, 100);

canvas.addEventListener('mousedown', (e) => {
  if (!started) return;
  // With a locked cursor, clicks on the interface go to what is under the drawn cursor.
  if (locked()) {
    const el = document.elementFromPoint(mouse.x, mouse.y);
    const btn = el && el !== canvas && el.closest('button');
    if (btn && e.button === 0) { btn.click(); return; }
  } else grabCursor();
  if (e.button === 0) {
    if (aiming) { castAiming(); return; }
    const id = view && view.pawnAt(mouse.x, mouse.y, me);
    if (id) select(id);
  }
  if (e.button === 2) {
    mouse.right = true;
    if (aiming) { aiming = null; placeCursor(); } // right-click cancels aiming (and moves, like Dota)
    moveOrder(true);
  }
});
document.addEventListener('mouseup', (e) => { if (e.button === 2) mouse.right = false; });
window.addEventListener('blur', () => { mouse.right = false; keys.clear(); });

// Spells: quick cast fires at the cursor at once; otherwise the key shows a
// Dota-style aim indicator and a left click casts (right click / Esc cancels).
const NO_TARGET = new Set(['scourge', 'windwalk', 'shield', 'rush', 'alteration', 'pact']);
let aiming = null; // { slot, key, level }
function slotForKey(code) {
  let slot = SPELL_CODES[code];
  if (slot === undefined && ITEM_CODES[code] !== undefined) {
    const it = inventory(myPawn(lastSnap))[ITEM_CODES[code]];
    slot = it && it.slot !== undefined ? it.slot : undefined;
  }
  return slot;
}
function castAt(slot) {
  const { x, y } = pick(mouse.x, mouse.y);
  sendInput({ cast: slot, x: Math.round(x), y: Math.round(y) });
}
function castAiming() {
  if (!aiming) return;
  castAt(aiming.slot);
  aiming = null;
  placeCursor();
}
function startCast(slot) {
  const p = myPawn(lastSnap);
  const sp = p && p.sp[slot];
  if (!sp || p.d) return;
  if (prefs.quickCast || NO_TARGET.has(sp[0])) { castAt(slot); return; }
  aiming = { slot, key: sp[0], level: sp[1] };
  placeCursor();
}

// Camera: free by default (move the mouse to the screen edge or use the arrow
// keys); tap 1 selects your hero, double-tap centres on it, hold 1 to follow.
const keys = new Set();
const cam = { x: 0, y: 0, snap: false };
let oneDownAt = 0;
let lastOneTap = 0;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { e.preventDefault(); onEscape(); return; }
  if (!started) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) { e.preventDefault(); keys.add(e.code); return; }
  if (e.repeat) return;
  if (e.code === 'Space' || e.code.startsWith('Digit') || e.code === 'F1') e.preventDefault();
  if (e.code === 'Digit1' || e.code === 'F1') {
    select(me);
    const now = performance.now();
    if (now - lastOneTap < 450) cam.snap = true; // double tap: jump to the hero
    lastOneTap = now;
    oneDownAt = now;
    keys.add('Digit1');
    return;
  }
  if (!$('menu').classList.contains('hidden') || !commanding()) return;
  if (e.code === 'KeyS') { aiming = null; placeCursor(); sendInput({ stop: true }); return; }
  const slot = slotForKey(e.code);
  if (slot === undefined) return;
  e.preventDefault();
  startCast(slot);
});
document.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'F1') keys.delete('Digit1');
});

// Esc: cancel aiming, then close the shop, then open / close the menu.
function onEscape() {
  if (aiming) { aiming = null; placeCursor(); return; }
  if (lastSnap && lastSnap.mode === 'dm' && shopOpen) { shopOpen = false; renderHud(lastSnap); return; }
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

// Camera target for this frame.
function updateCamera(s, dt) {
  const mine = myPawn(s);
  if (s.ph !== 'fight') { cam.started = false; return { mode: 'overview' }; }
  if (!cam.started && mine) { cam.started = true; cam.x = mine.x; cam.y = mine.y; } // round start: on your hero
  // The camera always follows your warlock; only while you are dead can you look around.
  if (mine && !mine.d) {
    cam.x = mine.x;
    cam.y = mine.y;
    const snap = cam.snap;
    cam.snap = false;
    return { mode: 'follow', x: cam.x, y: cam.y, snap };
  }
  cam.snap = false;
  // Edge and arrow-key panning, faster when zoomed out.
  const sp = 2200 * prefs.camSpeed * (view ? view.zoom : 1) * dt;
  const edge = 14;
  const canEdge = mouse.inside && $('menu').classList.contains('hidden') && $('shop').classList.contains('hidden');
  if (keys.has('ArrowLeft') || (canEdge && mouse.x <= edge)) cam.x -= sp;
  if (keys.has('ArrowRight') || (canEdge && mouse.x >= innerWidth - 1 - edge)) cam.x += sp;
  if (keys.has('ArrowUp') || (canEdge && mouse.y <= edge)) cam.y -= sp;
  if (keys.has('ArrowDown') || (canEdge && mouse.y >= innerHeight - 1 - edge)) cam.y += sp;
  const lim = s.layer * 100 + 900;
  const d = Math.hypot(cam.x, cam.y);
  if (d > lim) { cam.x *= lim / d; cam.y *= lim / d; }
  return { mode: 'free', x: cam.x, y: cam.y };
}

// What the aim indicator should show for a spell (Warlock Brawl values).
function aimShape(key, level, p) {
  const def = SPELLS[key];
  const L = (v) => (Array.isArray(v) ? Warlock.lv(v, level) : v);
  const rF = p && p.ms ? 1 + [0.12, 0.10, 0.09, 0.08, 0.07, 0.06].slice(0, p.ms[1]).reduce((a, b) => a + b, 0) : 1;
  const area = { meteor: [L(def.radius), def.range], warpzone: [L(def.radius), def.range], rockpillar: [def.pillar, L(def.range)], teleport: [60, L(def.range)], redirector: [45, 0] }[key];
  if (area) return { kind: 'area', radius: area[0], range: area[1] ? area[1] * (key === 'teleport' || key === 'rockpillar' ? 1 : rF) : 0 };
  const width = key === 'lightning' ? 25 : key === 'cluster' ? 70 : (L(def.radius) || 30);
  const range = (def.range ? L(def.range) : def.speed && def.life ? def.speed * def.life : 900) * rF;
  return { kind: 'line', width: width + Warlock.RADIUS, range };
}

// The six item slots: Fireball and Scourge (usable), then passive items in the order bought.
function inventory(p) {
  if (!p) return [];
  const inv = [];
  if (p.sp[0]) inv.push({ key: p.sp[0][0], level: p.sp[0][1], slot: 0 });
  if (p.sp[7]) inv.push({ key: p.sp[7][0], level: p.sp[7][1], slot: 7 });
  for (const k of Object.keys(p.it || {})) if (p.it[k] && ITEM_ORDER.includes(k)) inv.push({ key: k, level: p.it[k], slot: ITEM_SLOT[k] });
  return inv.slice(0, 6);
}

function colorOf(id, s) {
  const i = s.p.findIndex((p) => p.id === id);
  return Warlock.COLORS[(i < 0 ? 0 : i) % 10];
}

// ------------------------------------------------------------------ effects
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
  if (view) view.fx(e, s);
  switch (e.e) {
    case 'cast':
      Sfx.play({ fireball: 'wlFire', cluster: 'wlFire', homing: 'wlWhoosh', bouncer: 'wlWhoosh', boomerang: 'wlWhoosh', link: 'wlChain', gravity: 'wlGravity', windwalk: 'wlWind', rush: 'wlRush', shield: 'wlShield', thrust: 'wlWind', grip: 'wlChain', warpzone: 'wlGravity', alteration: 'wlShield', rockpillar: 'wlShrink', snowball: 'wlWind', magnetize: 'wlBlink' }[e.k] || 'wlWhoosh');
      break;
    case 'boom':
      Sfx.play(e.k === 'clash' ? 'wlClash' : 'wlBoom');
      break;
    case 'bolt':
      Sfx.play('wlBolt');
      break;
    case 'blink':
    case 'swap':
      Sfx.play('wlBlink');
      break;
    case 'scourge':
      Sfx.play('wlScourge');
      break;
    case 'meteor':
      Sfx.play('wlMeteor');
      break;
    case 'reflect':
    case 'magnet':
    case 'heal':
    case 'recharged':
      Sfx.play('wlShield');
      break;
    case 'split':
    case 'alter':
      Sfx.play('wlBlink');
      break;
    case 'snowboom':
    case 'obstacleBoom':
      Sfx.play('wlBoom');
      break;
    case 'grip':
      Sfx.play('wlChain');
      break;
    case 'redirect':
      Sfx.play('wlBlink');
      break;
    case 'pactBoost':
      Sfx.play('wlScourge');
      break;
    case 'pillar':
      Sfx.play('wlShrink');
      break;
    case 'link':
      Sfx.play('wlChain');
      break;
    case 'hit':
      if (e.id === me && e.n >= 5) { if (view) view.shake(10, 0.15); Sfx.play('wlHurt'); }
      break;
    case 'burn':
      if (e.id === me) Sfx.play('wlBurn');
      break;
    case 'death':
      Sfx.play('wlDeath');
      feed(e.by ? `💀 ${names[e.by] || '?'} ➜ ${names[e.id] || '?'}` : `🔥 ${t('{name} burned in the lava', { name: names[e.id] || '?' })}`);
      break;
    case 'shrink':
      Sfx.play('wlShrink');
      break;
    case 'fight':
      EndFx.close();
      banner(t('FIGHT!'), e.dm && e.round > 1 ? t('Round {n} – new teams and obstacles', { n: e.round }) : t('Round {n}', { n: e.round }));
      Sfx.play('wlHorn');
      break;
    case 'shop':
      readySent = false;
      Sfx.play('notify');
      break;
    case 'roundEnd': {
      if (e.dm) {
        banner(t('Round {n} over', { n: e.round }), t('+{n} gold', { n: 10 }), 2200);
        Sfx.play('roundWin');
        break;
      }
      const wins = e.winners || (e.winner ? [e.winner] : []);
      const mine = wins.includes(me);
      const text = mine ? t('ROUND WON!') : wins.length > 1 ? t('{team} team wins the round', { team: teamName(e.team) }) : wins.length ? t('{name} wins the round', { name: names[wins[0]] || '?' }) : t('Nobody survived');
      banner(text, wins.length > 1 ? wins.map((id) => names[id] || '?').join(' + ') : '', 2600);
      Sfx.play(mine ? 'roundWin' : 'roundLose');
      break;
    }
    case 'over': {
      const order = s.p.slice().sort((a, b) => b.sc - a.sc || b.k - a.k);
      const wins = e.winners || [order[0] && order[0].id];
      const won = wins.includes(me);
      EndFx.show({
        outcome: won ? 'win' : 'lose',
        title: won ? t('You won!') : t('{name} wins!', { name: wins.map((id) => names[id] || '?').join(' + ') }),
        detail: order.map((p) => `${names[p.id] || '?'} ${p.sc}`).join(' · '),
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
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!view) return;
  if (!started || !snaps.length) {
    // Lobby: the empty arena slowly turning behind the menu.
    const idle = { ph: 'lobby', layer: 14 + Math.max(2, players.length), p: [], b: [], shrink: 10 };
    view.frame({ s: idle, prev: idle, k: 1, since: 0, dt, me, names, cam: { mode: 'overview' } });
    return;
  }
  const s = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[0] : s;
  // Smooth positions between the last two snapshots.
  const k = Math.min(1, (now - snapAt) / (TICK * 1000));
  const mine = myPawn(s);
  if (aiming && (!mine || mine.d || s.ph !== 'fight' || !mine.sp[aiming.slot])) { aiming = null; placeCursor(); }
  const aim = aiming && mine ? { ...aimShape(aiming.key, aiming.level, mine), at: pick(mouse.x, mouse.y) } : null;
  view.frame({ s, prev, k, since: (now - snapAt) / 1000, dt, me, names, cam: updateCamera(s, dt), aim });
  if (s.ph !== 'fight' || !$('shop').classList.contains('hidden')) releaseQuietly();
  updateCooldowns(s, now);
}

// ------------------------------------------------------------------ HUD
function myPawn(s) { return s && s.p.find((p) => p.id === me); }

function renderHud(s) {
  const p = myPawn(s);
  const dm = s.mode === 'dm';
  const goal = s.win === 'score' ? t('first to {n}', { n: s.target }) : null;
  $('roundInfo').textContent = !s.round ? t('Get ready')
    : goal ? `${t('Round {n}', { n: s.round })} · ${goal}` : t('Round {n} of {m}', { n: s.round, m: s.rounds });
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  $('phaseInfo').textContent = s.ph === 'shop' ? t('Shop closes in {n} s', { n: Math.ceil(s.left) })
    : s.ph === 'fight' ? (dm ? `⏱ ${clock(Math.ceil(s.left))}` : '') + (dm ? ' · ' : '') + (s.layer > 1 ? t('Platform sinks in {n} s', { n: Math.ceil(s.shrink) }) : t('Last tile!'))
      : s.ph === 'over' ? t('Match over') : '';
  // Scoreboard, grouped by team when there are teams.
  const order = s.p.slice().sort((a, b) => b.sc - a.sc || b.k - a.k);
  const row = (q) => `<div class="row${q.d && s.ph === 'fight' ? ' dead' : ''}" style="border-left-color:${teamColor(q.tm)}"><i style="background:${colorOf(q.id, s)}"></i>${esc(names[q.id] || '?')}${q.id === me ? ' ★' : ''}<small>${q.d && q.rs ? `⟳${q.rs}` : `${q.k}💀`}</small><b>${q.sc}</b></div>`;
  const teamsOf = [...new Set(s.p.map((q) => q.tm))];
  const grouped = teamsOf.length < s.p.length;
  $('scores').innerHTML = grouped
    ? teamsOf.sort((a, b) => a - b).map((tm) => `<div class="team-head" style="background:${teamColor(tm)}33;color:${teamColor(tm)}">${esc(teamName(tm))}</div>${order.filter((q) => q.tm === tm).map(row).join('')}`).join('')
    : order.map(row).join('');
  // Deathmatch: the shop stays open; B (or F4) opens it.
  $('btnShop').classList.toggle('hidden', !(dm && s.ph === 'fight'));
  $('btnShop').textContent = `🛒 ${t('Shop')} (B)`;
  // The panel shows the selected hero (yourself unless you clicked another warlock).
  let u = s.p.find((q) => q.id === selId());
  if (!u || u.l || (u.id !== me && u.d)) { selected = null; if (view) view.selected = me; u = p; }
  renderCard(s, u);
  const inShop = s.ph === 'shop' || (dm && s.ph === 'fight' && shopOpen);
  $('shop').classList.toggle('hidden', !inShop);
  $('btnReady').classList.toggle('hidden', s.ph !== 'shop');
  if (inShop) renderShop(s, p);
}

let cardKey = '';
function renderCard(s, u) {
  if (!u) return;
  const mine = u.id === me;
  $('card').classList.toggle('enemy', !mine);
  $('hpFill').style.width = `${Math.max(0, (u.hp / u.mx) * 100)}%`;
  $('hpText').textContent = u.d ? (u.rs ? t('Respawn in {n} s', { n: u.rs }) : t('Dead – wait for the next round')) : `${u.hp} / ${u.mx}`;
  const ms = u.ms || [0, 0, 0];
  $('uStats').innerHTML = `<span>${esc(t('Knockback'))} <b>+${Math.round(u.dp / 10)}%</b></span><span>💀 ${u.k}</span><span>🏆 ${u.sc}</span>${ms.some((m) => m) ? `<span title="${esc(t('Masteries'))}">⏳${ms[0]} 🎯${ms[1]} 🩸${ms[2]}</span>` : ''}`;
  const inv = inventory(u);
  const key = JSON.stringify([u.id, u.sp, inv]);
  if (key === cardKey) return;
  cardKey = key;
  $('pImg').src = iconURL('hero', 168);
  $('portrait').style.borderColor = colorOf(u.id, s);
  $('pTag').textContent = mine ? t('YOU') : t('ENEMY');
  $('uName').innerHTML = `<i style="background:${colorOf(u.id, s)}"></i>${esc(names[u.id] || '?')}`;
  $('spellBar').innerHTML = SPELL_KEYS.map((k, i) => {
    const sp = u.sp[i + 1];
    const def = sp && SPELLS[sp[0]];
    return `<div class="spell${def ? '' : ' empty'}" data-slot="${i + 1}" title="${def ? esc(def.name) : ''}">${def ? `<img src="${iconURL(sp[0])}" alt="">` : ''}<span class="key">${mine ? k : ''}</span>${def ? `<span class="lvl">${sp[1]}</span>` : ''}${mine ? '<div class="cd"></div>' : ''}</div>`;
  }).join('');
  $('itemGrid').innerHTML = ITEM_KEYS.map((k, i) => {
    const it = inv[i];
    if (!it) return `<div class="item empty"><span class="key">${mine ? k : ''}</span></div>`;
    const name = SPELLS[it.key] ? SPELLS[it.key].name : ITEMS[it.key].name;
    const usable = it.slot !== undefined;
    return `<div class="item${usable ? '' : ' passive'}" ${usable ? `data-slot="${it.slot}"` : ''} title="${esc(name)}"><img src="${iconURL(it.key, 96)}" alt=""><span class="key">${mine ? k : ''}</span><span class="lvl">${it.level}</span>${mine && usable ? '<div class="cd"></div>' : ''}</div>`;
  }).join('');
}

// Cooldowns are only shown for your own hero, as in Dota.
function updateCooldowns(s, now) {
  const p = myPawn(s);
  if (!p || selId() !== me) return;
  const since = (now - snapAt) / 1000;
  for (const el of document.querySelectorAll('#card [data-slot]')) {
    const slot = el.dataset.slot;
    const sp = p.sp[slot];
    const cdEl = el.querySelector('.cd');
    if (!sp || !cdEl) continue;
    const left = Math.max(0, (p.cd[slot] || 0) - since);
    const total = Warlock.lv(SPELLS[sp[0]].cd, sp[1]);
    cdEl.style.setProperty('--cd', `${(left / total) * 100}%`);
    cdEl.textContent = left > 0.05 ? (left < 1 ? left.toFixed(1) : Math.ceil(left)) : '';
    el.classList.toggle('ready', left <= 0.05);
  }
}

let readySent = false;
let shopOpen = false;
$('btnShop').addEventListener('click', () => { shopOpen = !shopOpen; if (lastSnap) renderHud(lastSnap); });
document.addEventListener('keydown', (e) => {
  if (!started || e.repeat || !lastSnap || lastSnap.mode !== 'dm') return;
  if (e.code === 'KeyB' || e.code === 'F4') {
    e.preventDefault();
    shopOpen = !shopOpen;
    if (shopOpen) releaseQuietly();
    renderHud(lastSnap);
  }
});
function renderShop(s, p) {
  if (!p) return;
  $('gold').textContent = `💰 ${p.c}`;
  $('shopTime').textContent = s.ph === 'shop' ? t('Next round in {n} s', { n: Math.ceil(s.left) }) : t('Open all match – B closes it');
  const cols = [1, 2, 3, 4, 5, 6];
  const html = cols.map((col) => {
    const owned = p.sp[col];
    return `<div class="shop-col"><h4>${SPELL_KEYS[col - 1]}</h4>${COLUMN_SPELLS[col].map((k) => {
      const def = SPELLS[k];
      const mine = owned && owned[0] === k;
      const level = mine ? owned[1] : 0;
      const price = mine ? (level >= 7 ? null : def.up[level - 1]) : def.buy;
      const locked = owned && !mine;
      return `<button class="buy${mine ? ' owned' : ''}${locked ? ' locked' : ''}${price !== null && p.c < price ? ' poor' : ''}" data-buy="${k}" data-tip="${esc(spellTip(k))}">
        <img class="ic" src="${iconURL(k, 96)}" alt=""><span class="nm">${esc(def.name)}</span>
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
    const price = level >= max ? null : (k === 'fireball' || k === 'scourge' ? def.up[level - 1] : def.buy);
    return `<button class="buy${level ? ' owned' : ''}${price !== null && p.c < price ? ' poor' : ''}" data-buy="${k}" data-tip="${esc(itemTip(k))}"><img class="ic" src="${iconURL(k, 96)}" alt="">
      <span class="nm">${esc(def.name)} ${level ? `(${level}/${max})` : ''}</span><span class="pr">${price === null ? t('Max') : `💰 ${price}`}</span></button>`;
  }).join('');
  if ($('shopCols').dataset.html !== html) { $('shopCols').innerHTML = html; $('shopCols').dataset.html = html; }
  if ($('shopItems').dataset.html !== items) { $('shopItems').innerHTML = items; $('shopItems').dataset.html = items; }
  // Masteries: Duration, Range, Lifesteal (5 gold a level), or all three for 13.
  const M = Warlock.MASTERY;
  const ms = p.ms || [0, 0, 0];
  const mast = `<h4>${esc(t('MASTERIES'))}</h4>` + ['m_dur', 'm_range', 'm_life'].map((k, i) => {
    const level = ms[i];
    const max = level >= M.max;
    return `<button class="buy${level ? ' owned' : ''}${!max && p.c < M.cost ? ' poor' : ''}" data-buy="${k}" data-tip="${esc(itemTip(k))}"><img class="ic" src="${iconURL(k, 96)}" alt="">
      <span class="nm">${esc(t(M.names[i]))}</span><span class="pr">${max ? t('Max') : `💰 ${M.cost}`}</span><span class="lv">${'●'.repeat(level)}${'○'.repeat(M.max - level)}</span></button>`;
  }).join('') + (() => {
    const max = ms.some((m) => m >= M.max);
    return `<button class="buy${max || p.c < M.allCost ? ' poor' : ''}" data-buy="m_all" data-tip="${esc(itemTip('m_all'))}"><img class="ic" src="${iconURL('m_all', 96)}" alt=""><span class="nm">${esc(t('All three'))}</span><span class="pr">${max ? t('Max') : `💰 ${M.allCost}`}</span></button>`;
  })();
  if ($('shopMastery').dataset.html !== mast) { $('shopMastery').innerHTML = mast; $('shopMastery').dataset.html = mast; }
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
    twin: t('Two orbs fly on mirrored arcs and meet at the target.'),
    drain: t('Flies to the target, then turns to the nearest warlock: damages and slows it, and the stolen life flies back to heal you.'),
    recharge: t('A hit sends a spark back that resets its cooldown; every hit in a row adds 10 damage.'),
    splitter: t('Cast without turning: a bolt that bursts into eight smaller bolts.'),
    snowball: t('A big rolling snowball that carries warlocks along, chills them and bursts at the end.'),
    alteration: t('For 2 s you trade places with the first enemy spell that comes at you.'),
    grip: t('The warlock hit cannot walk, takes a third of the knockback, and every spell it casts adds damage points.'),
    warpzone: t('A zone that slows enemy spells inside it.'),
    magnetize: t('Magnetizes a warlock: other spells bend towards it. Bounce it off an obstacle onto yourself to push spells away.'),
    rockpillar: t('Raises a rock pillar for 4 s that blocks warlocks and spells.'),
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
    cursed: t('Cursed Ring: +100 / +200 health and 15% less knockback, but debuffs on you last 25% / 30% longer.'),
    watch: t('Pocket Watch: debuffs on you last 35% / 45% shorter.'),
    redirector: t('Redirector (usable): turns your own spell nearest to the cursor towards it; you take 30% more knockback for 8 s.'),
    pact: t('Pact (usable): your next damaging spell within 5 s hits 1.5 times as hard, then you are slowed for 6 s.'),
    m_dur: t('Duration mastery: your buffs, zones and pillars last longer and your debuffs on others too (+10% first level).'),
    m_range: t('Range mastery: your spells fly further (+12% first level).'),
    m_life: t('Lifesteal mastery: heal a share of the damage you deal (9% first level).'),
    m_all: t('One level of all three masteries for 13 gold.'),
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
  if (view) view.selected = me;
  names[info.host] = info.hostName;
  if (isHost) {
    players = [{ id: me, name: info.myName }];
  } else {
    players = [];
    const join = () => { if (!started) toHost({ kind: 'wl-join', name: info.myName }); };
    join();
    const timer = setInterval(() => (started ? clearInterval(timer) : join()), 1500);
  }
  renderLobby();
  if (!view) $('lobbySub').textContent = t('3D graphics are not available on this PC.');
  window.addEventListener('beforeunload', () => {
    if (isHost) toAll({ kind: 'wl-closed' });
    else toHost({ kind: 'wl-leave' });
  });
  requestAnimationFrame(frame);
}

// A small read-only handle for automated tests (module variables are not global).
window.WL = {
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
