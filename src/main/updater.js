'use strict';
// Shares app updates between PCs. When another PC runs a newer signed
// version, this PC downloads it from them, checks the signature, and offers
// to restart into it. No internet or IT visit needed.

const path = require('path');
const { app } = require('electron');
const { compareVersions, verifyMeta, sha256File } = require('../core/update');
const PUBLIC_KEY = require('./update-key');

const CHECK_INTERVAL = 60000;

class Updater {
  constructor(messenger, { version, onReady }) {
    this.m = messenger;
    this.version = version;
    this.onReady = onReady;
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

  _candidate() {
    const current = this.staged || this.version;
    let best = null;
    for (const p of this.m.peers.values()) {
      if (!p.online || !p.upd || p.em !== this.em) continue;
      if (compareVersions(p.upd, current) <= 0) continue;
      const failedAt = this.failed.get(p.upd);
      if (failedAt && Date.now() - failedAt < 30 * 60000) continue;
      if (!best || compareVersions(p.upd, best.upd) > 0) best = p;
    }
    return best;
  }

  async check() {
    if (this.busy || !app.isPackaged || !this.m.settings.autoUpdate) return;
    const peer = this._candidate();
    if (!peer) return;
    this.busy = true;
    const version = peer.upd;
    const tmp = path.join(this.dir, `app-${version}.download`);
    try {
      this.ofs.mkdirSync(this.dir, { recursive: true });
      const res = await this.m.fetchUpdate(peer.id, tmp, { fs: this.ofs });
      const meta = res && res.meta;
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
      this.onReady(version);
    } catch (err) {
      this.failed.set(version, Date.now());
      this.m.emit('warning', `Update ${version} from ${peer.name} failed: ${err.message}`);
      try { this.ofs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    } finally {
      this.busy = false;
    }
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
