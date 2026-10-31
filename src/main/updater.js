'use strict';
// Shares app updates between PCs. When another PC runs a newer signed
// version, this PC downloads it from them, checks the signature, and offers
// to restart into it. No internet or IT visit needed.
// When the PC has internet access it can also take the same signed package
// from the project's Releases page on GitHub.

const path = require('path');
const { app, net } = require('electron');
const { compareVersions, verifyMeta, sha256File } = require('../core/update');
const PUBLIC_KEY = require('./update-key');

const CHECK_INTERVAL = 60000;
const INTERNET_INTERVAL = 6 * 3600000;
const RELEASES_URL = 'https://api.github.com/repos/Adfassa89/Lan-messenger-v2/releases/latest';

class Updater {
  // onStatus(status) is called whenever the update status changes, so the
  // Settings window can show what is happening.
  constructor(messenger, { version, onReady, onStatus, releasesUrl = RELEASES_URL }) {
    this.m = messenger;
    this.releasesUrl = releasesUrl;
    this.internetAt = 0;
    this.version = version;
    this.onReady = onReady;
    this.onStatus = onStatus || (() => {});
    // state: idle | checking | none | downloading | ready | error | dev
    this.status = { state: 'idle', checkedAt: 0 };
    this.ofs = require('original-fs');
    this.dir = path.join(app.getPath('userData'), 'updates');
    this.busy = false;
    this.staged = null; // version downloaded and waiting for restart
    this.failed = new Map(); // version -> time of last failure
    this.em = process.versions.electron.split('.')[0];
  }

