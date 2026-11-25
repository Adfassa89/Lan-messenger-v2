'use strict';
/* global api, I18N */
// The sign-in screen: up to 4 accounts on this PC, each with a 4 – 6 digit PIN.

const params = new URLSearchParams(location.search);
let lang = params.get('lang') || 'mn';
const t = (k, v) => I18N.translate(lang, k, v);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let state = { accounts: [], full: false, legacy: null };
let skipLegacy = false; // "Use an existing account" on the move-your-chats screen

function color(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const p = [['#4f63f5', '#7c5cf6'], ['#0ea5e9', '#2563eb'], ['#10b981', '#059669'], ['#f59e0b', '#ea580c'], ['#ef4444', '#db2777'], ['#8b5cf6', '#6d28d9']];
  const [a, b] = p[h % p.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}
const avatar = (a) => `<div class="av" style="background:${color(a.id || a.name)}">${a.avatar ? `<img src="${esc(a.avatar)}" alt="">` : esc(initials(a.name))}</div>`;

async function refresh() {
  const r = await api.accList();
  if (r.ok) state = r.value;
  lang = state.language || lang;
  for (const e of document.querySelectorAll('[data-t]')) e.textContent = t(e.dataset.t);
}

// What a call to the main process says went wrong, in words.
function problem(r) {
  if (r.waitUntil && r.waitUntil > Date.now()) return t('Too many wrong PINs. Try again in {n} s.', { n: Math.ceil((r.waitUntil - Date.now()) / 1000) });
  return t(r.error || 'Something went wrong');
}

// A PIN box that only takes digits.
function pinInput(id, ph) {
  return `<input class="in pin" id="${id}" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="${esc(ph || '••••')}">`;
}
function digitsOnly(root) {
  for (const i of root.querySelectorAll('input.pin')) i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, '').slice(0, 6); });
}
const okPin = (p) => /^\d{4,6}$/.test(p);

// ------------------------------------------------------------------ views
function home() {
  const v = $('view');
  const legacyWaiting = state.legacy !== null && state.legacy !== undefined;
  if (legacyWaiting && !skipLegacy) return migrateView();
  const tiles = state.accounts.map((a) => `
    <button class="acc" data-acc="${esc(a.id)}">
      <span class="more" data-more="${esc(a.id)}" title="${esc(t('More'))}">⋯</span>
      ${avatar(a)}<b>${esc(a.name)}</b>
      ${a.inUse ? `<small>${esc(t('Signed in on another Windows user'))}</small>` : ''}
    </button>`).join('');
  v.innerHTML = `<h2>${esc(state.accounts.length ? t('Who is using LAN Messenger?') : t('Create your account'))}</h2>
    <p class="sub">${esc(state.accounts.length ? t('Pick your account and type your PIN.') : t('Accounts belong to this app only (not Windows or e-mail). Up to 4 people can have one on this PC.'))}</p>
    <div class="accounts">${tiles}${state.full ? '' : `<button class="acc add" data-new><div class="av">+</div><b>${esc(t('New account'))}</b><small>${esc(t('{n} of 4', { n: state.accounts.length }))}</small></button>`}</div>
    <div class="row">${legacyWaiting && !state.full ? `<button class="btn" data-legacy>${esc(t('Move my old chats ({name})', { name: (state.legacy || '').trim() || '…' }))}</button>` : ''}<span class="grow"></span>${state.full ? '' : `<button class="btn" data-restore>${esc(t('Restore from backup'))}</button>`}</div>`;
  $('note').textContent = t('Your chats are encrypted with your PIN. Without the PIN or a backup they cannot be recovered.');
  v.onclick = (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); return menu(more.dataset.more, more); }
    const a = e.target.closest('[data-acc]');
    if (a) return signInView(state.accounts.find((x) => x.id === a.dataset.acc));
    if (e.target.closest('[data-new]')) return createView();
    if (e.target.closest('[data-restore]')) return restoreView();
    if (e.target.closest('[data-legacy]')) { skipLegacy = false; return migrateView(); }
    return undefined;
  };
}

