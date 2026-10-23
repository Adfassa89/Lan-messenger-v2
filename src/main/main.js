'use strict';
// Electron main process: windows, tray icon, notifications and the bridge
// between the user interface and the messenger core.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell,
  nativeImage, nativeTheme, powerMonitor, clipboard, desktopCapturer, screen, session,
} = require('electron');
const { Messenger, preview } = require('../core/messenger');
const { Updater } = require('./updater');
const I18N = require('../shared/i18n');

const APP_ID = 'com.lanmessenger.v2';
const APP_NAME = 'LAN Messenger 2';
const VERSION = require('../../package.json').version;
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const MEDIA_MAX = 30 * 1024 * 1024;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId(APP_ID);
// Show real LAN addresses to screen-sharing peers instead of mDNS names,
// which many office networks cannot resolve.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Alert and notification sounds must play even before anyone clicks in the app.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let tray = null;
let messenger = null;
let updater = null;
let quitting = false;
let activeConv = null;
let autoAway = false;
let unreadTotal = 0;
let updateReady = null;
let shareSourceId = null;
const thumbCache = new Map();
const alertWindows = new Map(); // msgId -> BrowserWindow
const rtcRoutes = new Map(); // sid -> webContents of a viewer window
const startHidden = process.argv.includes('--hidden');

const t = (key, vars) => I18N.translate(messenger ? messenger.settings.language : 'en', key, vars);

function appIcon() {
  const img = nativeImage.createFromPath(ICON);
  return img.isEmpty() ? undefined : img;
}

function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('evt', { type, payload });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function isDark() {
  const s = messenger.settings.theme;
  return s === 'dark' || (s === 'system' && nativeTheme.shouldUseDarkColors);
}

function themeColors() {
  return isDark()
    ? { bg: '#0f1115', overlay: '#161922', symbol: '#e6e8ee' }
    : { bg: '#f4f6fb', overlay: '#ffffff', symbol: '#1d2433' };
}

const webPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function guardNavigation(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createWindow() {
  const c = themeColors();
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 800,
    minHeight: 540,
    show: false,
    title: APP_NAME,
    icon: appIcon(),
    backgroundColor: c.bg,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: c.overlay, symbolColor: c.symbol, height: 44 },
    webPreferences: { ...webPreferences, spellcheck: true },
  });
  win.removeMenu();
  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && messenger.settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { win = null; });
  guardNavigation(win);
}

// ------------------------------------------------------------------ tray
function statusLabel(s) {
  return { online: t('Available'), away: t('Away'), busy: t('Busy (do not disturb)') }[s] || s;
}

