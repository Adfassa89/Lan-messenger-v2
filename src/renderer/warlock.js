/* global api, I18N, Warlock, Sfx, EndFx */
import { View } from './warlock3d.js';
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
  const list = players.map((p, i) => `<li><i style="color:${Warlock.COLORS[i % 10]};background:${Warlock.COLORS[i % 10]}"></i>${esc(p.name)}${p.id === info.host ? `<small>${esc(t('Host'))}</small>` : ''}</li>`).join('');
  if ($('lobbyList').dataset.html !== list) { $('lobbyList').innerHTML = list; $('lobbyList').dataset.html = list; }
  $('lobbyOpts').classList.toggle('hidden', !isHost);
  const seg = [3, 5, 7, 11].map((n) => `<button data-r="${n}" class="${n === rounds ? 'on' : ''}">${n}</button>`).join('');
  if ($('roundsSeg').dataset.html !== seg) { $('roundsSeg').innerHTML = seg; $('roundsSeg').dataset.html = seg; }
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

// ------------------------------------------------------------------ 3D view
const canvas = $('view');
let view = null;
try {
  view = new View(canvas, $('labels'));
} catch (err) {
  console.error(err);
}
window.addEventListener('resize', () => view && view.resize());

// ------------------------------------------------------------------ input
let mouse = { x: 0, y: 0 };
const pick = (cx, cy) => (view ? view.pick(cx, cy) : { x: 0, y: 0 });
canvas.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (e.buttons & 2) moveTo(e, false);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) moveTo(e, true);
});
let lastMoveSent = 0;
function moveTo(e, click) {
  const now = performance.now();
  if (!click && now - lastMoveSent < 50) return;
  lastMoveSent = now;
  const { x, y } = pick(e.clientX, e.clientY);
  sendInput({ move: [Math.round(x), Math.round(y)] });
  if (click && view) view.showMove(x, y);
}
document.addEventListener('keydown', (e) => {
  if (!started || e.repeat) return;
  if (e.code === 'KeyS') { sendInput({ stop: true }); return; }
  const slot = KEY_TO_SLOT[e.code];
  if (slot === undefined) return;
  e.preventDefault();
  const { x, y } = pick(mouse.x, mouse.y);
  sendInput({ cast: slot, x: Math.round(x), y: Math.round(y) });
});

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
      Sfx.play({ fireball: 'wlFire', cluster: 'wlFire', homing: 'wlWhoosh', bouncer: 'wlWhoosh', boomerang: 'wlWhoosh', link: 'wlChain', gravity: 'wlGravity', windwalk: 'wlWind', rush: 'wlRush', shield: 'wlShield', thrust: 'wlWind' }[e.k] || 'wlWhoosh');
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
      Sfx.play('wlShield');
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
    view.frame({ s: idle, prev: idle, k: 1, since: 0, dt, me, names, follow: false });
    return;
  }
  const s = snaps[snaps.length - 1];
  const prev = snaps.length > 1 ? snaps[0] : s;
  // Smooth positions between the last two snapshots.
  const k = Math.min(1, (now - snapAt) / (TICK * 1000));
  const mine = myPawn(s);
  const follow = !!(mine && !mine.d && s.ph === 'fight');
  view.frame({ s, prev, k, since: (now - snapAt) / 1000, dt, me, names, follow });
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
};

init();
