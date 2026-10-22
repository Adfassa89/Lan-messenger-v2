'use strict';
/* global api, EMOJI */

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
  active: null,
  typing: new Map(), // conv -> Map(peerId -> timeout)
  progress: new Map(), // msgId -> { done, size, speed, upload }
  thumbs: new Map(), // path -> { url }
  filter: '',
  platform: '',
};
const PAGE = 150;
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

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
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return esc(s.toUpperCase());
}

const ICON_GROUP = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2c1.8.6 3 2.2 3.5 4.8"/></svg>';
const ICON_ALL = '<svg viewBox="0 0 24 24"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';

function avatarHtml(kind, id, name, status, size = '') {
  const bg = kind === 'broadcast' ? 'linear-gradient(135deg,#f59e0b,#ef4444)' : hashColor(id);
  const inner = kind === 'group' ? ICON_GROUP : kind === 'broadcast' ? ICON_ALL : initials(name);
  const dot = status ? `<span class="dot ${status}"></span>` : '';
  return `<div class="avatar ${size}" style="background:${bg}">${inner}${dot}</div>`;
}

function statusText(s) {
  return { online: 'Available', away: 'Away', busy: 'Busy', offline: 'Offline' }[s] || s;
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  if (dayKey(ts) === dayKey(today)) return 'Today';
  if (dayKey(ts) === dayKey(yest)) return 'Yesterday';
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

function fmtListTime(ts) {
  if (!ts) return '';
  if (dayKey(ts) === dayKey(Date.now())) return fmtTime(ts);
  if (Date.now() - ts < 6 * 864e5) return new Date(ts).toLocaleDateString([], { weekday: 'short' });
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function fmtAgo(ts) {
  if (!ts) return 'never seen';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'last seen just now';
  if (m < 60) return `last seen ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `last seen ${h} h ago`;
  return `last seen ${new Date(ts).toLocaleDateString()}`;
}

const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;

function toast(text, type = '') {
  const t = el('div', `toast ${type}`, esc(text));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 5000 : 2800);
}

async function call(promise) {
  try {
    return await promise;
  } catch (err) {
    toast(cleanError(err), 'error');
    return undefined;
  }
}

// ------------------------------------------------------------------ theme
function applyTheme() {
  const t = S.settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ------------------------------------------------------------------ conversation helpers
function convKind(conv) {
  if (conv === 'broadcast') return 'broadcast';
  if (conv.startsWith('g:')) return 'group';
  return 'direct';
}

function convName(conv) {
  const kind = convKind(conv);
  if (kind === 'broadcast') return 'Everyone';
  if (kind === 'group') return S.groups.get(conv.slice(2))?.name || 'Group';
  return S.peers.get(conv)?.name || 'Unknown';
}

function onlineCount() {
  let n = 0;
  for (const p of S.peers.values()) if (p.online) n++;
  return n;
}

function peerName(id) {
  if (id === S.me.id) return 'You';
  return S.peers.get(id)?.name || 'Someone';
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
  $('#netInfo').innerHTML = `<span class="pulse"></span>${n === 0 ? 'Looking for people…' : `${n} ${n === 1 ? 'person' : 'people'} online`}`;
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
  if (match('everyone', 'broadcast')) {
    items.push({ conv: 'broadcast', kind: 'broadcast', name: 'Everyone', meta: bc, online: true, pinned: true });
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
    list.append(el('div', 'list-label', 'Recent chats'));
    for (const i of recent) list.append(convItem(i));
  }
  if (others.length) {
    list.append(el('div', 'list-label', recent.length ? 'People' : 'People on your network'));
    for (const i of others) list.append(convItem(i));
  }
  if (!items.length) {
    list.append(el('div', 'empty-note', f ? 'Nobody matches your search.' : 'Nobody here yet.<br>Other PCs running LAN Messenger will appear automatically.'));
  }
  renderNet();
  updateBadge();
}

function convItem(i) {
  const b = el('button', `conv${i.conv === S.active ? ' active' : ''}${i.kind === 'direct' && !i.online ? ' offline' : ''}${i.meta?.unread ? ' unread' : ''}`);
  b.dataset.conv = i.conv;
  let preview = '';
  const typing = S.typing.get(i.conv);
  if (typing && typing.size) {
    preview = `<span style="color:var(--accent-text)">typing…</span>`;
  } else if (i.meta && i.meta.lastText) {
    const who = i.meta.lastFrom === S.me.id ? 'You: ' : (i.kind !== 'direct' && i.meta.lastFrom ? `${esc(peerName(i.meta.lastFrom).split(' ')[0])}: ` : '');
    preview = who + esc(i.meta.lastText);
  } else if (i.kind === 'broadcast') {
    const n = onlineCount();
    preview = n ? `Message all ${n} ${n === 1 ? 'person' : 'people'} online` : 'Message everyone on the network';
  } else if (i.kind === 'group') {
    preview = `${i.members.length} members`;
  } else {
    const p = i.peer;
    preview = p.online ? `${statusText(p.status)}${p.dept ? ` · ${esc(p.dept)}` : ''}` : esc(fmtAgo(p.lastSeen));
  }
  const status = i.kind === 'direct' ? (i.online ? i.peer.status : 'offline') : null;
  b.innerHTML = `
    ${avatarHtml(i.kind, i.conv, i.name, status)}
    <div class="body">
      <div class="row"><span class="title">${esc(i.name)}</span><span class="time">${fmtListTime(i.meta?.lastTs)}</span></div>
      <div class="row"><span class="preview">${preview}</span>${i.meta?.unread ? `<span class="badge">${i.meta.unread > 99 ? '99+' : i.meta.unread}</span>` : ''}</div>
    </div>`;
  b.addEventListener('click', () => openConv(i.conv));
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    convMenu(i, e.clientX, e.clientY);
  });
  return b;
}

function convMenu(i, x, y) {
  const items = [{ label: 'Open chat', action: () => openConv(i.conv) }];
  items.push({ label: 'Clear chat history', danger: true, action: () => confirmClear(i.conv) });
  if (i.kind === 'group') items.push({ label: 'Leave group', danger: true, action: () => confirmLeave(i.conv.slice(2)) });
  if (i.kind === 'direct' && !i.online) {
    items.push({
      label: 'Remove from list', danger: true, action: async () => {
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
  document.title = n ? `(${n}) LAN Messenger` : 'LAN Messenger';
}

// ------------------------------------------------------------------ chat view
async function openConv(conv) {
  hidePopover();
  S.active = conv;
  api.setActiveConv(conv);
  $('#welcome').classList.add('hidden');
  if (!S.msgs.has(conv)) {
    const list = await api.loadMessages(conv, { limit: PAGE });
    S.msgs.set(conv, list);
    S.hasMore.set(conv, list.length >= PAGE);
  }
  if (S.active !== conv) return;
  renderHeader();
  renderMessages(true);
  renderComposerState();
  renderList();
  markReadIfVisible();
  $('#input').focus();
}

function closeConv() {
  S.active = null;
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
    sub = `<div class="sub typing-now">${esc(typingNames.join(', '))} ${typingNames.length > 1 ? 'are' : 'is'} typing…</div>`;
  } else if (kind === 'direct') {
    const p = S.peers.get(conv);
    status = p && p.online ? p.status : 'offline';
    const bits = [p && p.online ? statusText(p.status) : fmtAgo(p && p.lastSeen)];
    if (p && p.dept) bits.push(esc(p.dept));
    if (p && p.host) bits.push(esc(p.host));
    sub = `<div class="sub"><span class="sdot ${status}"></span>${bits.join(' · ')}</div>`;
  } else if (kind === 'group') {
    const g = S.groups.get(conv.slice(2));
    const names = g ? g.members.map(peerName) : [];
    const on = g ? g.members.filter((m) => m === S.me.id || S.peers.get(m)?.online).length : 0;
    sub = `<div class="sub">${g ? g.members.length : 0} members, ${on} online · ${esc(names.join(', '))}</div>`;
  } else {
    sub = `<div class="sub">Broadcast to everyone on the network · ${onlineCount()} online now</div>`;
  }
  h.innerHTML = `
    ${avatarHtml(kind, conv, convName(conv), status === 'offline' ? null : status, 'lg')}
    <div class="who"><div class="title">${esc(convName(conv))}</div>${sub}</div>
    <button class="icon-btn" id="hdrAttach" title="Send files"><svg class="ico" viewBox="0 0 24 24"><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4M12 3v12M7 8l5-5 5 5"/></svg></button>
    ${kind === 'group' ? '<button class="icon-btn" id="hdrAdd" title="Add people"><svg class="ico" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 19c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5M18 8v6M15 11h6"/></svg></button>' : ''}
    <button class="icon-btn" id="hdrMore" title="More"><svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg></button>`;
  $('#hdrAttach').onclick = attachFiles;
  if ($('#hdrAdd')) $('#hdrAdd').onclick = () => groupMembersModal(conv.slice(2));
  $('#hdrMore').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items = [];
    if (kind === 'group') {
      items.push({ label: 'Add people…', action: () => groupMembersModal(conv.slice(2)) });
      items.push({ label: 'Rename group…', action: () => renameGroupModal(conv.slice(2)) });
    }
    items.push({ label: 'Find in messages…', action: () => searchModal() });
    items.push('-');
    items.push({ label: 'Clear chat history', danger: true, action: () => confirmClear(conv) });
    if (kind === 'group') items.push({ label: 'Leave group', danger: true, action: () => confirmLeave(conv.slice(2)) });
    showMenu(items, r.right - 220, r.bottom + 6);
  };
}

function renderComposerState() {
  const conv = S.active;
  const hint = $('#offlineHint');
  hint.textContent = '';
  if (!conv) return;
  const kind = convKind(conv);
  if (kind === 'direct') {
    const p = S.peers.get(conv);
    if (p && !p.online) hint.textContent = `${p.name} is offline. Messages will be delivered automatically when they come back online.`;
    else if (p && p.status === 'busy') hint.textContent = `${p.name} is busy and may not reply right away.`;
  } else if (kind === 'broadcast') {
    hint.textContent = 'Messages here go to everyone on the network.';
  }
  $('#input').placeholder = kind === 'broadcast' ? 'Message everyone…' : `Message ${convName(conv)}…`;
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
  if (S.hasMore.get(S.active)) {
    const more = el('div', 'system', '<span>Scroll up to load older messages</span>');
    more.id = 'loadMore';
    inner.append(more);
  }
  if (!list.length) {
    inner.append(el('div', 'empty-note', convKind(S.active) === 'broadcast'
      ? 'Send an announcement to everyone on the network.'
      : 'No messages yet. Say hello! 👋'));
  }
  let lastDay = null;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const d = dayKey(m.ts);
    if (d !== lastDay) {
      lastDay = d;
      inner.append(el('div', 'day', `<span>${fmtDay(m.ts)}</span>`));
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
  return a.kind !== 'system' && b.kind !== 'system' && a.from === b.from && b.ts - a.ts < 5 * 60000 && dayKey(a.ts) === dayKey(b.ts);
}

function ticks(m) {
  const one = '<path d="M5 12.5l4 4L19 7"/>';
  const two = '<path d="M2.5 12.5l4 4L16 7"/><path d="M10.5 15.5l1 1L21 7"/>';
  if (m.status === 'queued') return '<svg class="tick" viewBox="0 0 24 24"><title>Waiting to be delivered</title><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>';
  if (m.status === 'partial') return `<svg class="tick" viewBox="0 0 24 24"><title>Delivered to some people</title>${one}</svg>`;
  if (m.status === 'delivered') return `<svg class="tick" viewBox="0 0 24 24"><title>Delivered</title>${two}</svg>`;
  if (m.status === 'read') return `<svg class="tick read" viewBox="0 0 24 24"><title>Read</title>${two}</svg>`;
  return '';
}

function isJumbo(text) {
  const t = (text || '').trim();
  if (!t || t.length > 16) return false;
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t);
}

function msgNode(list, i) {
  const m = list[i];
  if (m.kind === 'system') {
    const s = el('div', 'system', `<span>${esc(m.text)}</span>`);
    s.dataset.id = m.id;
    return s;
  }
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

  const jumbo = m.kind === 'text' && isJumbo(m.text);
  const bubble = el('div', `bubble${jumbo ? ' jumbo' : ''}`);
  let html = '';
  if (showSender) html += `<div class="sender" style="color:${senderColor(m.from)}">${esc(m.fromName || peerName(m.from))}</div>`;
  if (m.kind === 'file') html += fileHtml(m, out);
  else html += `<div class="text">${linkify(m.text)}</div>`;
  html += `<span class="meta">${fmtTime(m.ts)}${out ? ticks(m) : ''}</span>`;
  bubble.innerHTML = html;
  row.append(bubble);

  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    msgMenu(m, e.clientX, e.clientY);
  });
  bubble.addEventListener('click', (e) => onBubbleClick(e, m));
  if (m.kind === 'file') loadThumb(row, m);
  return row;
}

function senderColor(id) {
  const g = hashColor(id).match(/#[0-9a-f]{6}/i);
  return g ? g[0] : 'inherit';
}

function extLabel(name) {
  const ext = (name.split('.').pop() || '').slice(0, 4).toUpperCase();
  return ext && ext !== name.toUpperCase() ? ext : 'FILE';
}

function fileHtml(m, out) {
  const f = m.file;
  const prog = S.progress.get(m.id);
  let sub = fmtSize(f.size);
  let bar = '';
  let btns = '';
  let err = '';
  const path = f.path;
  const isImg = IMAGE_RE.test(f.name);

  if (out) {
    if (prog && prog.upload && prog.done < prog.size) {
      sub = `Sending… ${fmtSize(prog.done)} of ${fmtSize(f.size)}`;
      bar = `<div class="progress"><div style="width:${(prog.done / Math.max(1, f.size)) * 100}%"></div></div>`;
    }
    btns = `<button class="fbtn ghost" data-act="open">Open</button><button class="fbtn ghost" data-act="folder">Show in folder</button>`;
  } else if (f.state === 'downloading') {
    const p = prog || { done: 0, size: f.size, speed: 0 };
    sub = `${fmtSize(p.done)} of ${fmtSize(f.size)}${p.speed ? ` · ${fmtSize(p.speed)}/s` : ''}`;
    bar = `<div class="progress"><div style="width:${(p.done / Math.max(1, f.size)) * 100}%"></div></div>`;
    btns = `<button class="fbtn ghost" data-act="cancel">Cancel</button>`;
  } else if (f.state === 'done') {
    btns = `<button class="fbtn" data-act="open">Open</button><button class="fbtn ghost" data-act="folder">Show in folder</button>`;
  } else if (f.state === 'failed') {
    err = `<div class="ferr">${esc(f.error || 'Download failed')}</div>`;
    btns = `<button class="fbtn" data-act="download">Retry</button>`;
  } else {
    btns = `<button class="fbtn" data-act="download">Download</button>`;
  }
  const thumb = isImg && path && (out || f.state === 'done') ? `<div class="thumb" data-act="view" data-path="${esc(path)}"></div>` : '';
  return `${thumb}<div class="file">
      <div class="ficon">${esc(extLabel(f.name))}</div>
      <div class="finfo"><div class="fname" title="${esc(f.name)}">${esc(f.name)}</div><div class="fsub">${sub}</div>${bar}${err}</div>
    </div><div class="fbtns">${btns}</div>`;
}

async function loadThumb(row, m) {
  const t = row.querySelector('.thumb');
  if (!t) return;
  const p = t.dataset.path;
  let info = S.thumbs.get(p);
  if (!info) {
    info = await api.thumb(p);
    if (!info) return t.remove();
    S.thumbs.set(p, info);
  }
  const box = $('#messages');
  const stick = isAtBottom(box);
  const img = new Image();
  img.alt = m.file.name;
  img.onload = () => { if (stick) box.scrollTop = box.scrollHeight; };
  img.src = info.url;
  t.append(img);
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
}

function lightbox(p) {
  const info = S.thumbs.get(p);
  if (!info) return;
  const lb = el('div', 'lightbox', `<img src="${info.url}">`);
  lb.addEventListener('click', () => lb.remove());
  lb.addEventListener('dblclick', () => api.openFile(p));
  document.body.append(lb);
}

function msgMenu(m, x, y) {
  const items = [];
  const sel = String(window.getSelection() || '');
  if (sel) items.push({ label: 'Copy selection', action: () => api.copyText(sel) });
  if (m.kind === 'text') items.push({ label: 'Copy message', action: () => api.copyText(m.text) });
  if (m.kind === 'file' && m.file.path) {
    items.push({ label: 'Open file', action: () => api.openFile(m.file.path) });
    items.push({ label: 'Show in folder', action: () => api.showInFolder(m.file.path) });
  }
  if (m.from === S.me.id && m.recipients && m.recipients.length > 1) {
    const names = (ids) => ids.map(peerName).join(', ') || 'nobody yet';
    items.push({
      label: 'Message info…', action: () => infoModal('Message info', `
        <div class="kv"><div>Sent</div><div>${new Date(m.ts).toLocaleString()}</div>
        <div>Delivered to</div><div>${esc(names(m.deliveredTo || []))}</div>
        <div>Read by</div><div>${esc(names(m.readBy || []))}</div></div>`),
    });
  }
  items.push('-');
  items.push({
    label: 'Delete for me', danger: true, action: async () => {
      await call(api.deleteMessage(S.active, m.id));
      const list = S.msgs.get(S.active) || [];
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
  } else {
    renderMessages(msg.from === S.me.id);
  }
}

function updateProgressDom(p) {
  if (p.conv !== S.active) return;
  const list = S.msgs.get(p.conv) || [];
  const idx = list.findIndex((m) => m.id === p.msgId);
  if (idx < 0) return;
  const node = $(`#messages [data-id="${CSS.escape(p.msgId)}"]`);
  if (node) node.replaceWith(msgNode(list, idx));
}

// ------------------------------------------------------------------ composer
async function sendCurrent() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !S.active) return;
  input.value = '';
  autoGrow();
  await call(api.sendText(S.active, text));
}

