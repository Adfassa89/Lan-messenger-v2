'use strict';
/* global api, I18N, Thirteen, Sfx, EndFx */
// The 13 (Big 2) table. The PC that opened the table (the host) runs
// Thirteen.Match and sends every player what they may see (their own cards,
// the others' card counts); players send their plays to the host.

const params = new URLSearchParams(location.search);
const conv = params.get('conv');
const gameId = params.get('id');
let t = (k, v) => I18N.translate(params.get('lang') || 'mn', k, v);
const $ = (id) => document.getElementById(id);
const { classify, beats, name: cardName, rank, suit, RANKS, SUITS } = Thirteen;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let info = null;
let isHost = false;
let me = null;
let players = []; // lobby: [{ id, name }] in seat order
let settings = { end: 'limit', limit: 30, minutes: 60, rate: 0, turnTime: 30 };
let started = false;
let match = null; // host only
let view = null; // what this player sees
let clockSkew = 0; // host time - our time
const names = {};
const avatars = {};
let selected = new Set();
let sortMode = 'rank';
let handOrder = []; // your cards in the order shown
let nextTimer = null;
let posted = false;

const send = (peerId, data) => api.rtcSend(peerId, gameId, data);
const toAll = (data) => { for (const p of players) if (p.id !== me) send(p.id, data); };
const toHost = (data) => send(info.host, data);