  async start() {
    this.m.infoExtras.em = this.em;
    await this._offerOwnPackage();
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL);
    setTimeout(() => this.check(), 15000);
    // Running fine for a while: reset the crash counter of a booted update.
    setTimeout(() => this._markHealthy(), 30000);
  }

  stop() {
    clearInterval(this.timer);
  }

  // The package we are running from, if it carries a valid signature.
  async _offerOwnPackage() {
    if (!app.isPackaged) return;
    const boot = global.lanmsgBoot;
    let asar;
    let meta;
    try {
      if (boot) {
        asar = boot.asar;
        meta = boot.meta;
      } else {
        asar = path.join(process.resourcesPath, 'app.asar');
        meta = JSON.parse(this.ofs.readFileSync(`${asar}.sig`, 'utf8'));
        if (!verifyMeta(PUBLIC_KEY, meta) || meta.version !== this.version) return;
        if (await sha256File(asar, this.ofs) !== meta.sha256) return;
      }
      const size = this.ofs.statSync(asar).size;
      this.m.updatePackage = { version: meta.version, meta, size, open: () => this.ofs.createReadStream(asar) };
      this.m.infoExtras.upd = meta.version;
    } catch {
      // Unsigned build: we can still receive updates, just not share one.
    }
  }

  _markHealthy() {
    const boot = global.lanmsgBoot;
    if (!boot || !boot.stateFile) return;
    try {
      const state = JSON.parse(this.ofs.readFileSync(boot.stateFile, 'utf8'));
      state.attempts = 0;
      this.ofs.writeFileSync(boot.stateFile, JSON.stringify(state));
    } catch { /* ignore */ }
  }

  getStatus() {
    // The newest version anyone on the network runs, even one this PC cannot
    // take over the network (a different Electron version needs the installer).
    let newest = null;
    for (const p of this.m.peers.values()) {
      if (!p.online || !p.upd || compareVersions(p.upd, this.staged || this.version) <= 0) continue;
      if (!newest || compareVersions(p.upd, newest.version) > 0) newest = { version: p.upd, from: p.name, compatible: p.em === this.em };
    }
    return { ...this.status, current: this.version, staged: this.staged, newest, auto: !!this.m.settings.autoUpdate };
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.getStatus());
  }

  _candidate(manual) {
    const current = this.staged || this.version;
    let best = null;
    for (const p of this.m.peers.values()) {
      if (!p.online || !p.upd || p.em !== this.em) continue;
      if (compareVersions(p.upd, current) <= 0) continue;
      const failedAt = this.failed.get(p.upd);
      // After a failed download wait a while, unless the user asks.
      if (!manual && failedAt && Date.now() - failedAt < 30 * 60000) continue;
      if (!best || compareVersions(p.upd, best.upd) > 0) best = p;
    }
    return best;
  }

  // Runs every minute when automatic updates are on (the internet only every
  // few hours); manual = the "Check for updates" button, which works even
  // when they are off and always looks on the internet too.
  async check({ manual = false } = {}) {
    if (this.busy) return this.getStatus();
    if (!app.isPackaged) {
      if (manual) this._set({ state: 'dev', checkedAt: Date.now() });
      return this.getStatus();
    }
    if (!manual && !this.m.settings.autoUpdate) return this.getStatus();
    const peer = this._candidate(manual);
    if (peer) return this._fromPeer(peer);
    const internet = manual || (this.m.settings.internetUpdates !== false && Date.now() - this.internetAt > INTERNET_INTERVAL);
    if (internet) return this._fromInternet();
    if (this.status.state !== 'installer') this._set({ state: this.staged ? 'ready' : 'none', checkedAt: Date.now(), error: null });
    return this.getStatus();
  }

  async _fromPeer(peer) {
    this.busy = true;
    const version = peer.upd;
    this._set({ state: 'downloading', target: version, from: peer.name, done: 0, size: 0, error: null, checkedAt: Date.now() });
    const tmp = path.join(this.dir, `app-${version}.download`);
    try {
      this.ofs.mkdirSync(this.dir, { recursive: true });
      const res = await this.m.fetchUpdate(peer.id, tmp, { fs: this.ofs, onProgress: this._progress() });
      await this._stage(tmp, res && res.meta, version);
    } catch (err) {
      this.failed.set(version, Date.now());
      this.m.emit('warning', `Update ${version} from ${peer.name} failed: ${err.message}`);
      this._set({ state: 'error', error: err.message });
      try { this.ofs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    } finally {
      this.busy = false;
    }
    return this.getStatus();
  }

  // The newest release on GitHub. Its app.asar.sig must carry our signature.
  async _fromInternet() {
    this.busy = true;
    this.internetAt = Date.now();
    const current = this.staged || this.version;
    this._set({ state: 'checking', checkedAt: Date.now(), error: null });
    let tmp = null;
    try {
      let rel;
      try {
        const res = await net.fetch(this.releasesUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LAN-Messenger-2' } });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        rel = await res.json();
      } catch {
        this._set({ state: this.staged ? 'ready' : 'none', internet: 'offline' });
        return this.getStatus();
      }
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const page = String(rel.html_url || '');
      if (!version || compareVersions(version, current) <= 0) {
        this._set({ state: this.staged ? 'ready' : 'none', internet: 'latest' });
        return this.getStatus();
      }
      const asset = (name) => (rel.assets || []).find((x) => x.name === name);
      const sigAsset = asset('app.asar.sig');
      const asarAsset = asset('app.asar');
      const installer = () => this._set({ state: 'installer', target: version, page, internet: 'newer' });
      if (!sigAsset || !asarAsset) {
        installer();
        return this.getStatus();
      }
      const sigRes = await net.fetch(sigAsset.browser_download_url, { headers: { 'User-Agent': 'LAN-Messenger-2' } });
      if (!sigRes.ok) throw new Error(`Download failed (${sigRes.status})`);
      const meta = JSON.parse(await sigRes.text());
      if (!verifyMeta(PUBLIC_KEY, meta) || meta.version !== version) throw new Error('Invalid signature');
      if (meta.em !== this.em) {
        // Built on a newer Electron: only the full installer can update this PC.
        installer();
        return this.getStatus();
      }
      this._set({ state: 'downloading', target: version, from: 'GitHub', done: 0, size: meta.size, internet: 'newer' });
      this.ofs.mkdirSync(this.dir, { recursive: true });
      tmp = path.join(this.dir, `app-${version}.download`);
      await this._download(asarAsset.browser_download_url, tmp, this._progress(meta.size));
      await this._stage(tmp, meta, version);
    } catch (err) {
      this.m.emit('warning', `Update from the internet failed: ${err.message}`);
      this._set({ state: 'error', error: err.message });
      if (tmp) try { this.ofs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    } finally {
      this.busy = false;
    }
    return this.getStatus();
  }

  async _download(url, dest, onProgress) {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'LAN-Messenger-2' } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const out = this.ofs.createWriteStream(dest);
    const reader = res.body.getReader();
    let done = 0;
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        done += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        onProgress(done);
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
  }

  // Progress for the Settings window, at most four updates a second.
  _progress(knownSize) {
    let shown = 0;
    return (done, size) => {
      if (Date.now() - shown < 250) return;
      shown = Date.now();
      this._set({ done, size: size || knownSize || 0 });
    };
  }

  // Checks a downloaded package and makes it the one used at the next start.
  async _stage(tmp, meta, version) {
    if (!verifyMeta(PUBLIC_KEY, meta)) throw new Error('Invalid signature');
    if (meta.version !== version || meta.em !== this.em) throw new Error('Unexpected version');
    if (await sha256File(tmp, this.ofs) !== meta.sha256) throw new Error('Checksum mismatch');
    const file = `app-${version}.asar`;
    const dest = path.join(this.dir, file);
    this.ofs.rmSync(dest, { force: true });
    this.ofs.renameSync(tmp, dest);
    this.ofs.writeFileSync(`${dest}.sig`, JSON.stringify(meta));
    this.ofs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify({ version, file, attempts: 0 }));
    this._cleanup(file);
    this.staged = version;
    this._set({ state: 'ready', target: version });
    this.onReady(version);
  }

  // Keep only the newest downloaded update (and the one we are running).
  _cleanup(keep) {
    const running = global.lanmsgBoot ? path.basename(global.lanmsgBoot.asar) : null;
    for (const f of this.ofs.readdirSync(this.dir)) {
      const base = f.replace(/\.sig$/, '');
      if (!/^app-.*\.asar$/.test(base) || base === keep || base === running) continue;
      try { this.ofs.rmSync(path.join(this.dir, f), { force: true }); } catch { /* in use */ }
    }
  }
}

module.exports = { Updater };