function autoGrow() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

let lastTypingSent = 0;
function onInput() {
  autoGrow();
  if (!S.active || !$('#input').value) return;
  const now = Date.now();
  if (now - lastTypingSent > 2500) {
    lastTypingSent = now;
    api.typing(S.active);
  }
}

async function attachFiles() {
  if (!S.active) return;
  await call(api.pickFiles(S.active));
}

function insertAtCursor(text) {
  const t = $('#input');
  const s = t.selectionStart;
  const e = t.selectionEnd;
  t.value = t.value.slice(0, s) + text + t.value.slice(e);
  t.selectionStart = t.selectionEnd = s + text.length;
  t.focus();
  autoGrow();
}

function emojiPicker() {
  const r = $('#btnEmoji').getBoundingClientRect();
  const pop = $('#popover');
  pop.className = 'popover emoji-pop';
  const cats = Object.keys(EMOJI);
  let cur = cats[0];
  const draw = () => {
    pop.innerHTML = `<div class="emoji-tabs">${cats.map((c) => `<button data-cat="${c}" class="${c === cur ? 'on' : ''}">${c}</button>`).join('')}</div>
      <div class="emoji-grid">${EMOJI[cur].map((e) => `<button data-e="${e}">${e}</button>`).join('')}</div>`;
  };
  draw();
  pop.onclick = (e) => {
    const c = e.target.closest('[data-cat]');
    if (c) { cur = c.dataset.cat; draw(); return; }
    const b = e.target.closest('[data-e]');
    if (b) insertAtCursor(b.dataset.e);
  };
  pop.style.left = `${Math.max(8, r.right - 344)}px`;
  pop.style.top = `${r.top - 310}px`;
  pop.classList.remove('hidden');
}