// ------------------------------------------------------------------ avatars
const COLORS = ['#e05a4f', '#4f8ae0', '#3fae6a', '#d99a2b', '#9a5fd6', '#2bb3b3', '#d65f9a', '#7a8a3a'];
const colorOf = (id) => COLORS[[...String(id)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
const initials = (n) => String(n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
function avatarHtml(id, cls = '') {
  const pic = avatars[id];
  const style = pic ? `background-image:url("${pic}")` : `background:${colorOf(id)}`;
  return `<span class="av ${cls}" style='${style}'>${pic ? '' : esc(initials(names[id]))}</span>`;
}
async function loadAvatars(ids) {
  const need = ids.filter((id) => !(id in avatars));
  if (!need.length) return;
  for (const id of need) avatars[id] = null;
  try {
    const got = await api.arenaAvatars(need);
    let changed = false;
    for (const [id, url] of Object.entries(got || {})) if (url) { avatars[id] = url; changed = true; }
    if (changed) { if (started) render(false); else renderLobby(); }
  } catch { /* initials then */ }
}

// ------------------------------------------------------------------ cards
function cardHtml(c, cls = '') {
  if (c === null || c === undefined) return `<div class="card back ${cls}"></div>`;
  const r = RANKS[rank(c)];
  const s = SUITS[suit(c)];
  const red = suit(c) === 0 || suit(c) === 2;
  const middle = ['J', 'Q', 'K'].includes(r) ? `<span class="face" data-suit="${s}">${r}</span>` : r === 'A' ? `<span class="pip" style="font-size:calc(var(--card-w) * .75)">${s}</span>` : `<span class="pip">${s}</span>`;
  return `<div class="card${red ? ' red' : ''} ${cls}" data-c="${c}"><span class="tl"><b>${r}</b><i>${s}</i></span>${middle}<span class="br"><b>${r}</b><i>${s}</i></span></div>`;
}
const COMBO = { single: 'Single', pair: 'Pair', triple: 'Three of a kind', straight: 'Straight', flush: 'Flush', fullhouse: 'Full house', four: 'Four of a kind', straightflush: 'Straight flush' };
const comboName = (type) => t(COMBO[type] || type);

// ------------------------------------------------------------------ lobby
function renderLobby() {
  $('lobbySub').textContent = isHost
    ? t('Players join from the chat. 2 – 4 players; start when everyone is in.')
    : started ? t('The match has started.') : t('Waiting for {name} to start the match…', { name: info.hostName });
  const seats = [0, 1, 2, 3].map((i) => {
    const p = players[i];
    if (!p) return `<div class="seat-item empty">${esc(t('Empty seat'))}</div>`;
    return `<div class="seat-item">${avatarHtml(p.id)}<b>${esc(p.name)}</b>${p.id === info.host ? `<small>${esc(t('Host'))}</small>` : ''}</div>`;
  }).join('');
  if ($('lobbyList').dataset.html !== seats) { $('lobbyList').innerHTML = seats; $('lobbyList').dataset.html = seats; }
  $('lobbyOpts').classList.toggle('hidden', !isHost);
  const seg = (id, key, list) => {
    const html = list.map(([v, l]) => `<button data-k="${key}" data-v="${v}" class="${settings[key] === v ? 'on' : ''}">${esc(l)}</button>`).join('');
    if ($(id).dataset.html !== html) { $(id).innerHTML = html; $(id).dataset.html = html; }
  };
  seg('endSeg', 'end', [['limit', t('Point limit')], ['time', t('Time limit')]]);
  seg('limitSeg', 'limit', [30, 40, 50, 70, 100].map((n) => [n, String(n)]));
  seg('timeSeg', 'minutes', [[30, t('{n} min', { n: 30 })], [60, t('{n} h', { n: 1 })], [90, t('{n} h', { n: 1.5 })], [120, t('{n} h', { n: 2 })]]);
  seg('rateSeg', 'rate', [[0, t('Off')], [100, '100₮'], [200, '200₮'], [500, '500₮'], [1000, '1000₮']]);
  seg('turnSeg', 'turnTime', [[0, t('Off')], [20, '20 s'], [30, '30 s'], [45, '45 s']]);
  $('limitRow').classList.toggle('hidden', settings.end !== 'limit');
  $('timeRow').classList.toggle('hidden', settings.end !== 'time');
  $('lobbyRules').textContent = [
    settings.end === 'limit' ? t('Whoever reaches {n} points is out; the last player left wins.', { n: settings.limit }) : t('Play for {n} minutes; the lowest points wins.', { n: settings.minutes }),
    settings.rate ? t('Each point is worth {n}₮.', { n: settings.rate }) : '',
    settings.turnTime ? t('{n} s per turn.', { n: settings.turnTime }) : '',
  ].filter(Boolean).join(' ');
  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnStart').disabled = players.length < 2;
  $('btnStart').textContent = players.length < 2 ? t('Waiting for players…') : t('Deal the cards ({n} players)', { n: players.length });
  $('howText').innerHTML = [
    t('Cards from low to high: 3 4 5 6 7 8 9 10 J Q K A 2. Suits from low to high: ♦ ♣ ♥ ♠.'),
    t('Play one card, a pair, three of a kind, or five cards: straight, flush, full house, four of a kind + 1, straight flush (each beats the one before). A 2 cannot be in a straight.'),
    t('Beat the cards on the table with the same number of cards, higher – or pass. When everyone passes, the last player starts again with anything.'),
    t('Whoever holds 3♦ (or the lowest card) starts the first game and must play it. The winner of a game starts the next.'),
    t('The first to play all their cards wins the game. The others get 1 point per card left, double with 10 or more, triple with all 13. Being dealt 13 different ranks wins at once.'),
  ].map((x) => `<p>${esc(x)}</p>`).join('');
}

$('lobbyOpts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (!b || !isHost) return;
  const k = b.dataset.k;
  settings[k] = k === 'end' ? b.dataset.v : Number(b.dataset.v);
  renderLobby();
  toAll({ kind: 'th-lobby', players, settings });
});

$('btnStart').addEventListener('click', () => {
  if (!isHost || started || players.length < 2) return;
  started = true;
  match = new Thirteen.Match(players, { ...settings, seed: Math.floor(Math.random() * 2 ** 31) });
  toAll({ kind: 'th-start', players });
  enterTable();
  match.deal(Date.now());
  broadcast();
  hostLoop();
});

function enterTable() {
  started = true;
  $('lobby').classList.add('hidden');
  $('table').classList.remove('hidden');
  Sfx.play('start');
}

// ------------------------------------------------------------------ host
function broadcast() {
  const fx = match.takeEvents();
  const now = Date.now();
  for (const p of match.players) {
    if (match.gone.has(p.id)) continue;
    const v = match.view(p.id, now);
    if (p.id === me) onView(v, fx);
    else send(p.id, { kind: 'th-view', v, fx });
  }
  // After a game: deal the next one shortly (or post the results at the end).
  const g = match.game;
  if (match.over) { postResults(); return; }
  if (g && g.winner && !nextTimer) nextTimer = setTimeout(nextGame, 9000);
}

function nextGame() {
  clearTimeout(nextTimer);
  nextTimer = null;
  if (!match || match.over || !match.game || !match.game.winner) return;
  match.deal(Date.now());
  broadcast();
}

function hostLoop() {
  setInterval(() => {
    if (!match || match.over) return;
    match.tick(Date.now());
    if (match.events.length) broadcast();
  }, 250);
}

function hostAct(id, d) {
  if (!match) return;
  if (d.next && id === me) { nextGame(); return; }
  const r = match.play(id, d.pass ? [] : (Array.isArray(d.play) ? d.play.map(Number) : []), Date.now());
  if (r.error) {
    if (id === me) showError(r.error);
    else send(id, { kind: 'th-err', error: r.error });
  }
  broadcast();
}

function postResults() {
  if (posted || !match || !match.over) return;
  posted = true;
  const ids = match.players.map((p) => p.id);
  const order = ids.slice().sort((a, b) => match.totals[a] - match.totals[b] || match.wins[b] - match.wins[a]);
  const net = match.over.settle.net;
  const lines = order.map((id, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${names[id] || '?'} – ${t('{n} points', { n: match.totals[id] })}, ${t('{n} games won', { n: match.wins[id] })}${match.rate ? ` (${net[id] >= 0 ? '+' : ''}${net[id]}₮)` : ''}`);
  api.warlockResult(conv, gameId, `🃏 13 – ${t('{name} wins!', { name: names[match.over.winner] || '?' })}\n${lines.join('\n')}`).catch(() => {});
}

// ------------------------------------------------------------------ network
api.on(({ type, payload }) => {
  if (type !== 'rtc' || payload.sid !== gameId) return;
  const from = payload.peerId;
  const d = payload.data || {};
  if (isHost) {
    if (d.kind === 'th-join') {
      if (!players.some((p) => p.id === from)) {
        if (started || players.length >= 4) return send(from, { kind: 'th-full' });
        players.push({ id: from, name: String(d.name || '?').slice(0, 40) });
        names[from] = players[players.length - 1].name;
        loadAvatars([from]);
        Sfx.play('notify');
      }
      renderLobby();
      toAll({ kind: 'th-lobby', players, settings });
    } else if (d.kind === 'th-leave') {
      if (!started) {
        players = players.filter((p) => p.id !== from);
        renderLobby();
        toAll({ kind: 'th-lobby', players, settings });
      } else if (match) { match.leave(from, Date.now()); broadcast(); }
    } else if (d.kind === 'th-act') hostAct(from, d);
    return;
  }
  if (from !== info.host) return;
  if (d.kind === 'th-lobby') {
    players = Array.isArray(d.players) ? d.players : [];
    for (const p of players) names[p.id] = p.name;
    if (d.settings) settings = d.settings;
    loadAvatars(players.map((p) => p.id));
    renderLobby();
  } else if (d.kind === 'th-start') {
    if (Array.isArray(d.players)) { players = d.players; for (const p of players) names[p.id] = p.name; }
    if (!started) enterTable();
  } else if (d.kind === 'th-view') {
    if (!started) enterTable();
    onView(d.v, d.fx || []);
  } else if (d.kind === 'th-err') showError(d.error);
  else if (d.kind === 'th-full') $('lobbySub').textContent = t('This table is full or the match has already started.');
  else if (d.kind === 'th-closed') { toast(t('{name} closed the table.', { name: info.hostName })); }
});

function act(d) {
  if (isHost) hostAct(me, d);
  else toHost({ kind: 'th-act', ...d });
}

// ------------------------------------------------------------------ view updates
let prevView = null;
function onView(v, fx) {
  clockSkew = v.now - Date.now();
  for (const p of v.players) if (!names[p.id]) names[p.id] = p.name;
  loadAvatars(v.players.map((p) => p.id));
  const before = prevView;
  // Where played cards start from, measured before the screen changes.
  const sources = {};
  for (const e of fx) {
    if (e.e !== 'play') continue;
    if (e.id === me) sources[e.id] = e.cards.map((c) => { const el = $('hand').querySelector(`[data-c="${c}"]`); return el ? el.getBoundingClientRect() : null; });
    else { const s = document.querySelector(`.seat[data-id="${CSS.escape(e.id)}"] .backs`); sources[e.id] = s ? s.getBoundingClientRect() : null; }
  }
  view = v;
  prevView = v;
  const dealt = fx.some((e) => e.e === 'deal');
  if (dealt) { selected.clear(); handOrder = []; $('results').classList.add('hidden'); clearPile(); }
  render(dealt);
  for (const e of fx) effect(e, sources, before);
  if (dealt) animateDeal();
}

function effect(e, sources) {
  switch (e.e) {
    case 'play': {
      if (e.id === me) selected.clear();
      pushPile(e, sources[e.id]);
      Sfx.play('cardPlay');
      break;
    }
    case 'pass':
      bubble(e.id, t('Pass'));
      Sfx.play('cardPass');
      break;
    case 'trick':
      sweepPile();
      Sfx.play('cardSweep');
      break;
    case 'timeout':
      if (e.id === me) toast(t('Time is up – the game played for you'));
      break;
    case 'dragon':
      toast(t('{name} was dealt 13 different cards – instant win!', { name: names[e.id] || '?' }), 5000);
      break;
    case 'gameOver':
      gameOver(e);
      break;
    case 'out':
      toast(t('{name} reached the point limit and is out', { name: names[e.id] || '?' }), 4000);
      break;
    case 'tiebreak':
      toast(t('Tie! {names} play one deciding game', { names: e.ids.map((id) => names[id] || '?').join(', ') }), 6000);
      break;
    case 'matchOver':
      setTimeout(() => matchOver(e), 2500);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ render
// Seats around the table, counting from you (bottom), in play order.
function seatSpots(n) {
  return { 1: [], 2: ['top'], 3: ['right', 'left'], 4: ['right', 'top', 'left'] }[n] || ['right', 'top', 'left'];
}
// Seats hug the table's edge: top centred, left and right anchored to their side.
function seatStyle(spot) {
  const top = Math.round(innerHeight * 0.34);
  return {
    top: 'left:50%;top:58px;transform:translateX(-50%)',
    left: `left:34px;top:${top}px;align-items:flex-start`,
    right: `right:34px;top:${top}px;align-items:flex-end`,
  }[spot];
}

function render(fresh) {
  const v = view;
  if (!v) return;
  const g = v.game;
  const order = (g ? g.seats : v.players.map((p) => p.id));
  const all = v.players.map((p) => p.id);
  // Others in play order starting after you.
  const idx = all.indexOf(me);
  const others = idx >= 0 ? [...all.slice(idx + 1), ...all.slice(0, idx)] : all;
  const spots = seatSpots(Math.min(4, all.length));
  const now = Date.now() + clockSkew;
  $('roundTag').textContent = v.tiebreak ? t('Deciding game') : t('Game {n}', { n: v.round });
  if (v.end === 'limit') $('matchTag').textContent = t('Point limit {n}', { n: v.limit });
  else {
    const left = Math.max(0, v.minutes * 60000 - (now - v.started));
    $('matchTag').textContent = left > 0 ? t('Time left {m}', { m: `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}` }) : t('Last game');
  }
  $('rateTag').classList.toggle('hidden', !v.rate);
  $('rateTag').textContent = t('{n}₮ per point', { n: v.rate });
  // Opponents.
  const html = others.map((id, i) => {
    const spot = spots[i] || 'top';
    const inGame = g && g.seats.includes(id);
    const count = inGame ? g.counts[id] : 0;
    const reveal = g && g.reveal && g.reveal[id] && g.reveal[id].length && id !== me;
    const backs = inGame && !reveal && count > 0 ? `<div class="backs" style="width:${38 + Math.max(0, Math.min(count, 13) - 1) * 6}px">${Array.from({ length: Math.min(count, 13) }, (_, k) => `<div class="card back" style="left:${k * 6}px"></div>`).join('')}<span class="count${count && count <= 2 ? ' low' : ''}">${count}</span></div>` : '';
    const shown = reveal ? `<div class="reveal">${g.reveal[id].map((c) => cardHtml(c)).join('')}</div>` : '';
    const turn = g && !g.winner && g.turn === id;
    const out = v.out.includes(id) || v.gone.includes(id) || (g && !inGame);
    return `<div class="seat ${spot}${turn ? ' turn' : ''}${out ? ' out' : ''}" data-id="${esc(id)}" style="${seatStyle(spot)}">
      <div class="who"><span style="position:relative">${avatarHtml(id)}${turn && v.turnTime ? '<span class="ring"></span>' : ''}</span>
        <div class="info"><b>${esc(names[id] || '?')}</b><small><em>${v.totals[id] ?? 0}</em> ${esc(t('pts'))} · ${v.wins[id] ?? 0} ${esc(t('wins'))}${v.gone.includes(id) ? ` · ${esc(t('left'))}` : v.out.includes(id) ? ` · ${esc(t('out'))}` : ''}</small></div></div>
      ${backs}${shown}${g && g.winner === id ? '<span class="crown">👑</span>' : ''}</div>`;
  }).join('');
  $('seats').innerHTML = html;
  // You.
  const myTurn = g && !g.winner && g.turn === me;
  $('meBar').className = `me-bar${myTurn ? ' turn' : ''}`;
  $('meBar').innerHTML = `<span style="position:relative">${avatarHtml(me, 'lg')}${myTurn && v.turnTime ? '<span class="ring" style="position:absolute;inset:-5px"></span>' : ''}</span>
    <div class="info"><b>${esc(names[me] || '')}</b><small><em>${v.totals[me] ?? 0}</em> ${esc(t('pts'))} · ${v.wins[me] ?? 0} ${esc(t('wins'))}</small></div>${g && g.winner === me ? '<span style="font-size:26px">👑</span>' : ''}`;
  renderHand(fresh);
  updateButtons();
  void order;
}

function sortCards(list) {
  return list.slice().sort(sortMode === 'rank' ? (a, b) => a - b : (a, b) => suit(a) - suit(b) || a - b);
}

function renderHand(fresh) {
  const g = view && view.game;
  const hand = g && g.hand ? g.hand : [];
  // Keep your own order; new cards (a fresh deal) are sorted.
  if (fresh || !handOrder.length) handOrder = sortCards(hand);
  else handOrder = handOrder.filter((c) => hand.includes(c)).concat(hand.filter((c) => !handOrder.includes(c)));
  for (const c of [...selected]) if (!hand.includes(c)) selected.delete(c);
  const el = $('hand');
  el.innerHTML = handOrder.map((c) => cardHtml(c, selected.has(c) ? 'sel' : '')).join('');
  layoutHand();
  el.classList.toggle('wait', !(g && !g.winner && g.turn === me));
}

function layoutHand() {
  const el = $('hand');
  const cards = [...el.children];
  const n = cards.length;
  if (!n) return;
  const cw = cards[0].offsetWidth || 76;
  const room = Math.min(innerWidth - 420, 1000);
  const step = Math.min(cw * 0.72, (room - cw) / Math.max(1, n - 1));
  const total = cw + step * (n - 1);
  const x0 = (innerWidth - total) / 2;
  cards.forEach((c, i) => {
    const k = n > 1 ? i / (n - 1) - 0.5 : 0;
    const lift = selected.has(Number(c.dataset.c)) ? -28 : 0;
    const arc = Math.abs(k) * Math.abs(k) * 26;
    c.style.left = `${x0 + i * step}px`;
    c.style.zIndex = String(i + 1);
    c.style.transform = `translateY(${arc + lift}px) rotate(${k * 10}deg)`;
  });
}

function updateButtons() {
  const g = view && view.game;
  const myTurn = !!(g && !g.winner && g.turn === me && !view.over);
  const sel = [...selected];
  const check = checkPlay(sel);
  $('btnPlay').disabled = !myTurn || !check.ok;
  $('btnPass').disabled = !myTurn || !g.table;
  $('btnClear').disabled = !sel.length;
  $('btnSort').textContent = sortMode === 'rank' ? t('Sort by suit') : t('Sort by rank');
  const hint = $('hint');
  hint.className = 'hint';
  if (!g || g.winner || view.over) hint.textContent = '';
  else if (!myTurn) hint.textContent = g.seats.includes(me) ? t('Waiting for {name}…', { name: names[g.turn] || '?' }) : t('You are watching this game');
  else if (!sel.length) hint.textContent = g.mustPlay !== null ? t('Your turn – start with {card}', { card: cardName(g.mustPlay) }) : g.table ? t('Your turn – beat the table or pass') : t('Your turn – start a new trick with anything');
  else { hint.textContent = check.ok ? `✓ ${comboName(check.combo.type)}` : check.msg; hint.classList.add(check.ok ? 'good' : 'bad'); }
}

// The same checks as the host, with friendly messages.
function checkPlay(cards) {
  const g = view && view.game;
  if (!g || !cards.length) return { ok: false, msg: '' };
  const combo = classify(cards);
  if (!combo) return { ok: false, msg: t('Not a valid combination') };
  if (g.mustPlay !== null && !cards.includes(g.mustPlay)) return { ok: false, msg: t('The first play must include {card}', { card: cardName(g.mustPlay) }) };
  if (g.table) {
    const tc = classify(g.table.cards);
    if (tc.n !== combo.n) return { ok: false, msg: t('Play {n} cards to beat the table', { n: tc.n }) };
    if (!beats(combo, tc)) return { ok: false, msg: t('Too low – {name} on the table is higher', { name: comboName(tc.type) }) };
  }
  return { ok: true, combo };
}

// ------------------------------------------------------------------ the pile
function clearPile() {
  for (const p of [...$('pile').querySelectorAll('.play')]) p.remove();
  $('pileLabel').textContent = '';
}
function pushPile(e, from) {
  const pile = $('pile');
  const plays = [...pile.querySelectorAll('.play:not(.swept)')];
  for (const p of plays) {
    if (p.classList.contains('old')) { p.classList.remove('old'); p.classList.add('older'); } else if (p.classList.contains('older')) p.remove();
    else p.classList.add('old');
  }
  const div = document.createElement('div');
  div.className = 'play';
  div.innerHTML = e.cards.map((c) => cardHtml(c)).join('');
  pile.insertBefore(div, $('pileLabel'));
  $('pileLabel').textContent = `${names[e.id] || '?'} · ${comboName(e.type)}`;
  // Fly each card in from the hand or the player's seat.
  const cards = [...div.children];
  cards.forEach((card, i) => {
    const to = card.getBoundingClientRect();
    const src = Array.isArray(from) ? from[i] : from;
    if (!src) return;
    const dx = src.left + src.width / 2 - (to.left + to.width / 2);
    const dy = src.top + src.height / 2 - (to.top + to.height / 2);
    const s = src.width / to.width;
    const flip = !Array.isArray(from);
    card.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${(Math.random() - 0.5) * 30}deg)${flip ? ' rotateY(180deg)' : ''}`, filter: flip ? 'brightness(.4)' : 'none' },
      { transform: `translate(0, 0) scale(1) rotate(${(i - (cards.length - 1) / 2) * 3}deg)`, filter: 'none' },
    ], { duration: 420, delay: i * 45, easing: 'cubic-bezier(.2,.9,.3,1.05)', fill: 'backwards' });
    card.style.transform = `rotate(${(i - (cards.length - 1) / 2) * 3}deg)`;
  });
}
function sweepPile() {
  const plays = [...$('pile').querySelectorAll('.play')];
  for (const p of plays) { p.classList.remove('old', 'older'); p.classList.add('swept'); }
  setTimeout(() => plays.forEach((p) => p.remove()), 450);
  $('pileLabel').textContent = '';
}

