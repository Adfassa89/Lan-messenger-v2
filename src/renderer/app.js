'use strict';
/* global api, EMOJI, I18N, openEditor, Voice, Share, Game */

// ------------------------------------------------------------------ state
const S = {
  me: null,
  settings: {},
  manualPeers: [],
  peers: new Map(),
  groups: new Map(),
  convs: new Map(),
  msgs: new Map(), // conv -> array (oldest first)
  hasMore: new Map(), // conv -> bool
  avatars: new Map(), // peerId -> data URL
  scheduled: [],
  active: null,
  typing: new Map(), // conv -> Map(peerId -> timeout)
  progress: new Map(), // msgId -> { done, size, speed, upload }
  thumbs: new Map(), // path -> { url }
  filter: '',
  platform: '',
  replyTo: null, // message being replied to
  editing: null, // message being edited
  updateReady: null,
};
const PAGE = 150;
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '✅'];
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const t = (key, vars) => I18N.translate(S.settings.language || 'en', key, vars);

// ------------------------------------------------------------------ helpers
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function linkify(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'"]/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out.push(esc(text.slice(last, m.index)));
    out.push(`<a href="#" data-url="${esc(m[0])}">${esc(m[0])}</a>`);
    last = m.index + m[0].length;
  }
  out.push(esc(text.slice(last)));
  return out.join('');
}

function cleanError(err) {
  return String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function hashColor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const palette = [
    ['#4f63f5', '#7c5cf6'], ['#0ea5e9', '#2563eb'], ['#10b981', '#059669'], ['#f59e0b', '#ea580c'],
    ['#ef4444', '#db2777'], ['#8b5cf6', '#6d28d9'], ['#14b8a6', '#0d9488'], ['#f43f5e', '#e11d48'],
    ['#6366f1', '#0ea5e9'], ['#84cc16', '#16a34a'],
  ];
  const [a, b] = palette[h % palette.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!parts.length) return '?';
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return esc(s.toUpperCase());
}

const ICON_GROUP = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2c1.8.6 3 2.2 3.5 4.8"/></svg>';
const ICON_ALL = '<svg viewBox="0 0 24 24"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICONS = {
  reply: '<svg class="ico" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  smile: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/></svg>',
  more: '<svg class="ico" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
  pin: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 17v5M5 17h14l-2-4V6a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v7z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  clock: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  close: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

function avatarHtml(kind, id, name, status, size = '') {
  const bg = kind === 'broadcast' ? 'linear-gradient(135deg,#f59e0b,#ef4444)' : hashColor(id);
  const pic = kind === 'direct' && S.avatars.get(id);
  let inner;
  if (pic) inner = `<img src="${pic}" alt="">`;
  else if (kind === 'group') inner = ICON_GROUP;
  else if (kind === 'broadcast') inner = ICON_ALL;
  else inner = initials(name);
  const dot = status ? `<span class="dot ${status}"></span>` : '';
  return `<div class="avatar ${size}" style="background:${bg}">${inner}${dot}</div>`;
}