// ------------------------------------------------------------------ popover menus
function showMenu(items, x, y) {
  const pop = $('#popover');
  pop.className = 'popover';
  pop.innerHTML = '';
  pop.onclick = null;
  for (const it of items) {
    if (it === '-') { pop.append(el('div', 'menu-sep')); continue; }
    const b = el('button', `menu-item${it.danger ? ' danger' : ''}`, `${it.icon || ''}<span>${esc(it.label)}</span>${it.checked ? '<span class="check">✓</span>' : ''}`);
    b.addEventListener('click', () => { hidePopover(); it.action(); });
    pop.append(b);
  }
  pop.style.left = '0px';
  pop.style.top = '0px';
  pop.classList.remove('hidden');
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.min(x, innerWidth - w - 8)}px`;
  pop.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
}

function hidePopover() {
  $('#popover').classList.add('hidden');
}

document.addEventListener('mousedown', (e) => {
  const pop = $('#popover');
  if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.closest('#btnEmoji, #me, #hdrMore')) hidePopover();
});

function statusMenu() {
  const r = $('#me').getBoundingClientRect();
  const dot = (s) => `<span class="sdot ${s}"></span>`;
  showMenu([
    ...['online', 'away', 'busy'].map((s) => ({
      icon: dot(s), label: s === 'busy' ? 'Busy – mute notifications' : statusText(s), checked: S.me.status === s,
      action: async () => { S.me = await call(api.setProfile({ status: s })) || S.me; renderMe(); },
    })),
    '-',
    { label: 'Edit profile and settings…', action: settingsModal },
  ], r.left, r.bottom + 4);
}

// ------------------------------------------------------------------ modals
function modal({ title, body, wide, buttons = [], onOpen }) {
  const back = el('div', 'modal-back');
  const m = el('div', `modal${wide ? ' wide' : ''}`);
  m.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close title="Close"><svg class="ico" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="modal-body">${body}</div>${buttons.length ? '<div class="modal-foot"></div>' : ''}`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
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
  const first = m.querySelector('input:not([type=checkbox]), textarea');
  if (first) first.focus();
  return { m, close };
}

