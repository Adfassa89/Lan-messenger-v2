'use strict';
// Electron main process: window, tray icon, notifications and the bridge
// between the user interface and the messenger core.

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell,
  nativeImage, nativeTheme, powerMonitor, clipboard,
} = require('electron');
const { Messenger } = require('../core/messenger');

const APP_ID = 'com.lanmessenger.v2';
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

// Lets developers run several copies on one PC for testing.
if (process.env.LANMSG_PROFILE) app.setPath('userData', path.resolve(process.env.LANMSG_PROFILE));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let messenger = null;
let quitting = false;
let activeConv = null;
let autoAway = false;
let unreadTotal = 0;
const thumbCache = new Map();
const startHidden = process.argv.includes('--hidden');

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

function themeColors() {
  const s = messenger.settings.theme;
  const dark = s === 'dark' || (s === 'system' && nativeTheme.shouldUseDarkColors);
  return dark
    ? { bg: '#0f1115', overlay: '#151821', symbol: '#e6e8ee' }
    : { bg: '#f4f6fb', overlay: '#ffffff', symbol: '#1d2433' };
}

function applyTitleBar() {
  if (!win || process.platform === 'darwin') return;
  const c = themeColors();
  try {
    win.setTitleBarOverlay({ color: c.overlay, symbolColor: c.symbol, height: 44 });
  } catch { /* not supported */ }
  win.setBackgroundColor(c.bg);
}

function createWindow() {
  const c = themeColors();
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 780,
    minHeight: 520,
    show: false,
    title: 'LAN Messenger',
    icon: appIcon(),
    backgroundColor: c.bg,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: c.overlay, symbolColor: c.symbol, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
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

  // Links open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function statusLabel(s) {
  return { online: 'Available', away: 'Away', busy: 'Busy (do not disturb)' }[s] || s;
}

function updateTray() {
  if (!tray) return;
  const status = messenger.config.status;
  tray.setToolTip(unreadTotal ? `LAN Messenger – ${unreadTotal} unread` : `LAN Messenger – ${statusLabel(status)}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open LAN Messenger', click: showWindow },
    { type: 'separator' },
    ...['online', 'away', 'busy'].map((s) => ({
      label: statusLabel(s),
      type: 'radio',
      checked: status === s,
      click: () => { autoAway = false; messenger.setProfile({ status: s }); },
    })),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
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

function convTitle(conv) {
  if (conv === 'broadcast') return 'Everyone';
  if (conv.startsWith('g:')) {
    const g = messenger.groups[conv.slice(2)];
    return g ? g.name : 'Group';
  }
  const p = messenger.peers.get(conv);
  return p ? p.name : 'Someone';
}

function notify(conv, msg) {
  const focused = win && win.isVisible() && win.isFocused();
  if (focused && activeConv === conv) return;
  if (win && !focused) win.flashFrame(true);
  if (!messenger.settings.notifications || messenger.config.status === 'busy') return;
  if (!Notification.isSupported()) return;
  const title = conv.startsWith('g:') || conv === 'broadcast' ? `${msg.fromName} · ${convTitle(conv)}` : msg.fromName;
  const body = msg.kind === 'file' ? `📎 Sent a file: ${msg.file.name}` : msg.text.slice(0, 200);
  const n = new Notification({ title, body, icon: appIcon(), silent: true });
  n.on('click', () => {
    showWindow();
    send('open-conv', conv);
  });
  n.show();
  if (messenger.settings.sound) send('play-sound');
}

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

function registerIpc() {
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...args) => fn(...args));

  h('init', () => ({ ...messenger.getState(), platform: process.platform, version: app.getVersion() }));
  h('load-messages', (conv, opts) => messenger.loadMessages(conv, opts));
  h('send-text', (conv, text) => messenger.sendText(conv, text));
  h('send-files', (conv, paths) => messenger.sendFiles(conv, paths));
  h('pick-files', async (conv) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return messenger.sendFiles(conv, r.filePaths);
  });
  h('send-image-data', (conv, bytes, ext) => {
    const dir = path.join(app.getPath('userData'), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `Screenshot ${stamp}.${ext === 'jpg' ? 'jpg' : 'png'}`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return messenger.sendFiles(conv, [file]);
  });
  h('accept-file', (conv, id) => messenger.acceptFile(conv, id));
  h('cancel-file', (conv, id) => messenger.cancelFile(conv, id));
  h('open-file', async (p) => {
    if (!p || !fs.existsSync(p)) return 'File not found. It may have been moved or deleted.';
    const err = await shell.openPath(p);
    return err || null;
  });
  h('show-in-folder', (p) => { if (p) shell.showItemInFolder(p); });
  h('open-external', (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
  h('copy-text', (t) => clipboard.writeText(String(t || '')));
  h('thumb', (p) => {
    if (!isImage(p)) return null;
    if (thumbCache.has(p)) return thumbCache.get(p);
    let img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (width > 640) img = img.resize({ width: 640, quality: 'good' });
    const url = img.toDataURL();
    thumbCache.set(p, { url, width, height });
    return thumbCache.get(p);
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
  h('set-settings', (patch) => {
    const s = messenger.setSettings(patch);
    if ('startWithWindows' in patch) applyLoginItem();
    if ('theme' in patch) {
      nativeTheme.themeSource = s.theme;
      applyTitleBar();
    }
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
  h('set-badge', (count, dataUrl) => {
    unreadTotal = count;
    updateTray();
    if (!win) return;
    if (process.platform === 'win32') {
      win.setOverlayIcon(count && dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count ? `${count} unread` : '');
    } else {
      app.setBadgeCount(count);
    }
  });
}

function wireEvents() {
  messenger.on('peers', (peers) => send('peers', peers));
  messenger.on('groups', (groups) => send('groups', groups));
  messenger.on('conv', (c) => send('conv', c));
  messenger.on('typing', (t) => send('typing', t));
  messenger.on('file-progress', (p) => send('file-progress', p));
  messenger.on('me', (me) => { send('me', me); updateTray(); });
  messenger.on('warning', (w) => console.warn(w));
  messenger.on('message', (e) => {
    send('message', e);
    if (e.isNew && e.incoming && e.msg.kind !== 'system') notify(e.conv, e.msg);
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  messenger = new Messenger({
    dataDir: app.getPath('userData'),
    downloadDir: path.join(app.getPath('downloads'), 'LAN Messenger'),
    appVersion: app.getVersion(),
  });
  nativeTheme.themeSource = messenger.settings.theme;
  nativeTheme.on('updated', applyTitleBar);
  registerIpc();
  wireEvents();
  try {
    await messenger.start();
  } catch (err) {
    dialog.showErrorBox('LAN Messenger', `Could not start networking: ${err.message}`);
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
  const done = () => { messenger.started = false; app.exit(0); };
  messenger.stop().then(done, done);
  setTimeout(done, 1500);
});

app.on('window-all-closed', () => {
  if (quitting || !messenger.settings.minimizeToTray) app.quit();
});

app.on('activate', showWindow);