function statusText(s) {
  return { online: t('Available'), away: t('Away'), busy: t('Busy'), offline: t('Offline') }[s] || s;
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function locale() {
  return S.settings.language === 'mn' ? 'mn-MN' : undefined;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (dayKey(ts) === dayKey(today)) return t('Today');
  if (dayKey(ts) === dayKey(Date.now() - 864e5)) return t('Yesterday');
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(locale(), opts);
}

function fmtListTime(ts) {
  if (!ts) return '';
  if (dayKey(ts) === dayKey(Date.now())) return fmtTime(ts);
  if (Date.now() - ts < 6 * 864e5) return new Date(ts).toLocaleDateString(locale(), { weekday: 'short' });
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

function fmtWhen(ts) {
  return new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtAgo(ts) {
  if (!ts) return t('never seen');
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return t('last seen just now');
  if (m < 60) return t('last seen {n} min ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('last seen {n} h ago', { n: h });
  return t('last seen {date}', { date: new Date(ts).toLocaleDateString(locale()) });
}

const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;

// Plays the element's closing animation (the .leaving class), then removes it.
function leave(node, ms = 170) {
  if (!node || node.classList.contains('leaving')) return;
  node.classList.add('leaving');
  setTimeout(() => node.remove(), ms);
}

// Restarts a one-off entrance animation class on an element that stays in place.
function replayAnim(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

function toast(text, type = '') {
  const tEl = el('div', `toast ${type}`, esc(text));
  $('#toasts').append(tEl);
  setTimeout(() => leave(tEl, 200), type === 'error' ? 5000 : 2800);
}

async function call(promise) {
  try {
    return await promise;
  } catch (err) {
    toast(cleanError(err), 'error');
    return undefined;
  }
}

function msgPreview(m) {
  if (!m) return '';
  if (m.deleted) return t('This message was deleted');
  if (m.kind === 'call') return `📞 ${callText(m.call)}`;
  if (m.kind === 'game') return `🎮 ${t('Game')}`;
  if (m.kind === 'poll') return `📊 ${m.poll.question}`;
  if (m.kind === 'file') {
    if (m.file.voice) return `🎤 ${t('Voice message')}`;
    return `${m.file.folder ? '📁' : '📎'} ${m.file.name}`;
  }
  return m.text.replace(/\s+/g, ' ').slice(0, 140);
}

// ------------------------------------------------------------------ theme & language
const STYLES = [
  ['indigo', 'Indigo'], ['fluent', 'Office'], ['ocean', 'Ocean'],
  ['graphite', 'Minimal'], ['safety', 'Mine Site'], ['emerald', 'Emerald'],
];

function applyTheme() {
  const th = S.settings.theme || 'system';
  const dark = th === 'dark' || (th === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  const theme = dark ? 'dark' : 'light';
  const style = STYLES.some(([k]) => k === S.settings.style) ? S.settings.style : 'indigo';
  if (root.dataset.theme && (root.dataset.theme !== theme || root.dataset.style !== style)) {
    // Blend the colours over instead of switching in one jump.
    root.classList.add('theme-anim');
    clearTimeout(applyTheme.timer);
    applyTheme.timer = setTimeout(() => root.classList.remove('theme-anim'), 450);
  }
  root.dataset.theme = theme;
  root.dataset.style = style;
  syncTitleBar();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Windows draws the minimise/maximise/close buttons itself, in a colour we
// give it. When a dark backdrop covers the app (dialogs, games, image view),
// that corner gets the same tint, so it does not look cut out.
function parseColor(c) {
  const s = String(c).trim();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

// The app's own colour right where Windows draws its buttons.
function colorUnderButtons() {
  for (const e of document.elementsFromPoint(innerWidth - 70, 20)) {
    if (e.closest('.modal-back, .lightbox, .editor-back')) continue;
    const c = parseColor(getComputedStyle(e).backgroundColor);
    if (c && c[3] > 0.9) return c;
  }
  return null;
}

function syncTitleBar() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  let bar = colorUnderButtons() || parseColor(v('--panel'));
  let sym = parseColor(v('--text'));
  if (!bar || !sym) return;
  for (const back of document.querySelectorAll('.modal-back:not(.leaving), .lightbox:not(.leaving), .editor-back')) {
    const o = parseColor(getComputedStyle(back).backgroundColor);
    if (!o || !o[3]) continue;
    const mix = (c) => c.map((x, i) => (i < 3 ? x * (1 - o[3]) + o[i] * o[3] : 1));
    bar = mix(bar);
    // Keep the buttons readable on the darker background.
    sym = o[3] > 0.6 ? [235, 238, 245, 1] : mix(sym);
  }
  const hex = (c) => `#${c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
  const key = hex(bar) + hex(sym);
  if (key === syncTitleBar.last) return;
  syncTitleBar.last = key;
  api.setTitleBar(hex(bar), hex(sym), v('--bg'));
}

// Follow dialogs opening and closing.
let titleBarQueued = false;
new MutationObserver(() => {
  if (titleBarQueued) return;
  titleBarQueued = true;
  requestAnimationFrame(() => { titleBarQueued = false; syncTitleBar(); });
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

// Static text in index.html carries data-i18n / data-i18n-title / data-i18n-ph.
function applyLanguage() {
  document.documentElement.lang = S.settings.language || 'en';
  for (const e of document.querySelectorAll('[data-i18n]')) e.innerHTML = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll('[data-i18n-ph]')) e.placeholder = t(e.dataset.i18nPh);
}

function rerenderAll() {
  applyLanguage();
  renderMe();
  renderList();
  renderUpdateBanner();
  if (S.active) {
    renderHeader();
    renderMessages(false);
    renderComposerState();
  }
  Share.render();
}

// ------------------------------------------------------------------ conversation helpers
function convKind(conv) {
  if (conv === 'broadcast') return 'broadcast';
  if (conv.startsWith('g:')) return 'group';
  return 'direct';
}

function convName(conv) {
  const kind = convKind(conv);
  if (kind === 'broadcast') return t('Everyone');
  if (kind === 'group') return S.groups.get(conv.slice(2))?.name || t('Group');
  return S.peers.get(conv)?.name || t('Unknown');
}

function convRecipients(conv) {
  const kind = convKind(conv);
  if (kind === 'direct') return [conv];
  if (kind === 'group') return (S.groups.get(conv.slice(2))?.members || []).filter((m) => m !== S.me.id);
  return [...S.peers.keys()];
}

function onlineCount() {
  let n = 0;
  for (const p of S.peers.values()) if (p.online) n++;
  return n;
}

function peerName(id) {
  if (id === S.me.id) return t('You');
  return S.peers.get(id)?.name || t('Someone');
}

function findMsg(conv, id) {
  return (S.msgs.get(conv) || []).find((m) => m.id === id);
}

// ------------------------------------------------------------------ sidebar
function renderMe() {
  const me = S.me;
  $('#me').innerHTML = `
    ${avatarHtml('direct', me.id, me.name, me.status)}
    <div class="who">
      <div class="name">${esc(me.name)}</div>
      <div class="sub"><span class="sdot ${me.status}"></span>${statusText(me.status)}${me.dept ? ` · ${esc(me.dept)}` : ''}</div>
    </div>
    <svg class="ico chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`;
}

function renderNet() {
  const n = onlineCount();
  $('#netInfo').innerHTML = `<span class="pulse"></span>${n === 0 ? t('Looking for people…') : esc(t('Online now: {n}', { n }))}`;
}

function renderUpdateBanner() {
  const b = $('#updateBanner');
  if (!S.updateReady) {
    b.classList.add('hidden');
    return;
  }
  b.classList.remove('hidden');
  b.innerHTML = `<div><b>${esc(t('Update ready'))}</b><span>${esc(t('Version {v} was received from your network', { v: S.updateReady }))}</span></div>
    <button class="btn primary" id="btnRestart">${esc(t('Restart'))}</button>`;
  $('#btnRestart').onclick = () => api.restartUpdate();
}

let listRaf = 0;
function renderList() {
  cancelAnimationFrame(listRaf);
  listRaf = requestAnimationFrame(renderListNow);
}

function renderListNow() {
  const f = S.filter.toLowerCase();
  const items = [];
  const match = (...parts) => !f || parts.some((p) => String(p || '').toLowerCase().includes(f));

  const bc = S.convs.get('broadcast');
  if (match('everyone', 'broadcast', t('Everyone'))) {
    items.push({ conv: 'broadcast', kind: 'broadcast', name: t('Everyone'), meta: bc, online: true, pinned: true });
  }
  for (const g of S.groups.values()) {
    const conv = `g:${g.id}`;
    if (match(g.name)) items.push({ conv, kind: 'group', name: g.name, meta: S.convs.get(conv), online: true, members: g.members });
  }
  for (const p of S.peers.values()) {
    if (match(p.name, p.dept, p.host)) items.push({ conv: p.id, kind: 'direct', name: p.name, meta: S.convs.get(p.id), online: p.online, peer: p });
  }

  const recent = items.filter((i) => !i.pinned && i.meta && i.meta.lastTs).sort((a, b) => b.meta.lastTs - a.meta.lastTs);
  const others = items.filter((i) => !i.pinned && !(i.meta && i.meta.lastTs))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));

  const list = $('#convList');
  list.innerHTML = '';
  const pinned = items.find((i) => i.pinned);
  if (pinned) list.append(convItem(pinned));
  if (recent.length) {
    list.append(el('div', 'list-label', esc(t('Recent chats'))));
    for (const i of recent) list.append(convItem(i));
  }
  if (others.length) {
    list.append(el('div', 'list-label', esc(recent.length ? t('People') : t('People on your network'))));
    for (const i of others) list.append(convItem(i));
  }
  if (!items.length) {
    list.append(el('div', 'empty-note', f
      ? esc(t('Nobody matches your search.'))
      : `${esc(t('Nobody here yet.'))}<br>${esc(t('Other PCs running LAN Messenger 2 will appear automatically.'))}`));
  }
  renderNet();
  updateBadge();
}

function convItem(i) {
  const b = el('button', `conv${i.conv === S.active ? ' active' : ''}${i.kind === 'direct' && !i.online ? ' offline' : ''}${i.meta?.unread ? ' unread' : ''}`);
  b.dataset.conv = i.conv;
  let prev = '';
  const typing = S.typing.get(i.conv);
  if (typing && typing.size) {
    prev = `<span style="color:var(--accent-text)">${esc(t('typing…'))}</span>`;
  } else if (i.meta && i.meta.lastText) {
    let text = i.meta.lastText;
    if (text === '🚫') text = t('This message was deleted');
    else if (text === '📞') text = `📞 ${t('Call')}`;
    else if (text === '📵') text = `📵 ${t('Missed call')}`;
    else if (text === '🎮') text = `🎮 ${t('Game')}`;
    else if (text === '🎤') text = `🎤 ${t('Voice message')}`;
    const who = i.meta.lastFrom === S.me.id ? `${t('You')}: ` : (i.kind !== 'direct' && i.meta.lastFrom ? `${peerName(i.meta.lastFrom).split(' ')[0]}: ` : '');
    prev = esc(who + text);
  } else if (i.kind === 'broadcast') {
    const n = onlineCount();
    prev = esc(n ? t('Message all {n} online', { n }) : t('Message everyone on the network'));
  } else if (i.kind === 'group') {
    prev = esc(t('{n} members', { n: i.members.length }));
  } else {
    const p = i.peer;
    prev = p.online ? esc(`${statusText(p.status)}${p.dept ? ` · ${p.dept}` : ''}`) : esc(fmtAgo(p.lastSeen));
  }
  const status = i.kind === 'direct' ? (i.online ? i.peer.status : 'offline') : null;
  b.innerHTML = `
    ${avatarHtml(i.kind, i.conv, i.name, status)}
    <div class="body">
      <div class="row"><span class="title">${esc(i.name)}</span><span class="time">${fmtListTime(i.meta?.lastTs)}</span></div>
      <div class="row"><span class="preview">${prev}</span>${i.meta?.unread ? `<span class="badge">${i.meta.unread > 99 ? '99+' : i.meta.unread}</span>` : ''}</div>
    </div>`;
  b.addEventListener('click', () => openConv(i.conv));
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    convMenu(i, e.clientX, e.clientY);
  });
  // Files and folders dropped on a person or group are sent to them directly.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  b.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    b.classList.add('drop-target');
  });
  b.addEventListener('dragleave', () => b.classList.remove('drop-target'));
  b.addEventListener('drop', async (e) => {
    e.preventDefault();
    b.classList.remove('drop-target');
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const sent = await call(api.sendFiles(i.conv, paths));
    if (sent && sent.length) toast(t('Sent {n} item(s) to {name}', { n: sent.length, name: i.name }));
  });
  return b;
}

function convMenu(i, x, y) {
  const items = [{ label: t('Open chat'), action: () => openConv(i.conv) }];
  items.push({ label: t('Export chat…'), action: () => exportModal(i.conv) });
  items.push('-');
  items.push({ label: t('Clear chat history'), danger: true, action: () => confirmClear(i.conv) });
  if (i.kind === 'group') items.push({ label: t('Leave group'), danger: true, action: () => confirmLeave(i.conv.slice(2)) });
  if (i.kind === 'direct' && !i.online) {
    items.push({
      label: t('Remove from list'), danger: true, action: async () => {
        await call(api.forgetContact(i.conv));
        if (S.active === i.conv) closeConv();
      },
    });
  }
  showMenu(items, x, y);
}

let badgeLast = -1;
function updateBadge() {
  let n = 0;
  for (const c of S.convs.values()) n += c.unread || 0;
  if (n === badgeLast) return;
  badgeLast = n;
  let url = null;
  if (n) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const g = cv.getContext('2d');
    g.fillStyle = '#e5484d';
    g.beginPath();
    g.arc(16, 16, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = `bold ${n > 9 ? 17 : 20}px Segoe UI, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(n > 99 ? '99+' : String(n), 16, 17);
    url = cv.toDataURL();
  }
  api.setBadge(n, url);
  document.title = n ? `(${n}) LAN Messenger 2` : 'LAN Messenger 2';
}

// ------------------------------------------------------------------ chat view
async function openConv(conv) {
  hidePopover();
  if (S.active !== conv) {
    cancelReply();
    cancelEdit();
  }
  S.active = conv;
  api.setActiveConv(conv);
  $('#welcome').classList.add('hidden');
  if (!S.msgs.has(conv)) {
    const list = await api.loadMessages(conv, { limit: PAGE });
    S.msgs.set(conv, list);
    S.hasMore.set(conv, list.length >= PAGE);
  }
  if (S.active !== conv) return;
  const switched = $('#messages').dataset.conv !== conv;
  $('#messages').dataset.conv = conv;
  renderHeader();
  renderMessages(true);
  if (switched) replayAnim($('#messages'), 'conv-enter');
  renderComposerState();
  renderList();
  markReadIfVisible();
  $('#input').focus();
}

function closeConv() {
  S.active = null;
  $('#messages').dataset.conv = '';
  api.setActiveConv(null);
  $('#welcome').classList.remove('hidden');
  renderList();
}

function markReadIfVisible() {
  if (!S.active || !document.hasFocus()) return;
  const c = S.convs.get(S.active);
  const list = S.msgs.get(S.active) || [];
  if ((c && c.unread) || list.some((m) => m.from !== S.me.id && m.read === false)) {
    api.markRead(S.active);
    for (const m of list) if (m.from !== S.me.id) m.read = true;
  }
}

function renderHeader() {
  const conv = S.active;
  if (!conv) return;
  const kind = convKind(conv);
  const h = $('#chatHeader');
  let sub = '';
  let status = null;
  const typing = S.typing.get(conv);
  const typingNames = typing ? [...typing.keys()].map((id) => peerName(id).split(' ')[0]) : [];
  if (typingNames.length) {
    sub = `<div class="sub typing-now">${esc(t('{names} typing…', { names: typingNames.join(', ') }))}</div>`;
  } else if (kind === 'direct') {
    const p = S.peers.get(conv);
    status = p && p.online ? p.status : 'offline';
    const bits = [p && p.online ? statusText(p.status) : fmtAgo(p && p.lastSeen)];
    if (p && p.dept) bits.push(p.dept);
    if (p && p.host) bits.push(p.host);
    sub = `<div class="sub"><span class="sdot ${status}"></span>${esc(bits.join(' · '))}</div>`;
  } else if (kind === 'group') {
    const g = S.groups.get(conv.slice(2));
    const names = g ? g.members.map(peerName) : [];
    const on = g ? g.members.filter((m) => m === S.me.id || S.peers.get(m)?.online).length : 0;
    sub = `<div class="sub">${esc(t('{n} members, {on} online', { n: g ? g.members.length : 0, on }))} · ${esc(names.join(', '))}</div>`;
  } else {
    sub = `<div class="sub">${esc(t('Broadcast to everyone on the network'))} · ${esc(t('Online now: {n}', { n: onlineCount() }))}</div>`;
  }
  h.innerHTML = `
    ${avatarHtml(kind, conv, convName(conv), status === 'offline' ? null : status, 'lg')}
    <div class="who"><div class="title">${esc(convName(conv))}</div>${sub}</div>
    ${kind !== 'broadcast' ? `<button class="icon-btn" id="hdrVoice" title="${esc(t('Voice call'))}"><svg class="ico" viewBox="0 0 24 24"><path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg></button>
    <button class="icon-btn" id="hdrVideo" title="${esc(t('Video call'))}"><svg class="ico" viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg></button>` : ''}
    <button class="icon-btn" id="hdrShare" title="${esc(t('Share your screen'))}"><svg class="ico" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M12 13V8M9.5 10.5 12 8l2.5 2.5"/></svg></button>
    <button class="icon-btn" id="hdrAttach" title="${esc(t('Send files'))}"><svg class="ico" viewBox="0 0 24 24"><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4M12 3v12M7 8l5-5 5 5"/></svg></button>
    ${kind === 'group' ? `<button class="icon-btn" id="hdrAdd" title="${esc(t('Add people'))}"><svg class="ico" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5M18 8v6M15 11h6"/></svg></button>` : ''}
    <button class="icon-btn" id="hdrMore" title="${esc(t('More'))}"><svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg></button>`;
  $('#hdrShare').onclick = () => Share.start(conv);
  if ($('#hdrVoice')) $('#hdrVoice').onclick = () => call(api.callStart(conv, false));
  if ($('#hdrVideo')) $('#hdrVideo').onclick = () => call(api.callStart(conv, true));
  $('#hdrAttach').onclick = attachFiles;
  if ($('#hdrAdd')) $('#hdrAdd').onclick = () => groupMembersModal(conv.slice(2));
  $('#hdrMore').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items = [];
    if (kind === 'group') {
      items.push({ label: t('Add people…'), action: () => groupMembersModal(conv.slice(2)) });
      items.push({ label: t('Rename group…'), action: () => renameGroupModal(conv.slice(2)) });
    }
    items.push({ label: t('Pinned messages'), action: () => pinsModal(conv) });
    items.push({ label: t('Scheduled messages'), action: () => scheduledModal(conv) });
    items.push({ label: t('Find in messages…'), action: () => searchModal() });
    items.push({ label: t('Export chat…'), action: () => exportModal(conv) });
    items.push('-');
    items.push({ label: t('Clear chat history'), danger: true, action: () => confirmClear(conv) });
    if (kind === 'group') items.push({ label: t('Leave group'), danger: true, action: () => confirmLeave(conv.slice(2)) });
    showMenu(items, r.right - 230, r.bottom + 6);
  };
  renderPinBar();
}

function renderPinBar() {
  const bar = $('#pinBar');
  const pins = S.convs.get(S.active)?.pins || [];
  if (!S.active || !pins.length) {
    bar.classList.add('hidden');
    return;
  }
  const last = pins[pins.length - 1];
  const m = findMsg(S.active, last.id);
  bar.classList.remove('hidden');
  bar.innerHTML = `${ICONS.pin}<div class="pin-body"><b>${esc(pins.length > 1 ? t('{n} pinned messages', { n: pins.length }) : t('Pinned message'))}</b>
    <span>${esc(m ? msgPreview(m) : t('Message not loaded'))}</span></div>`;
  bar.onclick = () => (pins.length > 1 ? pinsModal(S.active) : jumpTo(S.active, last.id));
}

function renderComposerState() {
  const conv = S.active;
  const hint = $('#offlineHint');
  hint.textContent = '';
  if (!conv) return;
  const kind = convKind(conv);
  if (kind === 'direct') {
    const p = S.peers.get(conv);
    if (p && !p.online) hint.textContent = t('{name} is offline. Messages will be delivered automatically when they come back online.', { name: p.name });
    else if (p && p.status === 'busy') hint.textContent = t('{name} is busy and may not reply right away.', { name: p.name });
  } else if (kind === 'broadcast') {
    hint.textContent = t('Messages here go to everyone on the network.');
  }
  $('#input').placeholder = kind === 'broadcast' ? t('Message everyone…') : t('Message {name}…', { name: convName(conv) });
  renderScheduledStrip();
  renderComposeBar();
}

function renderScheduledStrip() {
  const strip = $('#schedStrip');
  const n = S.scheduled.filter((s) => s.conv === S.active).length;
  if (!S.active || !n) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');
  strip.innerHTML = `${ICONS.clock}<span>${esc(t('Scheduled messages: {n}', { n }))}</span>`;
  strip.onclick = () => scheduledModal(S.active);
}

function isAtBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

function renderMessages(scrollToEnd, keepOffset) {
  const box = $('#messages');
  const list = S.msgs.get(S.active) || [];
  const atBottom = isAtBottom(box);
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;
  const inner = el('div', 'inner');
  if (S.hasMore.get(S.active)) inner.append(el('div', 'system', `<span>${esc(t('Scroll up to load older messages'))}</span>`));
  if (!list.length) {
    inner.append(el('div', 'empty-note', esc(convKind(S.active) === 'broadcast'
      ? t('Send an announcement to everyone on the network.')
      : t('No messages yet. Say hello! 👋'))));
  }
  let lastDay = null;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const d = dayKey(m.ts);
    if (d !== lastDay) {
      lastDay = d;
      inner.append(el('div', 'day', `<span>${esc(fmtDay(m.ts))}</span>`));
    }
    inner.append(msgNode(list, i));
  }
  box.innerHTML = '';
  box.append(inner);
  if (scrollToEnd || atBottom) box.scrollTop = box.scrollHeight;
  else if (keepOffset) box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  else box.scrollTop = prevTop;
}

function isCont(list, i) {
  if (i === 0) return false;
  const a = list[i - 1];
  const b = list[i];
  return a.kind !== 'system' && b.kind !== 'system' && a.kind !== 'call' && b.kind !== 'call' && !a.urgent && !b.urgent && a.from === b.from
    && b.ts - a.ts < 5 * 60000 && dayKey(a.ts) === dayKey(b.ts);
}

function ticks(m) {
  const one = '<path d="M5 12.5l4 4L19 7"/>';
  const two = '<path d="M2.5 12.5l4 4L16 7"/><path d="M10.5 15.5l1 1L21 7"/>';
  if (m.status === 'queued') return `<svg class="tick" viewBox="0 0 24 24"><title>${esc(t('Waiting to be delivered'))}</title><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>`;
  if (m.status === 'partial') return `<svg class="tick" viewBox="0 0 24 24"><title>${esc(t('Delivered to some people'))}</title>${one}</svg>`;
  if (m.status === 'delivered') return `<svg class="tick" viewBox="0 0 24 24"><title>${esc(t('Delivered'))}</title>${two}</svg>`;
  if (m.status === 'read') return `<svg class="tick read" viewBox="0 0 24 24"><title>${esc(t('Read'))}</title>${two}</svg>`;
  return '';
}

function isJumbo(text) {
  const s = (text || '').trim();
  if (!s || s.length > 16) return false;
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(s) && /\p{Extended_Pictographic}/u.test(s);
}

function senderColor(id) {
  const g = hashColor(id).match(/#[0-9a-f]{6}/i);
  return g ? g[0] : 'inherit';
}

function msgNode(list, i) {
  const m = list[i];
  if (m.kind === 'system') {
    const s = el('div', 'system', `<span>${esc(m.text)}</span>`);
    s.dataset.id = m.id;
    return s;
  }
  if (m.kind === 'call') return callNode(m);
  const out = m.from === S.me.id;
  const cont = isCont(list, i);
  const kind = convKind(S.active);
  const showSender = !out && kind !== 'direct' && !cont;
  const row = el('div', `msg ${out ? 'out' : 'in'}${cont ? ' cont' : ''}`);
  row.dataset.id = m.id;

  if (!out && kind !== 'direct') {
    const next = list[i + 1];
    const lastOfRun = !next || !isCont(list, i + 1);
    if (lastOfRun) row.insertAdjacentHTML('beforeend', avatarHtml('direct', m.from, m.fromName, null, 'sm'));
    else row.append(el('div', 'spacer'));
  }

  const jumbo = m.kind === 'text' && !m.deleted && !m.urgent && !m.replyTo && isJumbo(m.text);
  const bubble = el('div', `bubble${jumbo ? ' jumbo' : ''}${m.urgent ? ' urgent' : ''}${m.kind === 'poll' ? ' poll-bubble' : ''}${m.kind === 'game' ? ' game-bubble' : ''}`);
  let html = '';
  if (showSender) html += `<div class="sender" style="color:${senderColor(m.from)}">${esc(m.fromName || peerName(m.from))}</div>`;
  if (m.replyTo && !m.deleted) {
    html += `<div class="quote" data-act="jump" data-id="${esc(m.replyTo.id)}"><b>${esc(m.replyTo.from === S.me.id ? t('You') : m.replyTo.fromName)}</b><span>${esc(m.replyTo.preview === '🎤' ? `🎤 ${t('Voice message')}` : m.replyTo.preview)}</span></div>`;
  }
  if (m.deleted) {
    html += `<div class="text deleted">🚫 ${esc(t('This message was deleted'))}</div>`;
  } else if (m.urgent) {
    html += urgentHtml(m, out);
  } else if (m.kind === 'poll') {
    html += pollHtml(m);
  } else if (m.kind === 'game') {
    html += Game.cardHtml(m);
  } else if (m.kind === 'file') {
    html += m.file.voice ? Voice.bubbleHtml(m, out) : fileHtml(m, out);
  } else {
    html += `<div class="text">${linkify(m.text)}</div>`;
  }
  const edited = m.edited && !m.deleted ? `<span class="edited">${esc(t('edited'))}</span>` : '';
  html += `<span class="meta">${edited}${fmtTime(m.ts)}${out && !m.deleted ? ticks(m) : ''}</span>`;
  bubble.innerHTML = html;

  const reacts = Object.entries(m.reactions || {}).filter(([, ids]) => ids.length);
  if (reacts.length && !m.deleted) {
    const r = el('div', 'reacts');
    for (const [emoji, ids] of reacts) {
      const mine = ids.includes(S.me.id);
      const chip = el('button', `react-chip${mine ? ' mine' : ''}`, `<span class="e">${esc(emoji)}</span>${ids.length > 1 ? `<span>${ids.length}</span>` : ''}`);
      chip.title = ids.map(peerName).join(', ');
      chip.dataset.act = 'react';
      chip.dataset.e = emoji;
      r.append(chip);
    }
    bubble.append(r);
  }

  const wrap = el('div', 'bwrap');
  wrap.append(bubble);
  if (!m.deleted) {
    const actions = el('div', 'msg-actions', `
      <button data-act="quick-react" title="${esc(t('React'))}">${ICONS.smile}</button>
      <button data-act="reply" title="${esc(t('Reply'))}">${ICONS.reply}</button>
      <button data-act="menu" title="${esc(t('More'))}">${ICONS.more}</button>`);
    wrap.append(actions);
  }
  row.append(wrap);

  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    msgMenu(m, e.clientX, e.clientY);
  });
  wrap.addEventListener('click', (e) => onBubbleClick(e, m));
  if (m.kind === 'file' && !m.file.voice) loadThumb(row, m);
  return row;
}

function callText(c) {
  if (c.outgoing) {
    if (!c.duration) return c.video ? t('Video call – no answer') : t('Voice call – no answer');
    return c.video ? t('Outgoing video call') : t('Outgoing voice call');
  }
  if (c.declined) return c.video ? t('Declined video call') : t('Declined voice call');
  if (c.missed) return c.video ? t('Missed video call') : t('Missed voice call');
  return c.video ? t('Incoming video call') : t('Incoming voice call');
}

function callNode(m) {
  const c = m.call;
  const bad = c.missed || (c.outgoing && !c.duration);
  const node = el('div', `call-log${bad ? ' missed' : ''}`, `
    <span class="cl-icon">${c.video ? '🎥' : '📞'}</span>
    <span class="cl-text"><b>${esc(callText(c))}</b><span>${esc(fmtTime(m.ts))}${c.duration ? ` · ${esc(fmtDuration(c.duration))}` : ''}</span></span>
    ${convKind(S.active) !== 'broadcast' ? `<button class="fbtn ghost" data-call="${c.video ? 1 : 0}">${esc(t('Call back'))}</button>` : ''}`);
  node.dataset.id = m.id;
  const btn = node.querySelector('[data-call]');
  if (btn) btn.onclick = () => call(api.callStart(S.active, btn.dataset.call === '1'));
  return node;
}

function urgentHtml(m, out) {
  let footer;
  if (out) {
    const total = (m.recipients || []).length;
    const acks = (m.acks || []).length;
    footer = `<button class="ack-summary" data-act="ack-info">✔ ${esc(t('Acknowledged by {a} of {n}', { a: acks, n: total }))}</button>`;
  } else if (m.acked) {
    footer = `<div class="ack-done">✔ ${esc(t('You acknowledged this alert'))}</div>`;
  } else {
    footer = `<button class="fbtn ack-btn" data-act="ack">${esc(t('Acknowledge'))}</button>`;
  }
  return `<div class="urgent-tag">🚨 ${esc(t('URGENT'))}</div><div class="text">${linkify(m.text)}</div>${footer}`;
}

function pollHtml(m) {
  const p = m.poll;
  const votes = p.votes || {};
  const voters = Object.keys(votes);
  const mine = votes[S.me.id] || [];
  const counts = p.options.map((_, i) => voters.filter((v) => votes[v].includes(i)).length);
  const max = Math.max(1, ...counts);
  const opts = p.options.map((o, i) => {
    const names = voters.filter((v) => votes[v].includes(i)).map(peerName).join(', ');
    return `<button class="poll-opt${mine.includes(i) ? ' mine' : ''}" data-act="vote" data-i="${i}" title="${esc(names)}">
      <span class="poll-fill" style="width:${(counts[i] / max) * 100}%"></span>
      <span class="poll-check">${mine.includes(i) ? '✓' : ''}</span>
      <span class="poll-label">${esc(o)}</span><span class="poll-count">${counts[i] || ''}</span></button>`;
  }).join('');
  return `<div class="poll-q">📊 ${esc(p.question)}</div>
    <div class="poll-sub">${esc(p.multi ? t('Choose one or more') : t('Choose one'))}</div>
    <div class="poll-opts">${opts}</div>
    <div class="poll-sub">${esc(t('Votes: {n}', { n: voters.length }))}</div>`;
}

function extLabel(name) {
  const ext = (name.split('.').pop() || '').slice(0, 4).toUpperCase();
  return ext && ext !== name.toUpperCase() ? ext : 'FILE';
}

function fileHtml(m, out) {
  const f = m.file;
  const prog = S.progress.get(m.id);
  let sub = f.folder ? t('{n} files · {size}', { n: f.count, size: fmtSize(f.size) }) : fmtSize(f.size);
  let bar = '';
  let btns = '';
  let err = '';
  const isImg = !f.folder && IMAGE_RE.test(f.name);
  const openLabel = f.folder ? t('Open folder') : t('Open');

  if (out) {
    if (prog && prog.upload && prog.done < prog.size) {
      sub = t('Sending… {done} of {size}', { done: fmtSize(prog.done), size: fmtSize(f.size) });
      bar = `<div class="progress"><div style="width:${(prog.done / Math.max(1, f.size)) * 100}%"></div></div>`;
    }
    btns = `<button class="fbtn ghost" data-act="open">${esc(openLabel)}</button><button class="fbtn ghost" data-act="folder">${esc(t('Show in folder'))}</button>`;
  } else if (f.state === 'downloading') {
    const p = prog || { done: 0, size: f.size, speed: 0 };
    sub = `${fmtSize(p.done)} / ${fmtSize(f.size)}${p.speed ? ` · ${fmtSize(p.speed)}/s` : ''}`;
    bar = `<div class="progress"><div style="width:${(p.done / Math.max(1, f.size)) * 100}%"></div></div>`;
    btns = `<button class="fbtn ghost" data-act="cancel">${esc(t('Cancel'))}</button>`;
  } else if (f.state === 'done') {
    btns = `<button class="fbtn" data-act="open">${esc(openLabel)}</button><button class="fbtn ghost" data-act="folder">${esc(t('Show in folder'))}</button>`;
  } else if (f.state === 'failed') {
    err = `<div class="ferr">${esc(f.error || t('Download failed'))}</div>`;
    btns = `<button class="fbtn" data-act="download">${esc(t('Retry'))}</button>`;
  } else {
    btns = `<button class="fbtn" data-act="download">${esc(t('Download'))}</button>`;
  }
  const thumb = isImg && f.path && (out || f.state === 'done') ? `<div class="thumb" data-act="view" data-path="${esc(f.path)}"></div>` : '';
  const icon = f.folder ? '<svg class="ico" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' : esc(extLabel(f.name));
  return `${thumb}<div class="file">
      <div class="ficon">${icon}</div>
      <div class="finfo"><div class="fname" title="${esc(f.name)}">${esc(f.name)}</div><div class="fsub">${esc(sub)}</div>${bar}${err}</div>
    </div><div class="fbtns">${btns}</div>`;
}

async function loadThumb(row, m) {
  const th = row.querySelector('.thumb');
  if (!th) return;
  const p = th.dataset.path;
  let info = S.thumbs.get(p);
  if (!info) {
    info = await api.thumb(p);
    if (!info) return th.remove();
    S.thumbs.set(p, info);
  }
  const box = $('#messages');
  const stick = isAtBottom(box);
  const img = new Image();
  img.alt = m.file.name;
  img.onload = () => { if (stick) box.scrollTop = box.scrollHeight; };
  img.src = info.url;
  th.append(img);
}

async function onBubbleClick(e, m) {
  const a = e.target.closest('a[data-url]');
  if (a) {
    e.preventDefault();
    api.openExternal(a.dataset.url);
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const conv = S.active;
  const act = btn.dataset.act;
  if (act === 'download') call(api.acceptFile(conv, m.id));
  else if (act === 'cancel') call(api.cancelFile(conv, m.id));
  else if (act === 'open') {
    const err = await api.openFile(m.file.path);
    if (err) toast(err, 'error');
  } else if (act === 'folder') api.showInFolder(m.file.path);
  else if (act === 'view') lightbox(btn.dataset.path);
  else if (act === 'jump') jumpTo(conv, btn.dataset.id);
  else if (act === 'react') call(api.react(conv, m.id, btn.dataset.e));
  else if (act === 'quick-react') quickReact(m, btn);
  else if (act === 'reply') startReply(m);
  else if (act === 'menu') {
    const r = btn.getBoundingClientRect();
    msgMenu(m, r.left, r.bottom + 4);
  } else if (act === 'vote') vote(m, Number(btn.dataset.i));
  else if (act === 'ack') call(api.ackUrgent(conv, m.id));
  else if (act === 'game') Game.show(conv, m.id);
  else if (act === 'ack-info') ackInfo(m);
  else if (act === 'play') Voice.toggle(m);
  else if (act === 'seek') Voice.seek(m, e, btn);
}

function vote(m, i) {
  const p = m.poll;
  const mine = (p.votes || {})[S.me.id] || [];
  let next;
  if (p.multi) next = mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i];
  else next = mine.includes(i) ? [] : [i];
  call(api.vote(S.active, m.id, next));
}

function ackInfo(m) {
  const acked = (m.acks || []).map(peerName);
  const waiting = (m.recipients || []).filter((id) => !(m.acks || []).includes(id)).map(peerName);
  infoModal(t('Urgent alert'), `
    <div class="kv"><div>${esc(t('Sent'))}</div><div>${esc(fmtWhen(m.ts))}</div>
    <div>${esc(t('Acknowledged'))}</div><div>${esc(acked.join(', ') || '—')}</div>
    <div>${esc(t('Not yet'))}</div><div>${esc(waiting.join(', ') || '—')}</div></div>`);
}

function quickReact(m, anchor) {
  const r = anchor.getBoundingClientRect();
  const pop = $('#popover');
  pop.className = 'popover react-pop';
  pop.innerHTML = `${QUICK_REACTIONS.map((e) => `<button data-e="${e}">${e}</button>`).join('')}<button data-more="1" title="${esc(t('More'))}">＋</button>`;
  pop.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    hidePopover();
    if (b.dataset.more) emojiPicker(r, (emoji) => call(api.react(S.active, m.id, emoji)));
    else call(api.react(S.active, m.id, b.dataset.e));
  };
  pop.classList.remove('hidden');
  pop.style.left = `${Math.max(8, Math.min(r.left - 100, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.top - pop.offsetHeight - 6}px`;
}

function lightbox(p) {
  const info = S.thumbs.get(p);
  if (!info) return;
  const lb = el('div', 'lightbox', `<img src="${info.url}">`);
  lb.addEventListener('click', () => leave(lb));
  lb.addEventListener('dblclick', () => api.openFile(p));
  document.body.append(lb);
}

function msgMenu(m, x, y) {
  const items = [];
  const conv = S.active;
  const mine = m.from === S.me.id;
  const sel = String(window.getSelection() || '');
  if (!m.deleted) {
    items.push({ label: t('Reply'), action: () => startReply(m) });
    items.push({ label: t('React…'), action: () => emojiPicker({ left: x, right: x, top: y, bottom: y }, (e) => call(api.react(conv, m.id, e))) });
  }
  if (sel) items.push({ label: t('Copy selection'), action: () => api.copyText(sel) });
  if (m.kind === 'text' && !m.deleted) items.push({ label: t('Copy text'), action: () => api.copyText(m.text) });
  if (mine && m.kind === 'text' && !m.deleted && !m.urgent) items.push({ label: t('Edit'), action: () => startEdit(m) });
  if (!m.deleted) {
    const pinned = (S.convs.get(conv)?.pins || []).some((p) => p.id === m.id);
    items.push({ label: pinned ? t('Unpin') : t('Pin'), action: () => call(api.pinMessage(conv, m.id, !pinned)) });
  }
  if (m.kind === 'file' && m.file.path) {
    items.push({ label: m.file.folder ? t('Open folder') : t('Open file'), action: () => api.openFile(m.file.path) });
    items.push({ label: t('Show in folder'), action: () => api.showInFolder(m.file.path) });
  }
  if (m.kind === 'file' && IMAGE_RE.test(m.file.name) && m.file.path) {
    items.push({ label: t('Draw on picture…'), action: () => editImageFromPath(m.file.path) });
  }
  if (mine && m.recipients && m.recipients.length > 1) {
    const names = (ids) => ids.map(peerName).join(', ') || '—';
    items.push({
      label: t('Message info…'), action: () => infoModal(t('Message info'), `
        <div class="kv"><div>${esc(t('Sent'))}</div><div>${esc(fmtWhen(m.ts))}</div>
        <div>${esc(t('Delivered to'))}</div><div>${esc(names(m.deliveredTo || []))}</div>
        <div>${esc(t('Read by'))}</div><div>${esc(names(m.readBy || []))}</div></div>`),
    });
  }
  items.push('-');
  if (mine && !m.deleted) {
    items.push({
      label: t('Delete for everyone'), danger: true, action: () => confirmModal(
        t('Delete for everyone?'), t('The message will be removed from everyone\'s chat.'), t('Delete'),
        () => call(api.unsendMessage(conv, m.id)),
      ),
    });
  }
  items.push({
    label: t('Delete for me'), danger: true, action: async () => {
      await call(api.deleteMessage(conv, m.id));
      const list = S.msgs.get(conv) || [];
      const idx = list.findIndex((x) => x.id === m.id);
      if (idx >= 0) list.splice(idx, 1);
      renderMessages(false);
    },
  });
  showMenu(items, x, y);
}

function upsertMessage(conv, msg, isNew) {
  const list = S.msgs.get(conv);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx >= 0) list[idx] = msg;
  else if (isNew) {
    let i = list.length;
    while (i > 0 && list[i - 1].ts > msg.ts) i--;
    list.splice(i, 0, msg);
  } else return;
  if (conv !== S.active) return;
  if (idx >= 0) {
    const node = $(`#messages [data-id="${CSS.escape(msg.id)}"]`);
    if (node) node.replaceWith(msgNode(list, idx));
    if ((S.convs.get(conv)?.pins || []).some((p) => p.id === msg.id)) renderPinBar();
  } else {
    renderMessages(msg.from === S.me.id);
    if (isNew) $(`#messages [data-id="${CSS.escape(msg.id)}"]`)?.classList.add('msg-enter');
  }
}

function refreshMsgDom(conv, msgId) {
  if (conv !== S.active) return;
  const list = S.msgs.get(conv) || [];
  const idx = list.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  const node = $(`#messages [data-id="${CSS.escape(msgId)}"]`);
  if (node) node.replaceWith(msgNode(list, idx));
}

// ------------------------------------------------------------------ composer
function startReply(m) {
  cancelEdit();
  S.replyTo = m;
  renderComposeBar();
  $('#input').focus();
}

function cancelReply() {
  S.replyTo = null;
  renderComposeBar();
}

function startEdit(m) {
  cancelReply();
  S.editing = m;
  $('#input').value = m.text;
  autoGrow();
  renderComposeBar();
  $('#input').focus();
}

function cancelEdit() {
  if (S.editing) {
    S.editing = null;
    $('#input').value = '';
    autoGrow();
  }
  renderComposeBar();
}

function renderComposeBar() {
  const bar = $('#composeBar');
  const m = S.editing || S.replyTo;
  if (!m) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const title = S.editing ? t('Edit message') : t('Reply to {name}', { name: m.from === S.me.id ? t('yourself') : m.fromName });
  bar.innerHTML = `${S.editing ? '✏️' : ICONS.reply}<div class="cb-body"><b>${esc(title)}</b><span>${esc(msgPreview(m))}</span></div>
    <button class="icon-btn" title="${esc(t('Cancel'))}">${ICONS.close}</button>`;
  bar.querySelector('button').onclick = () => (S.editing ? cancelEdit() : cancelReply());
}

async function sendCurrent() {
  const input = $('#input');
  const text = input.value.trim();
  if (!S.active) return;
  if (S.editing) {
    if (!text) return;
    const m = S.editing;
    S.editing = null;
    input.value = '';
    autoGrow();
    renderComposeBar();
    if (text !== m.text) await call(api.editMessage(S.active, m.id, text));
    return;
  }
  if (!text) return;
  const opts = S.replyTo ? { replyTo: S.replyTo.id } : {};
  input.value = '';
  autoGrow();
  cancelReply();
  await call(api.sendText(S.active, text, opts));
}

function replyOpts() {
  const opts = S.replyTo ? { replyTo: S.replyTo.id } : {};
  cancelReply();
  return opts;
}

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
}

let lastTypingSent = 0;
function onInput() {
  autoGrow();
  if (!S.active || !$('#input').value || S.editing) return;
  const now = Date.now();
  if (now - lastTypingSent > 2500) {
    lastTypingSent = now;
    api.typing(S.active);
  }
}

async function attachFiles() {
  if (!S.active) return;
  await call(api.pickFiles(S.active, replyOpts()));
}

function plusMenu() {
  if (!S.active) return;
  const r = $('#btnPlus').getBoundingClientRect();
  const ic = (d) => `<svg class="ico" viewBox="0 0 24 24">${d}</svg>`;
  showMenu([
    { icon: ic('<path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/>'), label: t('Send files'), action: attachFiles },
    { icon: ic('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'), label: t('Send a folder'), action: () => call(api.pickSendFolder(S.active)) },
    { icon: ic('<path d="M6 3v12a3 3 0 0 0 3 3h12"/><path d="M3 6h12a3 3 0 0 1 3 3v12"/>'), label: t('Screenshot with drawing'), hint: 'Ctrl+Shift+S', action: screenshot },
    { icon: ic('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'), label: t('Share your screen'), action: () => Share.start(S.active) },
    { icon: ic('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'), label: t('Create a poll'), action: pollModal },
    ...(convKind(S.active) === 'direct' ? [{ icon: ic('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>'), label: t('Play a game'), action: () => Game.newGameModal(S.active) }] : []),
    { icon: ic('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'), label: t('Urgent alert'), danger: true, action: urgentModal },
    { icon: ICONS.clock, label: t('Schedule a message'), action: () => scheduleModal() },
  ], r.left, r.top - 370);
}

async function screenshot() {
  if (!S.active) return;
  const conv = S.active;
  const data = await call(api.captureScreen());
  if (!data) return;
  openEditor(data, { title: t('Draw on screenshot'), crop: true, onSend: (bytes) => call(api.sendImageData(conv, bytes, 'png', replyOpts())) });
}

async function editImageFromPath(p) {
  const conv = S.active;
  const data = await call(api.readImage(p));
  if (!data) return toast(t('This picture could not be opened'), 'error');
  openEditor(data, { title: t('Draw on picture'), onSend: (bytes) => call(api.sendImageData(conv, bytes, 'png')) });
}

function insertAtCursor(text) {
  const ta = $('#input');
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
  autoGrow();
}

function emojiPicker(anchor = $('#btnEmoji').getBoundingClientRect(), onPick = insertAtCursor) {
  const pop = $('#popover');
  pop.className = 'popover emoji-pop';
  const cats = Object.keys(EMOJI);
  let cur = cats[0];
  const draw = () => {
    pop.innerHTML = `<div class="emoji-tabs">${cats.map((c) => `<button data-cat="${c}" class="${c === cur ? 'on' : ''}">${esc(t(c))}</button>`).join('')}</div>
      <div class="emoji-grid">${EMOJI[cur].map((e) => `<button data-e="${e}">${e}</button>`).join('')}</div>`;
  };
  draw();
  pop.onclick = (e) => {
    const c = e.target.closest('[data-cat]');
    if (c) { cur = c.dataset.cat; draw(); return; }
    const b = e.target.closest('[data-e]');
    if (!b) return;
    onPick(b.dataset.e);
    if (onPick !== insertAtCursor) hidePopover();
  };
  pop.classList.remove('hidden');
  pop.style.left = `${Math.max(8, Math.min(anchor.right - 344, innerWidth - 352))}px`;
  pop.style.top = `${Math.max(8, anchor.top - 310)}px`;
}

// ------------------------------------------------------------------ popover menus
function showMenu(items, x, y) {
  const pop = $('#popover');
  pop.className = 'popover';
  pop.innerHTML = '';
  pop.onclick = null;
  for (const it of items) {
    if (it === '-') { pop.append(el('div', 'menu-sep')); continue; }
    const b = el('button', `menu-item${it.danger ? ' danger' : ''}`,
      `${it.icon || ''}<span>${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}${it.checked ? '<span class="check">✓</span>' : ''}`);
    b.addEventListener('click', () => { hidePopover(); it.action(); });
    pop.append(b);
  }
  pop.style.left = '0px';
  pop.style.top = '0px';
  pop.classList.remove('hidden');
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
}

function hidePopover() {
  const pop = $('#popover');
  if (!popoverOpen()) return;
  pop.classList.add('leaving');
  // Opening another menu resets the class list, which cancels this.
  setTimeout(() => { if (pop.classList.contains('leaving')) pop.classList.add('hidden'); }, 120);
}

function popoverOpen() {
  const pop = $('#popover');
  return !pop.classList.contains('hidden') && !pop.classList.contains('leaving');
}

document.addEventListener('mousedown', (e) => {
  const pop = $('#popover');
  if (popoverOpen() && !pop.contains(e.target) && !e.target.closest('#btnEmoji, #me, #hdrMore, #btnPlus, [data-act="quick-react"], [data-act="menu"]')) hidePopover();
});

function statusMenu() {
  const r = $('#me').getBoundingClientRect();
  const dot = (s) => `<span class="sdot ${s}"></span>`;
  showMenu([
    ...['online', 'away', 'busy'].map((s) => ({
      icon: dot(s), label: s === 'busy' ? t('Busy – mute notifications') : statusText(s), checked: S.me.status === s,
      action: async () => { S.me = await call(api.setProfile({ status: s })) || S.me; renderMe(); },
    })),
    '-',
    { label: t('Edit profile and settings…'), action: settingsModal },
  ], r.left, r.bottom + 4);
}

// ------------------------------------------------------------------ modals
function modal({ title, body, wide, cls = '', buttons = [], onOpen, onClose }) {
  const back = el('div', 'modal-back');
  const m = el('div', `modal${wide ? ' wide' : ''} ${cls}`);
  m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close title="${esc(t('Close'))}">${ICONS.close}</button></div>
    <div class="modal-body">${body}</div>${buttons.length ? '<div class="modal-foot"></div>' : ''}`;
  const close = () => {
    leave(back);
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  for (const b of buttons) {
    const btn = el('button', `btn ${b.cls || ''}`, esc(b.label));
    btn.addEventListener('click', async () => {
      if (b.action) {
        btn.disabled = true;
        const keep = await b.action(m);
        btn.disabled = false;
        if (keep === false) return;
      }
      close();
    });
    $('.modal-foot', m).append(btn);
  }
  m.querySelector('[data-close]').addEventListener('click', close);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.append(m);
  $('#modalRoot').append(back);
  if (onOpen) onOpen(m, close);
  const first = m.querySelector('input:not([type=checkbox]):not([type=radio]), textarea');
  if (first) first.focus();
  return { m, close };
}

function infoModal(title, html) {
  modal({ title, body: html, buttons: [{ label: t('Close'), cls: 'primary' }] });
}

function confirmModal(title, text, label, action) {
  modal({ title, body: `<p style="margin:0;color:var(--muted)">${esc(text)}</p>`, buttons: [{ label: t('Cancel') }, { label, cls: 'danger', action }] });
}

function confirmClear(conv) {
  confirmModal(t('Clear chat history?'), t('All messages with {name} will be removed from this PC. This cannot be undone.', { name: convName(conv) }), t('Clear history'), async () => {
    await call(api.clearConversation(conv));
    S.msgs.set(conv, []);
    S.hasMore.set(conv, false);
    if (S.active === conv) { renderMessages(true); renderPinBar(); }
  });
}

function confirmLeave(groupId) {
  const g = S.groups.get(groupId);
  confirmModal(t('Leave group?'), t('You will stop receiving messages from "{name}".', { name: g ? g.name : '' }), t('Leave group'), async () => {
    await call(api.leaveGroup(groupId));
    S.groups.delete(groupId);
    S.convs.delete(`g:${groupId}`);
    if (S.active === `g:${groupId}`) closeConv();
    renderList();
  });
}

function peopleChecklist(exclude = new Set()) {
  const peers = [...S.peers.values()].filter((p) => !exclude.has(p.id))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  if (!peers.length) return `<div class="empty-note">${esc(t('No one else is available to add yet.'))}</div>`;
  return `<div class="pick-list">${peers.map((p) => `
    <label class="pick">${avatarHtml('direct', p.id, p.name, p.online ? p.status : 'offline', 'sm')}
      <div class="pname"><div>${esc(p.name)}</div><div>${esc(p.online ? statusText(p.status) : t('Offline'))}${p.dept ? ` · ${esc(p.dept)}` : ''}</div></div>
      <input type="checkbox" value="${esc(p.id)}"></label>`).join('')}</div>`;
}

function newGroupModal() {
  modal({
    title: t('New group'),
    body: `<div class="field"><label>${esc(t('Group name'))}</label><input class="input" id="gName" maxlength="80" placeholder="${esc(t('e.g. Planning team'))}"></div>
      <div class="field"><label>${esc(t('Members'))}</label>${peopleChecklist()}</div>`,
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Create group'), cls: 'primary', action: async (m) => {
          const name = $('#gName', m).value.trim();
          const members = [...m.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
          if (!name) { toast(t('Please give the group a name'), 'error'); return false; }
          if (!members.length) { toast(t('Choose at least one person'), 'error'); return false; }
          const conv = await call(api.createGroup(name, members));
          if (!conv) return false;
          openConv(conv);
          return true;
        },
      },
    ],
  });
}

function groupMembersModal(groupId) {
  const g = S.groups.get(groupId);
  if (!g) return;
  modal({
    title: t('Add people to {name}', { name: g.name }),
    body: peopleChecklist(new Set(g.members)),
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Add'), cls: 'primary', action: async (m) => {
          const add = [...m.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
          if (add.length) await call(api.updateGroup(groupId, { addMembers: add }));
          return true;
        },
      },
    ],
  });
}

function renameGroupModal(groupId) {
  const g = S.groups.get(groupId);
  if (!g) return;
  modal({
    title: t('Rename group'),
    body: `<div class="field"><label>${esc(t('Group name'))}</label><input class="input" id="gName" maxlength="80" value="${esc(g.name)}"></div>`,
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Save'), cls: 'primary', action: async (m) => {
          const name = $('#gName', m).value.trim();
          if (!name) return false;
          await call(api.updateGroup(groupId, { name }));
          return true;
        },
      },
    ],
  });
}

function pollModal() {
  const conv = S.active;
  const optRow = (i) => `<div class="row-inline poll-row"><input class="input" data-opt maxlength="120" placeholder="${esc(t('Option {n}', { n: i }))}"></div>`;
  modal({
    title: t('Create a poll'),
    body: `<div class="field"><label>${esc(t('Question'))}</label><input class="input" id="pQ" maxlength="300" placeholder="${esc(t('e.g. Which day suits the planning meeting?'))}"></div>
      <div class="field"><label>${esc(t('Options'))}</label><div id="pOpts">${optRow(1)}${optRow(2)}${optRow(3)}</div>
      <button class="btn" id="pAdd" style="margin-top:8px">＋ ${esc(t('Add option'))}</button></div>
      <label class="toggle-row"><div class="tl"><div>${esc(t('Allow multiple answers'))}</div></div>
      <span class="switch"><input type="checkbox" id="pMulti"><span></span></span></label>`,
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Send poll'), cls: 'primary', action: async (m) => {
          const q = $('#pQ', m).value.trim();
          const options = [...m.querySelectorAll('[data-opt]')].map((i) => i.value.trim()).filter(Boolean);
          if (!q || options.length < 2) { toast(t('A poll needs a question and at least 2 options'), 'error'); return false; }
          const r = await call(api.createPoll(conv, q, options, $('#pMulti', m).checked));
          return r !== undefined;
        },
      },
    ],
    onOpen: (m) => {
      $('#pAdd', m).onclick = () => {
        const n = m.querySelectorAll('[data-opt]').length;
        if (n >= 12) return;
        $('#pOpts', m).insertAdjacentHTML('beforeend', optRow(n + 1));
        m.querySelectorAll('[data-opt]')[n].focus();
      };
    },
  });
}

function urgentModal() {
  const conv = S.active;
  const n = convRecipients(conv).length;
  modal({
    title: `🚨 ${t('Urgent alert')}`,
    cls: 'urgent-modal',
    body: `<p class="modal-note">${esc(t('The alert pops up over everything on {n} PCs with an alarm sound, until each person clicks Acknowledge. You will see who has confirmed.', { n }))}</p>
      <div class="field"><textarea class="input" id="uText" rows="4" maxlength="2000" placeholder="${esc(t('e.g. Blasting at 14:00 – clear zone B now'))}"></textarea></div>`,
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Send urgent alert'), cls: 'danger', action: async (m) => {
          const text = $('#uText', m).value.trim();
          if (!text) return false;
          const r = await call(api.sendText(conv, text, { urgent: true }));
          return r !== undefined;
        },
      },
    ],
  });
}

function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nextAt(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now() + 60000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function scheduleModal() {
  const conv = S.active;
  const text = $('#input').value.trim();
  const presets = [
    [t('In 1 hour'), Date.now() + 3600e3],
    [t('Next 07:00'), nextAt(7)],
    [t('Next 08:00'), nextAt(8)],
    [t('Next 19:00'), nextAt(19)],
  ];
  modal({
    title: t('Schedule a message'),
    body: `<div class="field"><label>${esc(t('Message'))}</label><textarea class="input" id="sText" rows="3" maxlength="20000">${esc(text)}</textarea></div>
      <div class="field"><label>${esc(t('Send at'))}</label><input class="input" type="datetime-local" id="sAt" value="${toLocalInput(Date.now() + 3600e3)}">
      <div class="chips">${presets.map(([l, ts]) => `<button class="chip-btn" data-ts="${ts}">${esc(l)}</button>`).join('')}</div></div>
      <label class="toggle-row"><div class="tl"><div>${esc(t('Send as urgent alert'))}</div></div>
      <span class="switch"><input type="checkbox" id="sUrgent"><span></span></span></label>`,
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Schedule'), cls: 'primary', action: async (m) => {
          const msg = $('#sText', m).value.trim();
          const at = new Date($('#sAt', m).value).getTime();
          if (!msg) return false;
          const r = await call(api.scheduleMessage(conv, msg, at, { urgent: $('#sUrgent', m).checked }));
          if (r === undefined) return false;
          if ($('#input').value.trim() === msg) { $('#input').value = ''; autoGrow(); }
          toast(t('Message scheduled for {when}', { when: fmtWhen(at) }));
          return true;
        },
      },
    ],
    onOpen: (m) => {
      m.querySelector('.chips').onclick = (e) => {
        const b = e.target.closest('[data-ts]');
        if (b) $('#sAt', m).value = toLocalInput(Number(b.dataset.ts));
      };
    },
  });
}

function scheduledModal(conv) {
  const draw = (m) => {
    const list = S.scheduled.filter((s) => s.conv === conv);
    $('.modal-body', m).innerHTML = list.length
      ? list.map((s) => `<div class="sched-item"><div>${ICONS.clock}</div><div class="si-body"><b>${esc(fmtWhen(s.at))}${s.urgent ? ` · 🚨 ${esc(t('Urgent'))}` : ''}</b><span>${esc(s.text)}</span></div>
          <button class="btn" data-cancel="${esc(s.id)}">${esc(t('Cancel'))}</button></div>`).join('')
      : `<div class="empty-note">${esc(t('No scheduled messages in this chat.'))}</div>`;
  };
  modal({
    title: t('Scheduled messages'),
    body: '',
    buttons: [{ label: t('Schedule a message'), action: () => { scheduleModal(); return true; } }, { label: t('Close'), cls: 'primary' }],
    onOpen: (m) => {
      draw(m);
      m.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-cancel]');
        if (!b) return;
        await call(api.cancelScheduled(b.dataset.cancel));
        S.scheduled = S.scheduled.filter((s) => s.id !== b.dataset.cancel);
        draw(m);
        renderScheduledStrip();
      });
    },
  });
}

function pinsModal(conv) {
  const pins = [...(S.convs.get(conv)?.pins || [])].reverse();
  modal({
    title: t('Pinned messages'),
    wide: true,
    body: pins.length
      ? `<div class="results">${pins.map((p) => {
        const m = findMsg(conv, p.id);
        return `<div class="result" data-id="${esc(p.id)}"><div class="rhead"><b>${esc(m ? (m.from === S.me.id ? t('You') : m.fromName) : '')}</b><span>${esc(t('pinned by {name}', { name: peerName(p.by) }))}</span><span style="margin-left:auto">${esc(fmtWhen(p.ts))}</span></div>
          <div class="rtext">${esc(m ? msgPreview(m) : t('Message not loaded'))}</div></div>`;
      }).join('')}</div>`
      : `<div class="empty-note">${esc(t('Nothing is pinned yet. Right-click a message and choose Pin.'))}</div>`,
    onOpen: (m, close) => {
      m.addEventListener('click', (e) => {
        const r = e.target.closest('.result');
        if (!r) return;
        close();
        jumpTo(conv, r.dataset.id);
      });
    },
  });
}

function exportModal(conv) {
  modal({
    title: t('Export chat'),
    body: `<p class="modal-note">${esc(t('Save the whole conversation with {name} as a file, e.g. for records or reports.', { name: convName(conv) }))}</p>`,
    buttons: [
      { label: t('Cancel') },
      { label: t('Text file'), action: async () => { const p = await call(api.exportChat(conv, 'txt')); if (p) toast(t('Saved to {path}', { path: p })); return true; } },
      { label: 'PDF', cls: 'primary', action: async () => { const p = await call(api.exportChat(conv, 'pdf')); if (p) toast(t('Saved to {path}', { path: p })); return true; } },
    ],
  });
}

function searchModal() {
  modal({
    title: t('Find messages'),
    wide: true,
    body: `<div class="field"><input class="input" id="sq" placeholder="${esc(t('Type at least 2 letters…'))}"></div><div class="results" id="sres"></div>`,
    onOpen: (m, close) => {
      let timer = 0;
      const input = $('#sq', m);
      const res = $('#sres', m);
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = input.value.trim();
          if (q.length < 2) { res.innerHTML = ''; return; }
          const results = await api.search(q);
          if (!results.length) { res.innerHTML = `<div class="empty-note">${esc(t('No messages found.'))}</div>`; return; }
          const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          res.innerHTML = results.map((r, i) => {
            const text = msgPreview(r.msg);
            const idx = text.toLowerCase().indexOf(q.toLowerCase());
            const snippet = text.slice(Math.max(0, idx - 40), idx + 120);
            return `<div class="result" data-i="${i}"><div class="rhead"><b>${esc(convName(r.conv))}</b><span>${esc(peerName(r.msg.from))}</span><span style="margin-left:auto">${esc(fmtWhen(r.msg.ts))}</span></div>
              <div class="rtext">${esc(snippet).replace(re, (x) => `<mark>${x}</mark>`)}</div></div>`;
          }).join('');
          res.onclick = (e) => {
            const r = e.target.closest('.result');
            if (!r) return;
            const hit = results[Number(r.dataset.i)];
            close();
            jumpTo(hit.conv, hit.msg.id);
          };
        }, 180);
      });
    },
  });
}

async function jumpTo(conv, msgId) {
  const list = S.msgs.get(conv);
  if (!list || !list.some((m) => m.id === msgId)) {
    const all = await api.loadMessages(conv, { limit: 1e9 });
    S.msgs.set(conv, all);
    S.hasMore.set(conv, false);
  }
  await openConv(conv);
  const node = $(`#messages [data-id="${CSS.escape(msgId)}"]`);
  if (node) {
    node.scrollIntoView({ block: 'center' });
    node.classList.add('highlight');
  } else {
    toast(t('That message is no longer available'), 'error');
  }
}

function toggleRow(key, title, sub) {
  return `<label class="toggle-row"><div class="tl"><div>${esc(title)}</div>${sub ? `<div>${esc(sub)}</div>` : ''}</div>
    <span class="switch"><input type="checkbox" data-set="${key}" ${S.settings[key] ? 'checked' : ''}><span></span></span></label>`;
}

function settingsModal() {
  const me = S.me;
  const themes = [['system', t('Automatic')], ['light', t('Light')], ['dark', t('Dark')]];
  const body = `
    <div class="section-title">${esc(t('Your profile'))}</div>
    <div class="profile-row">
      <div id="sAvatar">${avatarHtml('direct', me.id, me.name, null, 'xl')}</div>
      <div class="profile-btns"><button class="btn" id="sPhoto">${esc(t('Change photo…'))}</button>
      <button class="btn" id="sPhotoRm">${esc(t('Remove photo'))}</button></div>
    </div>
    <div class="field"><label>${esc(t('Display name'))}</label><input class="input" id="sName" maxlength="60" value="${esc(me.name)}"></div>
    <div class="field"><label>${esc(t('Department or job title (optional)'))}</label><input class="input" id="sDept" maxlength="60" value="${esc(me.dept)}" placeholder="${esc(t('e.g. Mine Planning'))}"></div>

    <div class="section-title">${esc(t('Language'))}</div>
    <div class="segmented" id="sLang">${I18N.LANGUAGES.map(([v, l]) => `<button data-v="${v}" class="${(S.settings.language || 'en') === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>

    <div class="section-title">${esc(t('Appearance'))}</div>
    <div class="style-grid" id="sStyle">${STYLES.map(([k, label]) => `<button class="style-card${(S.settings.style || 'indigo') === k ? ' on' : ''}" data-v="${k}">
      <div class="style-preview" data-style="${k}"><div class="spv-side"><i></i><i></i><i></i></div><div class="spv-chat"><div class="spv-in"></div><div class="spv-out"></div><div class="spv-send"></div></div></div>
      <span>${esc(t(label))}</span></button>`).join('')}</div>
    <div class="segmented" id="sTheme" style="margin-top:12px">${themes.map(([v, l]) => `<button data-v="${v}" class="${S.settings.theme === v ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>

    <div class="section-title">${esc(t('Notifications'))}</div>
    ${toggleRow('notifications', t('Desktop notifications'), t('Show a pop-up when a message arrives'))}
    ${toggleRow('sound', t('Notification sound'))}
    ${toggleRow('enterToSend', t('Press Enter to send'), t('When off, use Ctrl + Enter to send'))}

    <div class="section-title">${esc(t('Files'))}</div>
    <div class="field"><label>${esc(t('Save received files to'))}</label>
      <div class="row-inline"><input class="input" id="sDir" readonly value="${esc(S.settings.downloadDir)}"><button class="btn" id="sDirBtn">${esc(t('Change…'))}</button></div></div>
    ${toggleRow('autoAccept', t('Download files automatically'), t('Files up to {n} MB download as soon as they arrive', { n: S.settings.autoAcceptMaxMB }))}

    <div class="section-title">${esc(t('Startup and updates'))}</div>
    ${S.platform === 'linux' ? '' : toggleRow('startWithWindows', t('Start when Windows starts'), t('Opens quietly in the system tray'))}
    ${toggleRow('minimizeToTray', t('Keep running in the tray when closed'), t('So you never miss a message'))}
    ${toggleRow('autoAway', t('Set me as Away when idle'), t('After 5 minutes without mouse or keyboard activity'))}
    ${toggleRow('autoUpdate', t('Update automatically from the network'), t('Newer versions on other PCs are installed safely (digitally signed)'))}

    <div class="section-title">${esc(t('Network'))}</div>
    <div class="kv" style="margin-bottom:12px"><div>${esc(t('This PC'))}</div><div>${esc((me.addresses || []).join(', ') || t('No network'))}</div><div>${esc(t('Port'))}</div><div>${me.port || '—'}</div><div>${esc(t('Version'))}</div><div>${esc(S.version || '')}</div></div>
    <div class="field"><label>${esc(t('Add a computer by IP address'))}</label>
      <div class="row-inline"><input class="input" id="sPeer" placeholder="${esc(t('e.g. 10.20.5.31'))}"><button class="btn primary" id="sPeerBtn">${esc(t('Add'))}</button></div>
      <div class="hint">${esc(t("Only needed for PCs on a different network segment that don't appear automatically."))}</div>
      <div class="tag-list" id="sPeers"></div></div>`;

  modal({
    title: t('Settings'),
    wide: true,
    body,
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Save'), cls: 'primary', action: async (m) => {
          const name = $('#sName', m).value.trim();
          if (!name) { toast(t('Name cannot be empty'), 'error'); return false; }
          const me2 = await call(api.setProfile({ name, dept: $('#sDept', m).value }));
          if (me2) S.me = me2;
          renderMe();
          toast(t('Settings saved'));
          return true;
        },
      },
    ],
    onOpen: (m, close) => {
      m.querySelectorAll('[data-set]').forEach((cb) => cb.addEventListener('change', async () => {
        S.settings = await call(api.setSettings({ [cb.dataset.set]: cb.checked })) || S.settings;
      }));
      $('#sTheme', m).addEventListener('click', async (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        S.settings = await call(api.setSettings({ theme: b.dataset.v })) || S.settings;
        m.querySelectorAll('#sTheme button').forEach((x) => x.classList.toggle('on', x === b));
        applyTheme();
      });
      $('#sStyle', m).addEventListener('click', async (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        S.settings = await call(api.setSettings({ style: b.dataset.v })) || S.settings;
        m.querySelectorAll('#sStyle .style-card').forEach((x) => x.classList.toggle('on', x === b));
        applyTheme();
      });
      $('#sLang', m).addEventListener('click', async (e) => {
        const b = e.target.closest('[data-v]');
        if (!b || b.dataset.v === S.settings.language) return;
        S.settings = await call(api.setSettings({ language: b.dataset.v })) || S.settings;
        close();
        rerenderAll();
        settingsModal();
      });
      const drawAvatar = () => { $('#sAvatar', m).innerHTML = avatarHtml('direct', S.me.id, S.me.name, null, 'xl'); };
      $('#sPhoto', m).addEventListener('click', async () => {
        const data = await call(api.pickAvatar());
        if (!data) return;
        S.avatars.set(S.me.id, data);
        drawAvatar();
        renderMe();
      });
      $('#sPhotoRm', m).addEventListener('click', async () => {
        await call(api.removeAvatar());
        S.avatars.delete(S.me.id);
        drawAvatar();
        renderMe();
      });
      $('#sDirBtn', m).addEventListener('click', async () => {
        const dir = await api.pickFolder();
        if (!dir) return;
        S.settings = await call(api.setSettings({ downloadDir: dir })) || S.settings;
        $('#sDir', m).value = dir;
      });
      const drawPeers = () => {
        $('#sPeers', m).innerHTML = S.manualPeers.map((p) => `<span class="tag">${esc(p)}<button data-rm="${esc(p)}" title="${esc(t('Remove'))}">✕</button></span>`).join('');
      };
      drawPeers();
      $('#sPeers', m).addEventListener('click', async (e) => {
        const b = e.target.closest('[data-rm]');
        if (!b) return;
        await call(api.removePeer(b.dataset.rm));
        S.manualPeers = S.manualPeers.filter((p) => p !== b.dataset.rm);
        drawPeers();
      });
      const add = async () => {
        const v = $('#sPeer', m).value.trim();
        if (!v) return;
        $('#sPeerBtn', m).disabled = true;
        const res = await call(api.addPeer(v));
        $('#sPeerBtn', m).disabled = false;
        if (res === undefined) return;
        if (!S.manualPeers.includes(v)) S.manualPeers.push(v);
        $('#sPeer', m).value = '';
        drawPeers();
        toast(res
          ? t('Connected to {name}', { name: S.peers.get(res)?.name || v })
          : t('Saved. Waiting for {host} to answer – make sure LAN Messenger 2 is running there.', { host: v }));
      };
      $('#sPeerBtn', m).addEventListener('click', add);
      $('#sPeer', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    },
  });
}

function pasteImageModal(blob) {
  const url = URL.createObjectURL(blob);
  const conv = S.active;
  modal({
    title: t('Send image to {name}?', { name: convName(conv) }),
    body: `<img class="paste-preview" src="${url}">`,
    onClose: () => setTimeout(() => URL.revokeObjectURL(url), 1000),
    buttons: [
      { label: t('Cancel') },
      {
        label: t('Draw on it'), action: async () => {
          const reader = new FileReader();
          reader.onload = () => openEditor(reader.result, { title: t('Draw on picture'), onSend: (bytes) => call(api.sendImageData(conv, bytes, 'png', replyOpts())) });
          reader.readAsDataURL(blob);
          return true;
        },
      },
      {
        label: t('Send'), cls: 'primary', action: async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          await call(api.sendImageData(conv, bytes, blob.type === 'image/jpeg' ? 'jpg' : 'png', replyOpts()));
          return true;
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ sound
let audioCtx = null;
function playSound() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const tm = audioCtx.currentTime;
    for (const [freq, start] of [[880, 0], [1320, 0.09]]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, tm + start);
      g.gain.exponentialRampToValueAtTime(0.18, tm + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, tm + start + 0.28);
      o.connect(g).connect(audioCtx.destination);
      o.start(tm + start);
      o.stop(tm + start + 0.3);
    }
  } catch { /* audio not available */ }
}

// ------------------------------------------------------------------ events from main process
function onTyping({ conv, peerId }) {
  if (!S.typing.has(conv)) S.typing.set(conv, new Map());
  const m = S.typing.get(conv);
  clearTimeout(m.get(peerId));
  m.set(peerId, setTimeout(() => {
    m.delete(peerId);
    if (S.active === conv) renderHeader();
    renderList();
  }, 4000));
  if (S.active === conv) renderHeader();
  renderList();
}

function handleEvent({ type, payload }) {
  switch (type) {
    case 'peers': {
      S.peers = new Map(payload.map((p) => [p.id, p]));
      renderList();
      if (S.active) { renderHeader(); renderComposerState(); }
      break;
    }
    case 'groups':
      S.groups = new Map(payload.map((g) => [g.id, g]));
      renderList();
      if (S.active && convKind(S.active) === 'group') renderHeader();
      break;
    case 'conv':
      S.convs.set(payload.id, payload);
      if (payload.id === S.active) {
        if (payload.unread) markReadIfVisible();
        renderPinBar();
      }
      renderList();
      break;
    case 'message': {
      const { conv, msg, isNew } = payload;
      const tm = S.typing.get(conv);
      if (isNew && tm && tm.has(msg.from)) {
        clearTimeout(tm.get(msg.from));
        tm.delete(msg.from);
        if (conv === S.active) renderHeader();
      }
      if (msg.kind === 'file' && msg.file.state !== 'downloading') S.progress.delete(msg.id);
      if (S.editing && S.editing.id === msg.id && msg.deleted) cancelEdit();
      upsertMessage(conv, msg, isNew);
      if (msg.kind === 'game') Game.onMessage(conv, msg);
      if (isNew && conv === S.active && msg.from !== S.me.id) markReadIfVisible();
      break;
    }
    case 'file-progress':
      S.progress.set(payload.msgId, payload);
      refreshMsgDom(payload.conv, payload.msgId);
      break;
    case 'typing':
      onTyping(payload);
      break;
    case 'avatar':
      if (payload.data) S.avatars.set(payload.id, payload.data);
      else S.avatars.delete(payload.id);
      renderList();
      if (payload.id === S.me.id) renderMe();
      if (S.active) { renderHeader(); renderMessages(false); }
      break;
    case 'scheduled':
      S.scheduled = payload;
      renderScheduledStrip();
      break;
    case 'me':
      S.me = { ...S.me, ...payload };
      renderMe();
      break;
    case 'open-conv':
      openConv(payload);
      break;
    case 'open-game':
      openConv(payload.conv).then(() => Game.show(payload.conv, payload.id));
      break;
    case 'play-sound':
      playSound();
      break;
    case 'update-ready':
      S.updateReady = payload;
      renderUpdateBanner();
      break;
    case 'rtc':
      Share.onRtc(payload);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('#me').addEventListener('click', statusMenu);
  $('#btnSettings').addEventListener('click', settingsModal);
  $('#btnNewGroup').addEventListener('click', newGroupModal);
  $('#btnSearch').addEventListener('click', searchModal);
  $('#btnPlus').addEventListener('click', () => {
    if (popoverOpen()) hidePopover();
    else plusMenu();
  });
  $('#btnMic').addEventListener('click', () => S.active && Voice.record(S.active));
  $('#btnEmoji').addEventListener('click', () => {
    if (popoverOpen() && $('#popover').classList.contains('emoji-pop')) hidePopover();
    else emojiPicker();
  });
  $('#btnSend').addEventListener('click', sendCurrent);
  $('#filter').addEventListener('input', (e) => { S.filter = e.target.value; renderList(); });
  $('#filter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#convList .conv');
      if (first) { first.click(); e.target.value = ''; S.filter = ''; renderList(); }
    } else if (e.key === 'Escape') {
      e.target.value = ''; S.filter = ''; renderList();
    }
  });

  const input = $('#input');
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (S.editing || S.replyTo)) {
      e.preventDefault();
      if (S.editing) cancelEdit(); else cancelReply();
      return;
    }
    if (e.key === 'ArrowUp' && !input.value && S.active) {
      const list = S.msgs.get(S.active) || [];
      const last = [...list].reverse().find((m) => m.from === S.me.id && m.kind === 'text' && !m.deleted && !m.urgent);
      if (last) { e.preventDefault(); startEdit(last); }
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    const enterSends = S.settings.enterToSend !== false;
    if ((enterSends && !e.shiftKey && !e.ctrlKey) || (!enterSends && e.ctrlKey)) {
      e.preventDefault();
      sendCurrent();
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || !S.active) return;
    e.preventDefault();
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) call(api.sendFiles(S.active, paths, replyOpts()));
    else if (files[0].type.startsWith('image/')) pasteImageModal(files[0]);
  });

  const box = $('#messages');
  box.addEventListener('scroll', async () => {
    if (box.scrollTop > 60 || !S.active || !S.hasMore.get(S.active) || box.dataset.loading) return;
    const conv = S.active;
    const list = S.msgs.get(conv);
    if (!list.length) return;
    box.dataset.loading = '1';
    const older = await api.loadMessages(conv, { before: list[0].id, limit: PAGE });
    delete box.dataset.loading;
    S.hasMore.set(conv, older.length >= PAGE);
    list.unshift(...older);
    if (S.active === conv) renderMessages(false, true);
  });

  // Drag & drop files and folders onto the chat.
  let dragDepth = 0;
  const chat = $('#chat');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  chat.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !S.active) return;
    dragDepth++;
    $('#dropOverlay').classList.add('show');
  });
  chat.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropOverlay').classList.remove('show');
  });
  chat.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  chat.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropOverlay').classList.remove('show');
    if (!S.active) return;
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) call(api.sendFiles(S.active, paths, replyOpts()));
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 's') {
      e.preventDefault();
      screenshot();
    } else if ((e.ctrlKey || e.metaKey) && k === 'k') {
      e.preventDefault();
      $('#filter').focus();
      $('#filter').select();
    } else if ((e.ctrlKey || e.metaKey) && k === 'f') {
      e.preventDefault();
      searchModal();
    } else if (e.key === 'Escape' && popoverOpen()) {
      hidePopover();
    }
  });

  window.addEventListener('focus', () => { markReadIfVisible(); });
  setInterval(() => { renderList(); if (S.active) renderHeader(); }, 60000);
}

async function boot() {
  const st = await api.init();
  S.me = st.me;
  S.settings = st.settings;
  S.manualPeers = st.manualPeers || [];
  S.platform = st.platform;
  S.version = st.version;
  S.updateReady = st.updateReady;
  S.scheduled = st.scheduled || [];
  S.avatars = new Map(Object.entries(st.avatars || {}));
  S.peers = new Map(st.peers.map((p) => [p.id, p]));
  S.groups = new Map(st.groups.map((g) => [g.id, g]));
  S.convs = new Map(st.convs.map((c) => [c.id, c]));
  if (st.platform !== 'darwin') document.body.classList.add('overlay-controls');
  applyTheme();
  applyLanguage();
  api.on(handleEvent);
  wire();
  renderMe();
  renderList();
  renderUpdateBanner();
}

window.addEventListener('DOMContentLoaded', boot);