function infoModal(title, html) {
  modal({ title, body: html, buttons: [{ label: 'Close', cls: 'primary' }] });
}

function confirmModal(title, text, label, action) {
  modal({ title, body: `<p style="margin:0;color:var(--muted)">${esc(text)}</p>`, buttons: [{ label: 'Cancel' }, { label, cls: 'danger', action }] });
}

function confirmClear(conv) {
  confirmModal('Clear chat history?', `All messages with ${convName(conv)} will be removed from this PC. This cannot be undone.`, 'Clear history', async () => {
    await call(api.clearConversation(conv));
    S.msgs.set(conv, []);
    S.hasMore.set(conv, false);
    if (S.active === conv) renderMessages(true);
  });
}

function confirmLeave(groupId) {
  const g = S.groups.get(groupId);
  confirmModal('Leave group?', `You will stop receiving messages from "${g ? g.name : 'this group'}".`, 'Leave group', async () => {
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
  if (!peers.length) return '<div class="empty-note">No one else is available to add yet.</div>';
  return `<div class="pick-list">${peers.map((p) => `
    <label class="pick">${avatarHtml('direct', p.id, p.name, p.online ? p.status : 'offline', 'sm')}
      <div class="pname"><div>${esc(p.name)}</div><div>${p.online ? statusText(p.status) : 'Offline'}${p.dept ? ` · ${esc(p.dept)}` : ''}</div></div>
      <input type="checkbox" value="${esc(p.id)}"></label>`).join('')}</div>`;
}

function newGroupModal() {
  modal({
    title: 'New group',
    body: `<div class="field"><label>Group name</label><input class="input" id="gName" maxlength="80" placeholder="e.g. Planning team"></div>
      <div class="field"><label>Members</label>${peopleChecklist()}</div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Create group', cls: 'primary', action: async (m) => {
          const name = $('#gName', m).value.trim();
          const members = [...m.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
          if (!name) { toast('Please give the group a name', 'error'); return false; }
          if (!members.length) { toast('Choose at least one person', 'error'); return false; }
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
    title: `Add people to ${g.name}`,
    body: peopleChecklist(new Set(g.members)),
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Add', cls: 'primary', action: async (m) => {
          const add = [...m.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
          if (!add.length) return true;
          await call(api.updateGroup(groupId, { addMembers: add }));
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
    title: 'Rename group',
    body: `<div class="field"><label>Group name</label><input class="input" id="gName" maxlength="80" value="${esc(g.name)}"></div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save', cls: 'primary', action: async (m) => {
          const name = $('#gName', m).value.trim();
          if (!name) return false;
          await call(api.updateGroup(groupId, { name }));
          return true;
        },
      },
    ],
  });
}