function updateTray() {
  if (!tray) return;
  const status = messenger.config.status;
  tray.setToolTip(unreadTotal
    ? `${APP_NAME} – ${t('{n} unread', { n: unreadTotal })}`
    : `${APP_NAME} – ${statusLabel(status)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('Open LAN Messenger 2'), click: showWindow },
    ...(updateReady ? [{ label: t('Restart to update to {v}', { v: updateReady }), click: restartForUpdate }] : []),
    { type: 'separator' },
    ...['online', 'away', 'busy'].map((s) => ({
      label: statusLabel(s),
      type: 'radio',
      checked: status === s,
      click: () => { autoAway = false; messenger.setProfile({ status: s }); },
    })),
    { type: 'separator' },
    { label: t('Quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const icon = appIcon();
  if (!icon) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

// ------------------------------------------------------------------ notifications & alerts
function convTitle(conv) {
  if (conv === 'broadcast') return t('Everyone');
  if (conv.startsWith('g:')) {
    const g = messenger.groups[conv.slice(2)];
    return g ? g.name : t('Group');
  }
  const p = messenger.peers.get(conv);
  return p ? p.name : t('Someone');
}

function notify(conv, msg) {
  const focused = win && win.isVisible() && win.isFocused();
  if (focused && activeConv === conv) return;
  if (win && !focused) win.flashFrame(true);
  if (!messenger.settings.notifications || messenger.config.status === 'busy') return;
  if (!Notification.isSupported()) return;
  const title = conv.startsWith('g:') || conv === 'broadcast' ? `${msg.fromName} · ${convTitle(conv)}` : msg.fromName;
  let body = preview(msg);
  if (msg.kind === 'file') body = msg.file.voice ? `🎤 ${t('Voice message')}` : `${msg.file.folder ? '📁' : '📎'} ${msg.file.name}`;
  const n = new Notification({ title, body: body.slice(0, 200), icon: appIcon(), silent: true });
  n.on('click', () => {
    showWindow();
    send('open-conv', conv);
  });
  n.show();
  if (messenger.settings.sound) send('play-sound');
}

// Urgent alerts get their own always-on-top window that stays until acknowledged.
function showAlert(conv, msg) {
  if (alertWindows.has(msg.id)) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = 560;
  const h = 420;
  const offset = alertWindows.size * 28;
  const alertWin = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(display.workArea.x + (display.workArea.width - w) / 2) + offset,
    y: Math.round(display.workArea.y + (display.workArea.height - h) / 2) + offset,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: t('Urgent alert'),
    icon: appIcon(),
    backgroundColor: '#b91c1c',
    webPreferences,
  });
  alertWin.setAlwaysOnTop(true, 'screen-saver');
  alertWin.loadFile(path.join(RENDERER, 'alert.html'), { query: { conv, id: msg.id } });
  alertWin.once('ready-to-show', () => {
    alertWin.show();
    alertWin.flashFrame(true);
  });
  alertWin.on('closed', () => alertWindows.delete(msg.id));
  guardNavigation(alertWin);
  alertWindows.set(msg.id, alertWin);
}

function closeAlert(msgId) {
  const w = alertWindows.get(msgId);
  if (w && !w.isDestroyed()) w.close();
}

// ------------------------------------------------------------------ screen sharing
function openViewer(peerId, sid, name) {
  const viewer = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 480,
    minHeight: 320,
    title: t("{name}'s screen", { name }),
    icon: appIcon(),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences,
  });
  viewer.removeMenu();
  viewer.loadFile(path.join(RENDERER, 'viewer.html'), { query: { peer: peerId, sid, name, lang: messenger.settings.language } });
  rtcRoutes.set(sid, viewer.webContents);
  viewer.on('closed', () => {
    rtcRoutes.delete(sid);
    messenger.sendRtc(peerId, sid, { kind: 'end' });
  });
  guardNavigation(viewer);
}

function routeRtc(e) {
  const target = rtcRoutes.get(e.sid);
  if (target && !target.isDestroyed()) target.send('evt', { type: 'rtc', payload: e });
  else send('rtc', e);
}

function setupMediaPermissions() {
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find((s) => s.id === shareSourceId) || sources.find((s) => s.id.startsWith('screen'));
      cb(src ? { video: src } : {});
    } catch {
      cb({});
    }
  });
}

// ------------------------------------------------------------------ misc helpers
function checkIdle() {
  if (!messenger.settings.autoAway) return;
  const idle = powerMonitor.getSystemIdleTime();
  const status = messenger.config.status;
  if (idle >= 300 && status === 'online') {
    autoAway = true;
    messenger.setProfile({ status: 'away' });
  } else if (idle < 30 && autoAway && status === 'away') {
    autoAway = false;
    messenger.setProfile({ status: 'online' });
  }
}

function applyLoginItem() {
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: !!messenger.settings.startWithWindows, args: ['--hidden'] });
}

function isImage(p) {
  return IMAGE_EXT.has(path.extname(p || '').toLowerCase());
}

function attachmentPath(prefix, ext) {
  const dir = path.join(app.getPath('userData'), 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', ' ').slice(0, 19);
  return path.join(dir, `${prefix} ${stamp}.${ext}`);
}

function restartForUpdate() {
  quitting = true;
  app.relaunch();
  app.quit();
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function messageLine(m) {
  if (m.deleted) return `🚫 ${t('This message was deleted')}`;
  if (m.kind === 'poll') {
    const votes = m.poll.votes || {};
    const counts = m.poll.options.map((o, i) => `${o} (${Object.values(votes).filter((v) => v.includes(i)).length})`);
    return `📊 ${m.poll.question}: ${counts.join(', ')}`;
  }
  if (m.kind === 'file') return m.file.voice ? `🎤 ${t('Voice message')}` : `${m.file.folder ? '📁' : '📎'} ${m.file.name}`;
  return `${m.urgent ? '🚨 ' : ''}${m.text}`;
}

async function exportChat(conv, format) {
  const title = convTitle(conv);
  const safe = title.replace(/[<>:"/\\|?*]/g, '_');
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), `${safe} chat.${format === 'pdf' ? 'pdf' : 'txt'}`),
    filters: format === 'pdf' ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Text', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const msgs = messenger.loadMessages(conv, { limit: 1e9 });
  const who = (m) => (m.from === messenger.id ? messenger.config.name : m.fromName);
  if (format !== 'pdf') {
    const lines = [`${t('Chat with {name}', { name: title })} – ${new Date().toLocaleString()}`, ''];
    for (const m of msgs) lines.push(`[${new Date(m.ts).toLocaleString()}] ${m.kind === 'system' ? '' : `${who(m)}: `}${messageLine(m)}`);
    fs.writeFileSync(r.filePath, `﻿${lines.join('\r\n')}`, 'utf8');
    return r.filePath;
  }
  const rows = msgs.map((m) => (m.kind === 'system'
    ? `<div class="sys">${escHtml(m.text)}</div>`
    : `<div class="m"><div class="h"><b>${escHtml(who(m))}</b><span>${escHtml(new Date(m.ts).toLocaleString())}</span></div><div class="t">${escHtml(messageLine(m))}</div></div>`)).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font:12px "Segoe UI",Arial,sans-serif;color:#1d2433;margin:28px}
    h1{font-size:18px;margin:0 0 4px} .sub{color:#6b7487;margin-bottom:18px}
    .m{padding:7px 0;border-bottom:1px solid #eceff5;page-break-inside:avoid}
    .h{display:flex;gap:10px;align-items:baseline} .h span{color:#8a93a5;font-size:10.5px}
    .t{white-space:pre-wrap;margin-top:2px} .sys{color:#6b7487;text-align:center;padding:6px;font-style:italic}
  </style><h1>${escHtml(t('Chat with {name}', { name: title }))}</h1>
  <div class="sub">${APP_NAME} · ${escHtml(new Date().toLocaleString())} · ${msgs.length} ${escHtml(t('messages'))}</div>${rows}`;
  const tmp = path.join(app.getPath('temp'), `lanmsg-export-${crypto.randomUUID()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await pdfWin.loadFile(tmp);
    const pdf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
    fs.writeFileSync(r.filePath, pdf);
  } finally {
    pdfWin.destroy();
    fs.rmSync(tmp, { force: true });
  }
  return r.filePath;
}

async function captureScreen() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const wasVisible = win && win.isVisible() && !win.isMinimized();
  if (wasVisible) {
    win.hide();
    await new Promise((r) => setTimeout(r, 350));
  }
  try {
    const size = {
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    return src ? src.thumbnail.toDataURL() : null;
  } finally {
    if (wasVisible) showWindow();
  }
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...args) => fn(...args));

  h('init', () => ({
    ...messenger.getState(), platform: process.platform, version: VERSION, updateReady,
  }));
  h('load-messages', (conv, opts) => messenger.loadMessages(conv, opts));
  h('get-message', (conv, id) => {
    const msg = messenger.store.getMessage(conv, id);
    return msg ? { msg, convTitle: convTitle(conv), language: messenger.settings.language } : null;
  });
  h('send-text', (conv, text, opts) => messenger.sendText(conv, text, opts));
  h('send-files', (conv, paths, opts) => messenger.sendFiles(conv, paths, opts));
  h('pick-files', async (conv, opts) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return messenger.sendFiles(conv, r.filePaths, opts);
  });
  h('pick-send-folder', async (conv) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return messenger.sendFolder(conv, r.filePaths[0]);
  });
  h('send-image-data', (conv, bytes, ext, opts) => {
    const file = attachmentPath('Screenshot', ext === 'jpg' ? 'jpg' : 'png');
    fs.writeFileSync(file, Buffer.from(bytes));
    return messenger.sendFiles(conv, [file], opts);
  });
  h('send-voice', (conv, bytes, duration, opts) => {
    const file = attachmentPath('Voice message', 'webm');
    fs.writeFileSync(file, Buffer.from(bytes));
    return messenger.sendFiles(conv, [file], { ...opts, voice: true, duration });
  });
  h('read-media', (p) => {
    if (!p || !fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > MEDIA_MAX) return null;
    return `data:audio/webm;base64,${fs.readFileSync(p).toString('base64')}`;
  });
  h('read-image', (p) => {
    if (!isImage(p) || !fs.existsSync(p)) return null;
    const img = nativeImage.createFromPath(p);
    return img.isEmpty() ? null : img.toDataURL();
  });
  h('accept-file', (conv, id) => messenger.acceptFile(conv, id));
  h('cancel-file', (conv, id) => messenger.cancelFile(conv, id));
  h('open-file', async (p) => {
    if (!p || !fs.existsSync(p)) return t('File not found. It may have been moved or deleted.');
    const err = await shell.openPath(p);
    return err || null;
  });
  h('show-in-folder', (p) => { if (p) shell.showItemInFolder(p); });
  h('open-external', (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
  h('copy-text', (text) => clipboard.writeText(String(text || '')));
  h('thumb', (p) => {
    if (!isImage(p)) return null;
    if (thumbCache.has(p)) return thumbCache.get(p);
    let img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (width > 640) img = img.resize({ width: 640, quality: 'good' });
    const info = { url: img.toDataURL(), width, height };
    thumbCache.set(p, info);
    return info;
  });
  h('mark-read', (conv) => messenger.markRead(conv));
  h('typing', (conv) => messenger.sendTyping(conv));
  h('active-conv', (conv) => { activeConv = conv; });
  h('set-profile', (p) => {
    autoAway = false;
    messenger.setProfile(p);
    updateTray();
    return messenger.getState().me;
  });
  h('pick-avatar', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: t('Pictures'), extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    let img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) throw new Error(t('This picture could not be opened'));
    const { width, height } = img.getSize();
    const side = Math.min(width, height);
    img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
      .resize({ width: 160, height: 160, quality: 'best' });
    const data = `data:image/jpeg;base64,${img.toJPEG(85).toString('base64')}`;
    messenger.setAvatar(data);
    return data;
  });
  h('remove-avatar', () => messenger.setAvatar(null));
  h('set-settings', (patch) => {
    const s = messenger.setSettings(patch);
    if ('startWithWindows' in patch) applyLoginItem();
    // The page re-sends its title bar colors after a theme or style change.
    if ('theme' in patch) nativeTheme.themeSource = s.theme;
    if ('language' in patch) updateTray();
    return s;
  });
  h('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  h('create-group', (name, members) => messenger.createGroup(name, members));
  h('update-group', (id, patch) => messenger.updateGroup(id, patch));
  h('leave-group', (id) => messenger.leaveGroup(id));
  h('search', (q) => messenger.search(q));
  h('add-peer', (entry) => messenger.addManualPeer(entry));
  h('remove-peer', (entry) => messenger.removeManualPeer(entry));
  h('forget-contact', (id) => messenger.forgetContact(id));
  h('delete-message', (conv, id) => messenger.deleteMessage(conv, id));
  h('clear-conversation', (conv) => messenger.clearConversation(conv));
  h('react', (conv, id, emoji) => messenger.react(conv, id, emoji));
  h('edit-message', (conv, id, text) => messenger.editMessage(conv, id, text));
  h('unsend-message', (conv, id) => messenger.unsendMessage(conv, id));
  h('pin-message', (conv, id, on) => messenger.pinMessage(conv, id, on));
  h('create-poll', (conv, q, options, multi) => messenger.createPoll(conv, q, options, multi));
  h('vote', (conv, id, choices) => messenger.vote(conv, id, choices));
  h('ack-urgent', (conv, id) => {
    messenger.ackUrgent(conv, id);
    closeAlert(id);
  });
  h('schedule-message', (conv, text, at, opts) => messenger.scheduleMessage(conv, text, at, opts));
  h('cancel-scheduled', (id) => messenger.cancelScheduled(id));
  h('export-chat', (conv, format) => exportChat(conv, format));
  h('capture-screen', () => captureScreen());
  h('share-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
    return sources
      .filter((s) => !s.name.endsWith(APP_NAME))
      .map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen'), thumb: s.thumbnail.toDataURL() }));
  });
  h('share-select', (id) => { shareSourceId = id; });
  h('rtc-send', (peerId, sid, data) => messenger.sendRtc(peerId, sid, data));
  h('open-viewer', (peerId, sid, name) => openViewer(peerId, sid, name));
  h('open-conv', (conv) => {
    showWindow();
    send('open-conv', conv);
  });
  h('restart-update', () => restartForUpdate());
  // The page reports its current colors so the window buttons match the style.
  h('set-title-bar', (panel, text, bg) => {
    if (!win || process.platform === 'darwin') return;
    const hex = /^#[0-9a-f]{3,8}$/i;
    try {
      if (hex.test(panel) && hex.test(text)) win.setTitleBarOverlay({ color: panel, symbolColor: text, height: 44 });
      if (hex.test(bg)) win.setBackgroundColor(bg);
    } catch { /* not supported */ }
  });
  h('set-badge', (count, dataUrl) => {
    unreadTotal = count;
    updateTray();
    if (!win) return;
    if (process.platform === 'win32') {
      win.setOverlayIcon(count && dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count ? t('{n} unread', { n: count }) : '');
    } else {
      app.setBadgeCount(count);
    }
  });
}

function wireEvents() {
  messenger.on('peers', (peers) => send('peers', peers));
  messenger.on('groups', (groups) => send('groups', groups));
  messenger.on('conv', (c) => send('conv', c));
  messenger.on('typing', (e) => send('typing', e));
  messenger.on('file-progress', (p) => send('file-progress', p));
  messenger.on('avatar', (a) => send('avatar', a));
  messenger.on('scheduled', (list) => send('scheduled', list));
  messenger.on('rtc', routeRtc);
  messenger.on('me', (me) => { send('me', me); updateTray(); });
  messenger.on('warning', (w) => console.warn(w));
  messenger.on('message', (e) => {
    send('message', e);
    if (!e.isNew || !e.incoming || e.msg.kind === 'system') return;
    if (e.msg.urgent) {
      showAlert(e.conv, e.msg);
      if (win && !win.isFocused()) win.flashFrame(true);
    } else {
      notify(e.conv, e.msg);
    }
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  messenger = new Messenger({
    dataDir: app.getPath('userData'),
    downloadDir: path.join(app.getPath('downloads'), APP_NAME),
    appVersion: VERSION,
  });
  nativeTheme.themeSource = messenger.settings.theme;
  setupMediaPermissions();
  registerIpc();
  wireEvents();
  updater = new Updater(messenger, {
    version: VERSION,
    onReady: (v) => {
      updateReady = v;
      send('update-ready', v);
      updateTray();
    },
  });
  try {
    await updater.start();
  } catch (err) {
    console.warn('Updater:', err);
  }
  try {
    await messenger.start();
  } catch (err) {
    dialog.showErrorBox(APP_NAME, `${t('Could not start networking')}: ${err.message}`);
  }
  createWindow();
  createTray();
  applyLoginItem();
  setInterval(checkIdle, 30000);
  powerMonitor.on('resume', () => messenger.discovery && messenger.discovery.query());
});

app.on('before-quit', () => { quitting = true; });

app.on('will-quit', (e) => {
  if (!messenger || !messenger.started) return;
  e.preventDefault();
  if (updater) updater.stop();
  const done = () => { messenger.started = false; app.exit(0); };
  messenger.stop().then(done, done);
  setTimeout(done, 1500);
});

app.on('window-all-closed', () => {
  if (quitting || !messenger.settings.minimizeToTray) app.quit();
});

app.on('activate', showWindow);
