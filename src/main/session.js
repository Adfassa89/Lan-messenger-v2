'use strict';
// Which account this copy of the app runs as, and the screen to pick one.
// The last account used on this Windows user signs in by itself at start
// (its key is kept with Windows' own protection, DPAPI), with the window
// locked until the PIN is typed. Otherwise the sign-in screen is shown.

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { app, safeStorage, BrowserWindow, ipcMain, dialog } = require('electron');
const { Accounts, validPin } = require('../core/accounts');

// One folder for the whole PC, so every Windows user can use every account.
function accountsRoot() {
  if (process.env.LANMSG_ACCOUNTS) return path.resolve(process.env.LANMSG_ACCOUNTS);
  if (process.env.LANMSG_PROFILE) return path.join(path.resolve(process.env.LANMSG_PROFILE), 'accounts');
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'LAN Messenger 2', 'accounts');
  return path.join(app.getPath('userData'), 'accounts');
}

class Session {
  constructor({ legacyDir, onStart, preload, renderer, icon }) {
    this.legacyDir = legacyDir;
    this.onStart = onStart; // ({ id, key, name, locked }) => starts the messenger and the main window
    this.preload = preload;
    this.renderer = renderer;
    this.icon = icon;
    const root = accountsRoot();
    const fresh = !fs.existsSync(root);
    this.accounts = new Accounts(root);
    if (fresh && process.platform === 'win32') {
      // Let every Windows user of this PC read and write the accounts folder.
      execFile('icacls', [path.dirname(root), '/grant', '*S-1-5-32-545:(OI)(CI)M', '/T', '/Q'], { windowsHide: true }, () => {});
    }
    this.rememberFile = path.join(app.getPath('userData'), 'session.json');
    this.current = null; // { id, key, name }
    this.win = null;
    this.language = 'mn';
    try { this.language = JSON.parse(fs.readFileSync(this.rememberFile, 'utf8')).language || 'mn'; } catch { /* default */ }
  }