function searchModal() {
  modal({
    title: 'Find messages',
    wide: true,
    body: `<div class="field"><input class="input" id="sq" placeholder="Type at least 2 letters…"></div><div class="results" id="sres"></div>`,
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
          if (!results.length) { res.innerHTML = '<div class="empty-note">No messages found.</div>'; return; }
          const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          res.innerHTML = results.map((r, i) => {
            const text = r.msg.kind === 'file' ? `📎 ${r.msg.file.name}` : r.msg.text;
            const idx = text.toLowerCase().indexOf(q.toLowerCase());
            const snippet = text.slice(Math.max(0, idx - 40), idx + 120);
            return `<div class="result" data-i="${i}"><div class="rhead"><b>${esc(convName(r.conv))}</b><span>${esc(peerName(r.msg.from))}</span><span style="margin-left:auto">${new Date(r.msg.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
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
  }
}

function toggleRow(key, title, sub) {
  return `<label class="toggle-row"><div class="tl"><div>${title}</div>${sub ? `<div>${sub}</div>` : ''}</div>
    <span class="switch"><input type="checkbox" data-set="${key}" ${S.settings[key] ? 'checked' : ''}><span></span></span></label>`;
}

function settingsModal() {
  const me = S.me;
  const themes = [['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']];
  const body = `
    <div class="section-title">Your profile</div>
    <div class="field"><label>Display name</label><input class="input" id="sName" maxlength="60" value="${esc(me.name)}"></div>
    <div class="field"><label>Department or job title (optional)</label><input class="input" id="sDept" maxlength="60" value="${esc(me.dept)}" placeholder="e.g. Mine Planning"></div>

    <div class="section-title">Appearance</div>
    <div class="segmented" id="sTheme">${themes.map(([v, l]) => `<button data-v="${v}" class="${S.settings.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div>

    <div class="section-title">Notifications</div>
    ${toggleRow('notifications', 'Desktop notifications', 'Show a pop-up when a message arrives')}
    ${toggleRow('sound', 'Notification sound')}
    ${toggleRow('enterToSend', 'Press Enter to send', 'When off, use Ctrl + Enter to send')}

    <div class="section-title">Files</div>
    <div class="field"><label>Save received files to</label>
      <div class="row-inline"><input class="input" id="sDir" readonly value="${esc(S.settings.downloadDir)}"><button class="btn" id="sDirBtn">Change…</button></div></div>
    ${toggleRow('autoAccept', 'Download files automatically', `Files up to ${S.settings.autoAcceptMaxMB} MB download as soon as they arrive`)}

    <div class="section-title">Startup</div>
    ${S.platform === 'linux' ? '' : toggleRow('startWithWindows', 'Start when Windows starts', 'Opens quietly in the system tray')}
    ${toggleRow('minimizeToTray', 'Keep running in the tray when closed', 'So you never miss a message')}
    ${toggleRow('autoAway', 'Set me as Away when idle', 'After 5 minutes without mouse or keyboard activity')}

    <div class="section-title">Network</div>
    <div class="kv" style="margin-bottom:12px"><div>This PC</div><div>${esc((me.addresses || []).join(', ') || 'No network')}</div><div>Port</div><div>${me.port || '—'}</div><div>Version</div><div>${esc(S.version || '')}</div></div>
    <div class="field"><label>Add a computer by IP address</label>
      <div class="row-inline"><input class="input" id="sPeer" placeholder="e.g. 10.20.5.31"><button class="btn primary" id="sPeerBtn">Add</button></div>
      <div class="hint">Only needed for PCs on a different network segment that don't appear automatically.</div>
      <div class="tag-list" id="sPeers"></div></div>`;

  modal({
    title: 'Settings',
    wide: true,
    body,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Save', cls: 'primary', action: async (m) => {
          const name = $('#sName', m).value.trim();
          if (!name) { toast('Name cannot be empty', 'error'); return false; }
          const me2 = await call(api.setProfile({ name, dept: $('#sDept', m).value }));
          if (me2) S.me = me2;
          renderMe();
          toast('Settings saved');
          return true;
        },
      },
    ],
    onOpen: (m) => {
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
      $('#sDirBtn', m).addEventListener('click', async () => {
        const dir = await api.pickFolder();
        if (!dir) return;
        S.settings = await call(api.setSettings({ downloadDir: dir })) || S.settings;
        $('#sDir', m).value = dir;
      });
      const drawPeers = () => {
        $('#sPeers', m).innerHTML = S.manualPeers.map((p) => `<span class="tag">${esc(p)}<button data-rm="${esc(p)}" title="Remove">✕</button></span>`).join('');
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
        toast(res ? `Connected to ${S.peers.get(res)?.name || v}` : `Saved. Waiting for ${v} to answer – make sure LAN Messenger is running there.`);
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
    title: `Send image to ${convName(conv)}?`,
    body: `<img class="paste-preview" src="${url}">`,
    buttons: [
      { label: 'Cancel', action: () => URL.revokeObjectURL(url) },
      {
        label: 'Send', cls: 'primary', action: async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          await call(api.sendImageData(conv, bytes, blob.type === 'image/jpeg' ? 'jpg' : 'png'));
          URL.revokeObjectURL(url);
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
    const t = audioCtx.currentTime;
    for (const [freq, start] of [[880, 0], [1320, 0.09]]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.exponentialRampToValueAtTime(0.18, t + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.28);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + start);
      o.stop(t + start + 0.3);
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
      if (payload.id === S.active && payload.unread) markReadIfVisible();
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
      upsertMessage(conv, msg, isNew);
      if (isNew && conv === S.active && msg.from !== S.me.id) markReadIfVisible();
      break;
    }
    case 'file-progress':
      S.progress.set(payload.msgId, payload);
      updateProgressDom(payload);
      break;
    case 'typing':
      onTyping(payload);
      break;
    case 'me':
      S.me = { ...S.me, ...payload };
      renderMe();
      break;
    case 'open-conv':
      openConv(payload);
      break;
    case 'play-sound':
      playSound();
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
  $('#btnAttach').addEventListener('click', attachFiles);
  $('#btnEmoji').addEventListener('click', () => {
    if (!$('#popover').classList.contains('hidden') && $('#popover').classList.contains('emoji-pop')) hidePopover();
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
    if (paths.length) call(api.sendFiles(S.active, paths));
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

  // Drag & drop files onto the chat.
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
    if (paths.length) call(api.sendFiles(S.active, paths));
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#filter').focus();
      $('#filter').select();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchModal();
    } else if (e.key === 'Escape' && !$('#popover').classList.contains('hidden')) {
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
  S.peers = new Map(st.peers.map((p) => [p.id, p]));
  S.groups = new Map(st.groups.map((g) => [g.id, g]));
  S.convs = new Map(st.convs.map((c) => [c.id, c]));
  if (st.platform !== 'darwin') document.body.classList.add('overlay-controls');
  applyTheme();
  api.on(handleEvent);
  wire();
  renderMe();
  renderList();
}

boot();