// ------------------------------------------------------------------ animations
function animateDeal() {
  const g = view.game;
  if (!g) return;
  const center = { x: innerWidth / 2, y: innerHeight * 0.45 };
  const cards = [...$('hand').children];
  cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    c.animate([
      { transform: `translate(${center.x - r.left - r.width / 2}px, ${center.y - r.top - r.height / 2}px) rotateY(180deg) scale(.6)`, filter: 'brightness(.3)' },
      { transform: c.style.transform, filter: 'none' },
    ], { duration: 380, delay: i * 55, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
    setTimeout(() => Sfx.play('cardDeal'), i * 55);
  });
  for (const s of document.querySelectorAll('.seat .backs')) {
    const r = s.getBoundingClientRect();
    s.animate([{ transform: `translate(${center.x - r.left - r.width / 2}px, ${center.y - r.top - r.height / 2}px) scale(.5)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, easing: 'ease-out' });
  }
}

function bubble(id, text) {
  const host = id === me ? $('meBar') : document.querySelector(`.seat[data-id="${CSS.escape(id)}"]`);
  if (!host) return;
  const b = document.createElement('span');
  b.className = 'bubble';
  b.textContent = text;
  if (id === me) Object.assign(b.style, { position: 'absolute', left: '60px', top: '-34px', padding: '4px 12px', borderRadius: '14px', background: '#fff', color: '#1c1f24', fontWeight: 800 });
  host.append(b);
  setTimeout(() => b.remove(), 1600);
}

function floatPoints(id, n) {
  const host = id === me ? $('meBar') : document.querySelector(`.seat[data-id="${CSS.escape(id)}"]`);
  if (!host || !n) return;
  const r = host.getBoundingClientRect();
  const p = document.createElement('div');
  p.className = 'pts';
  p.textContent = `+${n}`;
  Object.assign(p.style, { position: 'fixed', left: `${r.left + r.width / 2}px`, top: `${r.top - 10}px` });
  document.body.append(p);
  setTimeout(() => p.remove(), 2500);
}

let toastTimer = null;
function toast(text, ms = 2600) {
  $('toast').textContent = text;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), ms);
}
function showError(err) {
  const map = {
    'Not your turn': t('It is not your turn'),
    'You start this trick, so you must play': t('You start this trick, so you must play'),
    'That is not a valid combination': t('Not a valid combination'),
  };
  toast(map[err] || err);
  $('hand').classList.remove('shake');
  void $('hand').offsetWidth;
  $('hand').classList.add('shake');
  Sfx.play('illegal');
}

// ------------------------------------------------------------------ end of a game / the match
function gameOver(e) {
  const g = view.game;
  for (const [id, n] of Object.entries(e.points)) floatPoints(id, n);
  Sfx.play(e.winner === me ? 'win' : 'cardSweep');
  if (e.winner === me) bubble(me, t('You won this game!'));
  setTimeout(() => {
    if (!view || view.over || view.game !== g) return;
    showResults(e);
  }, 1800);
}

function standingsTable(v, last) {
  const ids = v.players.map((p) => p.id);
  const order = ids.slice().sort((a, b) => v.totals[a] - v.totals[b] || v.wins[b] - v.wins[a]);
  const net = v.over && v.over.settle ? v.over.settle.net : null;
  return `<table class="res-table"><tr><th>${esc(t('Player'))}</th>${last ? `<th>${esc(t('Cards left'))}</th><th>${esc(t('This game'))}</th>` : ''}<th>${esc(t('Points'))}</th><th>${esc(t('Wins'))}</th>${net && v.rate ? `<th>${esc(t('Money'))}</th>` : ''}</tr>
    ${order.map((id) => {
      const h = last;
      const pts = h ? h.points[id] : null;
      return `<tr class="${id === me ? 'me' : ''}${v.out.includes(id) || v.gone.includes(id) ? ' out' : ''}"><td><span class="name">${avatarHtml(id)}${esc(names[id] || '?')}${v.out.includes(id) ? ` (${esc(t('out'))})` : ''}</span></td>
        ${h ? `<td>${h.left[id] ?? '–'}</td><td class="${h.winner === id ? 'win' : 'plus'}">${h.winner === id ? '👑' : pts !== undefined ? `+${pts}` : '–'}</td>` : ''}
        <td><b>${v.totals[id]}</b></td><td>${v.wins[id]}</td>${net && v.rate ? `<td class="${net[id] >= 0 ? 'money-pos' : 'money-neg'}">${net[id] >= 0 ? '+' : ''}${net[id].toLocaleString()}₮</td>` : ''}</tr>`;
    }).join('')}</table>`;
}

function showResults(e) {
  const v = view;
  const last = v.history[v.history.length - 1];
  const r = $('results');
  r.innerHTML = `<h2>${e.winner === me ? esc(t('You won this game!')) : esc(t('{name} won this game', { name: names[e.winner] || '?' }))}</h2>
    ${e.dragon ? `<p>${esc(t('13 different cards – instant win!'))}</p>` : '<p></p>'}
    ${standingsTable(v, last)}
    <div class="res-next" id="resNext">${esc(t('Next game starts in a few seconds…'))}</div>
    ${isHost ? `<div class="res-btns"><button class="big-btn" id="btnNext">${esc(t('Deal now'))}</button></div>` : ''}`;
  r.classList.remove('hidden');
  if ($('btnNext')) $('btnNext').onclick = () => act({ next: 1 });
}

function matchOver(e) {
  const v = view;
  $('results').classList.add('hidden');
  const won = e.winner === me;
  const settle = v.over && v.over.settle;
  const pays = settle && v.rate ? settle.pays.map((p) => `<div>${esc(names[p.from] || '?')} → <b>${esc(names[p.to] || '?')}</b>: ${p.points} × ${v.rate}₮ = <span class="tg">${p.amount.toLocaleString()}₮</span></div>`).join('') : '';
  $('modalCard').innerHTML = `<h2 style="color:var(--gold);margin:0 0 6px">${won ? esc(t('You won the match!')) : esc(t('{name} wins the match!', { name: names[e.winner] || '?' }))}</h2>
    <p style="color:var(--muted);margin:0 0 10px">${esc({ limit: t('Everyone else reached the point limit.'), time: t('Time is up – lowest points wins.'), tiebreak: t('Won the deciding game.'), left: t('The other players left.'), last: t('Last player at the table.') }[e.reason] || '')}</p>
    ${standingsTable(v, null)}
    ${pays ? `<div class="pays"><b>${esc(t('Who pays whom'))}</b>${pays}</div>` : ''}
    <div class="res-btns"><button class="big-btn" id="btnCloseMatch">${esc(t('Close'))}</button></div>`;
  $('modal').classList.remove('hidden');
  $('btnCloseMatch').onclick = () => window.close();
  EndFx.show({ outcome: won ? 'win' : 'lose', title: won ? t('You won!') : t('{name} wins!', { name: names[e.winner] || '?' }), detail: '', buttons: [{ label: t('See the results'), primary: true, action: () => EndFx.close() }] });
}

// ------------------------------------------------------------------ input
$('hand').addEventListener('click', (e) => {
  const c = e.target.closest('.card');
  if (!c) return;
  const n = Number(c.dataset.c);
  if (selected.has(n)) selected.delete(n); else selected.add(n);
  c.classList.toggle('sel', selected.has(n));
  Sfx.play('cardSelect');
  layoutHand();
  updateButtons();
});
// Right-click (or double-click) a card picks all cards of that rank.
$('hand').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const c = e.target.closest('.card');
  if (!c) return;
  const r = rank(Number(c.dataset.c));
  const same = handOrder.filter((x) => rank(x) === r);
  const all = same.every((x) => selected.has(x));
  for (const x of same) if (all) selected.delete(x); else selected.add(x);
  renderHand(false);
  updateButtons();
});
$('btnPlay').onclick = () => {
  const sel = [...selected];
  const check = checkPlay(sel);
  if (!check.ok) { showError(check.msg); return; }
  act({ play: sel });
};
$('btnPass').onclick = () => { selected.clear(); act({ pass: 1 }); };
$('btnClear').onclick = () => { selected.clear(); renderHand(false); updateButtons(); };
$('btnSort').onclick = () => {
  sortMode = sortMode === 'rank' ? 'suit' : 'rank';
  handOrder = sortCards(handOrder);
  renderHand(false);
  updateButtons();
};
document.addEventListener('keydown', (e) => {
  if (!started) return;
  if (e.key === 'Enter' && !$('btnPlay').disabled) $('btnPlay').click();
  else if ((e.key === 'p' || e.key === 'P' || e.code === 'KeyP') && !$('btnPass').disabled) $('btnPass').click();
  else if (e.key === 'Escape') $('btnClear').click();
});
$('btnScores').onclick = () => {
  if (!view) return;
  $('modalCard').innerHTML = `<h2 style="color:var(--gold);margin:0 0 10px">${esc(t('Scores'))}</h2>${standingsTable(view, null)}
    <div class="pays">${view.history.slice().reverse().slice(0, 12).map((h) => `<div>${esc(t('Game {n}', { n: h.round }))}: 👑 <b>${esc(names[h.winner] || '?')}</b>${h.dragon ? ' 🐉' : ''} · ${Object.entries(h.points).filter(([, p]) => p).map(([id, p]) => `${esc(names[id] || '?')} +${p}`).join(', ')}</div>`).join('')}</div>
    <div class="res-btns"><button class="big-btn" id="btnCloseScores">${esc(t('Close'))}</button></div>`;
  $('modal').classList.remove('hidden');
  $('btnCloseScores').onclick = () => $('modal').classList.add('hidden');
};
$('btnLeave').onclick = () => {
  if (view && !view.over && !confirm(t('Leave the match? You cannot come back in.'))) return;
  window.close();
};
window.addEventListener('resize', () => { if (started) render(false); });

// Turn timer ring and the time limit clock.
setInterval(() => {
  if (!view || !view.game || !view.turnTime) return;
  const g = view.game;
  const now = Date.now() + clockSkew;
  const p = Math.max(0, 1 - (now - g.turnStart) / (view.turnTime * 1000));
  for (const r of document.querySelectorAll('.ring')) r.style.setProperty('--p', `${p * 100}%`);
  if (g.turn === me && !g.winner && p > 0 && p < 0.2 && !updateButtons.warned) { updateButtons.warned = true; Sfx.play('lowtime'); }
  if (g.turn !== me) updateButtons.warned = false;
}, 200);
setInterval(() => {
  if (!view || view.end !== 'time') return;
  const now = Date.now() + clockSkew;
  const left = Math.max(0, view.minutes * 60000 - (now - view.started));
  $('matchTag').textContent = left > 0 ? t('Time left {m}', { m: `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}` }) : t('Last game');
}, 1000);
// Your turn: a chime.
let lastTurn = null;
setInterval(() => {
  const g = view && view.game;
  const mine = g && !g.winner && g.turn === me;
  if (mine && lastTurn !== `${view.round}:${g.turnStart}`) { lastTurn = `${view.round}:${g.turnStart}`; Sfx.play('cardTurn'); }
}, 300);

// ------------------------------------------------------------------ start
async function init() {
  info = await api.warlockInfo(conv, gameId);
  if (!info) return window.close();
  t = (k, v) => I18N.translate(info.language, k, v);
  document.documentElement.lang = info.language;
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t(e.dataset.t);
  me = info.me;
  isHost = info.host === me;
  names[me] = info.myName;
  names[info.host] = info.hostName;
  loadAvatars([me, info.host]);
  if (isHost) players = [{ id: me, name: info.myName }];
  else {
    const join = () => { if (!started) toHost({ kind: 'th-join', name: info.myName }); };
    join();
    const timer = setInterval(() => (started ? clearInterval(timer) : join()), 1500);
  }
  renderLobby();
  window.addEventListener('beforeunload', () => {
    if (isHost) toAll({ kind: 'th-closed' });
    else toHost({ kind: 'th-leave' });
  });
}

// For automated tests.
window.TH = {
  get players() { return players; }, get view() { return view; }, get match() { return match; }, get me() { return me; }, get selected() { return selected; }, act,
};

init();