  // ---- remembering the last account on this Windows user ----
  _canProtect() { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } }
  remember(id, key, language) {
    let blob = null;
    if (this._canProtect()) blob = safeStorage.encryptString(key.toString('hex')).toString('base64');
    else if (!app.isPackaged) blob = `plain:${key.toString('hex')}`; // development and tests only
    const data = { id, blob, language: language || this.language };
    try { fs.writeFileSync(this.rememberFile, JSON.stringify(data)); } catch { /* not fatal */ }
  }
  forget() {
    try {
      const d = JSON.parse(fs.readFileSync(this.rememberFile, 'utf8'));
      fs.writeFileSync(this.rememberFile, JSON.stringify({ language: d.language || this.language }));
    } catch { /* nothing remembered */ }
  }
  _remembered() {
    try {
      const d = JSON.parse(fs.readFileSync(this.rememberFile, 'utf8'));
      if (!d.id || !d.blob) return null;
      if (!this.accounts.list().some((a) => a.id === d.id)) return null;
      let hex;
      if (d.blob.startsWith('plain:')) hex = app.isPackaged ? null : d.blob.slice(6);
      else hex = safeStorage.decryptString(Buffer.from(d.blob, 'base64'));
      if (!hex) return null;
      return { id: d.id, key: Buffer.from(hex, 'hex') };
    } catch { return null; }
  }

  // An update restart: a one-time ticket (protected like the remembered key,
  // valid for 3 minutes) lets the app come back unlocked if it was unlocked.
  resumeTicket(locked) {
    if (!this.current) return;
    const data = JSON.stringify({ id: this.current.id, until: Date.now() + 180000, locked: !!locked });
    let blob = null;
    if (this._canProtect()) blob = safeStorage.encryptString(data).toString('base64');
    else if (!app.isPackaged) blob = `plain:${data}`;
    if (blob) try { fs.writeFileSync(path.join(app.getPath('userData'), 'resume.json'), JSON.stringify({ blob })); } catch { /* not fatal */ }
  }
  _takeTicket() {
    const f = path.join(app.getPath('userData'), 'resume.json');
    try {
      const { blob } = JSON.parse(fs.readFileSync(f, 'utf8'));
      fs.rmSync(f, { force: true });
      const json = blob.startsWith('plain:') ? (app.isPackaged ? null : blob.slice(6)) : safeStorage.decryptString(Buffer.from(blob, 'base64'));
      const d = JSON.parse(json);
      return d && d.until > Date.now() ? d : null;
    } catch { return null; }
  }

  // An old profile (from before accounts) waits in this Windows user's folder.
  legacyName() {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(this.legacyDir, 'config.json'), 'utf8'));
      return c && typeof c === 'object' ? String(c.name || '') || ' ' : null;
    } catch { return null; }
  }

  // ---- start ----
  async begin() {
    this._ipc();
    const r = this.legacyName() === null ? this._remembered() : null;
    if (r) {
      try {
        this.accounts.claim(r.id);
        const acc = this.accounts.list().find((a) => a.id === r.id);
        const ticket = this._takeTicket();
        const locked = ticket && ticket.id === r.id ? ticket.locked : true;
        return this._start({ id: r.id, key: r.key, name: acc.name, locked });
      } catch { /* in use elsewhere: pick another */ }
    }
    this.showPicker();
    return undefined;
  }

  _start({ id, key, name, locked }) {
    this.current = { id, key, name };
    return this.onStart({ id, key, name, locked, dataDir: this.accounts.dir(id) });
  }

  // The main window is up: the sign-in screen can go.
  closePicker() {
    if (this.win && !this.win.isDestroyed()) { this.win.removeAllListeners('closed'); this.win.close(); }
    this.win = null;
  }

  showPicker() {
    if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); return; }
    this.win = new BrowserWindow({
      width: 760, height: 620, minWidth: 520, minHeight: 520, title: 'LAN Messenger 2', icon: this.icon,
      backgroundColor: '#0f1115', autoHideMenuBar: true,
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.win.removeMenu();
    this.win.loadFile(path.join(this.renderer, 'accounts.html'), { query: { lang: this.language } });
    this.win.on('closed', () => { this.win = null; if (!this.current) app.quit(); });
  }

  // Sign out and start again on the sign-in screen (the app restarts).
  signOut() {
    this.forget();
    if (this.current) this.accounts.release(this.current.id);
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
    app.quit();
  }

  // ---- what the pages may ask ----
  _ipc() {
    const h = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
      try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: err.message, waitUntil: err.waitUntil || 0 }; }
    });
    h('acc-list', () => ({
      accounts: this.accounts.list().map((a) => ({ ...a, inUse: !!this.accounts.inUseBy(a.id) })),
      full: this.accounts.full,
      legacy: this.legacyName(),
      language: this.language,
      current: this.current ? this.current.id : null,
    }));
    h('acc-create', (name, pin) => {
      const { id, key } = this.accounts.create(name, pin);
      this.accounts.claim(id);
      this.remember(id, key);
      return this._start({ id, key, name: String(name || '').trim(), locked: false, fresh: true });
    });
    h('acc-migrate', (pin) => {
      const name = (this.legacyName() || '').trim();
      const { id, key } = this.accounts.migrate(this.legacyDir, name, pin);
      this.accounts.claim(id);
      this.remember(id, key);
      return this._start({ id, key, name, locked: false });
    });
    h('acc-signin', (id, pin) => {
      const key = this.accounts.unlock(id, pin);
      this.accounts.claim(id);
      this.remember(id, key);
      const acc = this.accounts.list().find((a) => a.id === id);
      return this._start({ id, key, name: acc.name, locked: false });
    });
    h('acc-delete', (id, pin) => this.accounts.remove(id, pin));
    h('acc-request-delete', (id) => this.accounts.requestDelete(id));
    h('acc-cancel-delete', (id) => this.accounts.cancelDelete(id));
    h('acc-restore', async (pin) => {
      if (this.accounts.full) throw new Error('This PC already has 4 accounts');
      const r = await dialog.showOpenDialog(this.win || undefined, { title: 'Restore', filters: [{ name: 'LAN Messenger backup', extensions: ['lmbackup'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return null;
      const { id, key, name } = this.accounts.restore(r.filePaths[0], pin);
      this.accounts.claim(id);
      this.remember(id, key);
      return this._start({ id, key, name, locked: false });
    });
    // From the main window (signed in).
    h('acc-check', (pin) => { if (!this.current) throw new Error('Not signed in'); return this.accounts.check(this.current.id, pin); });
    h('acc-change-pin', (oldPin, newPin) => this.accounts.changePin(this.current.id, oldPin, newPin));
    h('acc-backup', async (pin) => {
      if (!validPin(pin)) throw new Error('Wrong PIN');
      const stamp = new Date().toISOString().slice(0, 10);
      const r = await dialog.showSaveDialog({ defaultPath: `${(this.current.name || 'account').replace(/[^\p{L}\p{N} _.-]/gu, '_')} ${stamp}.lmbackup`, filters: [{ name: 'LAN Messenger backup', extensions: ['lmbackup'] }] });
      if (r.canceled || !r.filePath) return null;
      if (this.beforeBackup) this.beforeBackup();
      this.accounts.backup(this.current.id, this.current.key, pin, r.filePath);
      return r.filePath;
    });
    h('acc-signout', () => this.signOut());
    h('acc-current', () => (this.current ? { id: this.current.id, name: this.current.name, count: this.accounts.list().length } : null));
  }
}

module.exports = { Session, accountsRoot };