function signInView(a) {
  const v = $('view');
  v.innerHTML = `<div class="who">${avatar(a)}<div><h2>${esc(a.name)}</h2><p class="sub" style="margin:0">${esc(t('Type your PIN'))}</p></div></div>
    ${pinInput('pin')}<div class="err" id="err"></div>
    <div class="row"><button class="btn" data-back>${esc(t('Back'))}</button><span class="grow"></span><button class="btn primary" data-go>${esc(t('Sign in'))}</button></div>`;
  digitsOnly(v);
  const go = async () => {
    const pin = $('pin').value;
    if (!okPin(pin)) { $('err').textContent = t('The PIN must be 4 to 6 digits'); return; }
    busy(true);
    const r = await api.accSignin(a.id, pin);
    busy(false);
    if (!r.ok) { $('err').textContent = problem(r); $('pin').value = ''; $('pin').focus(); }
  };
  $('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  v.onclick = (e) => { if (e.target.closest('[data-back]')) home(); else if (e.target.closest('[data-go]')) go(); };
  $('pin').focus();
}

function pinPairHtml() {
  return `<label class="f">${esc(t('PIN (4 to 6 digits)'))}</label>${pinInput('pin1')}
    <label class="f">${esc(t('Type the PIN again'))}</label>${pinInput('pin2')}<div class="err" id="err"></div>`;
}
function readPinPair() {
  const a = $('pin1').value;
  const b = $('pin2').value;
  if (!okPin(a)) { $('err').textContent = t('The PIN must be 4 to 6 digits'); return null; }
  if (a !== b) { $('err').textContent = t('The two PINs are not the same'); return null; }
  return a;
}

function createView() {
  const v = $('view');
  v.innerHTML = `<h2>${esc(t('New account'))}</h2><p class="sub">${esc(t('Your name as colleagues will see it, and a PIN only you know.'))}</p>
    <label class="f">${esc(t('Your name'))}</label><input class="in" id="name" maxlength="60" placeholder="${esc(t('e.g. Bat-Erdene, Mine planning'))}">
    ${pinPairHtml()}
    <div class="row"><button class="btn" data-back>${esc(t('Back'))}</button><span class="grow"></span><button class="btn primary" data-go>${esc(t('Create account'))}</button></div>`;
  digitsOnly(v);
  v.onclick = async (e) => {
    if (e.target.closest('[data-back]')) return home();
    if (!e.target.closest('[data-go]')) return undefined;
    const name = $('name').value.trim();
    if (!name) { $('err').textContent = t('Please enter your name'); return undefined; }
    const pin = readPinPair();
    if (!pin) return undefined;
    busy(true);
    const r = await api.accCreate(name, pin);
    busy(false);
    if (!r.ok) $('err').textContent = problem(r);
    return undefined;
  };
  $('name').focus();
}

// After the update: the profile from before becomes account 1, with a PIN.
function migrateView() {
  const v = $('view');
  const name = (state.legacy || '').trim();
  v.innerHTML = `<h2>${esc(name ? t('Welcome back, {name}', { name }) : t('Welcome back'))}</h2>
    <p class="sub">${esc(t('LAN Messenger now has accounts. Your chats, groups and photo stay; choose a PIN to protect them. You will type it to unlock the app or switch account.'))}</p>
    ${state.full ? `<div class="err">${esc(t('This PC already has 4 accounts. Delete one before your chats can be moved.'))}</div>` : pinPairHtml()}
    <div class="row">${state.accounts.length ? `<button class="btn" data-skip>${esc(t('Use an existing account'))}</button>` : ''}<span class="grow"></span>${state.full ? '' : `<button class="btn primary" data-go>${esc(t('Protect my chats'))}</button>`}</div>`;
  $('note').textContent = t('Your chats are encrypted with your PIN. Without the PIN or a backup they cannot be recovered.');
  digitsOnly(v);
  v.onclick = async (e) => {
    if (e.target.closest('[data-skip]')) { skipLegacy = true; home(); return; }
    if (!e.target.closest('[data-go]')) return;
    const pin = readPinPair();
    if (!pin) return;
    busy(true);
    const r = await api.accMigrate(pin);
    busy(false);
    if (!r.ok) $('err').textContent = problem(r);
  };
  if ($('pin1')) $('pin1').focus();
}

function restoreView() {
  const v = $('view');
  v.innerHTML = `<h2>${esc(t('Restore from backup'))}</h2><p class="sub">${esc(t('Type the PIN the account had when the backup was made, then choose the backup file.'))}</p>
    ${pinInput('pin')}<div class="err" id="err"></div>
    <div class="row"><button class="btn" data-back>${esc(t('Back'))}</button><span class="grow"></span><button class="btn primary" data-go>${esc(t('Choose the backup file…'))}</button></div>`;
  digitsOnly(v);
  v.onclick = async (e) => {
    if (e.target.closest('[data-back]')) return home();
    if (!e.target.closest('[data-go]')) return undefined;
    const pin = $('pin').value;
    if (!okPin(pin)) { $('err').textContent = t('The PIN must be 4 to 6 digits'); return undefined; }
    busy(true);
    const r = await api.accRestore(pin);
    busy(false);
    if (!r.ok) $('err').textContent = problem(r);
    return undefined;
  };
  $('pin').focus();
}

// ⋯ on an account: delete it (at once, after a confirmation).
function menu(id, anchor) {
  closeMenu();
  const a = state.accounts.find((x) => x.id === id);
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = `<button data-k="delete" class="danger">🗑 ${esc(t('Delete account'))}</button>`;
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${r.bottom + 4}px`;
  m.onclick = (e) => {
    if (!e.target.closest('[data-k]')) return;
    closeMenu();
    deleteView(a);
  };
  setTimeout(() => document.addEventListener('mousedown', closeMenu, { once: true }), 0);
}
function closeMenu(e) {
  const m = document.querySelector('.menu');
  if (m && (!e || !m.contains(e.target))) m.remove();
}
async function done(p) {
  const r = await p;
  if (!r.ok) alert(problem(r));
  await refresh();
  home();
}

function deleteView(a) {
  const v = $('view');
  v.innerHTML = `<div class="who">${avatar(a)}<div><h2>${esc(t('Delete {name}?', { name: a.name }))}</h2><p class="sub" style="margin:0">${esc(t('The account and all its chats are deleted from this PC for good. They cannot be brought back unless a backup was made.'))}</p></div></div>
    <div class="err" id="err"></div>
    <div class="row"><button class="btn" data-back>${esc(t('Back'))}</button><span class="grow"></span><button class="btn danger" data-go>🗑 ${esc(t('Delete account'))}</button></div>`;
  v.onclick = async (e) => {
    if (e.target.closest('[data-back]')) return home();
    if (!e.target.closest('[data-go]')) return undefined;
    busy(true);
    const r = await api.accDelete(a.id);
    busy(false);
    if (!r.ok) { $('err').textContent = problem(r); return undefined; }
    await refresh();
    home();
    return undefined;
  };
}

function busy(on) { for (const b of document.querySelectorAll('.btn')) b.disabled = on; }

refresh().then(home);
