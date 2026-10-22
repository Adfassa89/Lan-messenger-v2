'use strict';
// File and folder transfers. The receiver "pulls" files from the sender over
// a separate encrypted connection, so transfers never block chat messages
// and an interrupted download resumes from where it stopped.
// The same mechanism shares app updates between PCs.

const fs = require('fs');
const path = require('path');
const { connect } = require('./protocol');

const CHUNK = 256 * 1024;
const PROGRESS_INTERVAL = 200;
const IDLE_CLOSE = 60000;
const MAX_ENTRIES = 20000;

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// Never trust a file name that came over the network.
function sanitizeFileName(name) {
  // Keep only the last path segment, the same way on every OS.
  let n = String(name || 'file').split(/[\\/]/).pop();
  n = n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (!n) n = 'file';
  const ext = path.extname(n);
  if (RESERVED.test(path.basename(n, ext))) n = `_${n}`;
  return n.slice(0, 200);
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function fileSize(p, fsMod = fs) {
  try {
    return fsMod.statSync(p).size;
  } catch {
    return -1;
  }
}

// Routes frames from one connection to whichever request is waiting.
function channel(link) {
  const ch = { handler: null, closed: false };
  link.on('json', (m) => ch.handler && ch.handler.json(m));
  link.on('bin', (b) => ch.handler && ch.handler.bin(b));
  link.on('close', () => {
    ch.closed = true;
    if (ch.handler) ch.handler.close();
  });
  return ch;
}

// Sends one request and receives one reply (a list, or a file written to `part`).
function request(link, ch, req, { part, append = false, onData, fsMod = fs } = {}) {
  return new Promise((resolve, reject) => {
    let ws = null;
    let meta = null;
    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      ch.handler = null;
      if (ws) ws.destroy();
      reject(err);
    };
    const done = (v) => {
      if (finished) return;
      finished = true;
      ch.handler = null;
      resolve(v);
    };
    ch.handler = {
      json(m) {
        if (m.type === 'file-meta' || m.type === 'update-meta') {
          meta = m;
          ws = fsMod.createWriteStream(part, { flags: append ? 'a' : 'w' });
          ws.on('error', fail);
        } else if (m.type === 'file-list') {
          done(m);
        } else if (m.type === 'file-error') {
          fail(new Error(m.error || 'Transfer failed'));
        } else if (m.type === 'file-end') {
          // A full disk buffer may have paused the socket; 'drain' never comes
          // once the stream is ending, so resume here for the next request.
          const finish = () => {
            link.socket.resume();
            done(meta);
          };
          if (ws) ws.end(finish);
          else finish();
        }
      },
      bin(b) {
        if (!ws) return;
        if (!ws.write(b)) {
          link.socket.pause();
          ws.once('drain', () => link.socket.resume());
        }
        if (onData) onData(b.length);
      },
      close() {
        fail(new Error('Connection lost. Click retry to resume.'));
      },
    };
    if (ch.closed || link.closed) return fail(new Error('Connection lost'));
    link.sendJson(req);
  });
}

class FileTransfers {
  constructor(messenger) {
    this.m = messenger;
    this.downloads = new Map(); // tid -> { link, cancelled }
    this.uploads = new Set(); // links
  }

  // ---------- sender side ----------
  serve(link, hello) {
    this.uploads.add(link);
    let idle = null;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => link.close(), IDLE_CLOSE);
      idle.unref();
    };
    touch();
    link.on('close', () => {
      clearTimeout(idle);
      this.uploads.delete(link);
    });
    const error = (msg) => link.sendJson({ type: 'file-error', error: msg });

    link.on('json', (req) => {
      touch();
      if (req.type === 'update-get') return this._serveUpdate(link, error);
      if (req.type !== 'file-get' && req.type !== 'file-list') return;
      const offer = this.m.offers[req.tid];
      if (!offer || !offer.allowed.includes(hello.id)) return error('File is no longer available');

      if (req.type === 'file-list') {
        if (!offer.folder) return error('Not a folder');
        return link.sendJson({ type: 'file-list', entries: offer.entries });
      }

      let filePath = offer.path;
      let size = offer.size;
      let base = 0;
      if (offer.folder) {
        const i = Number(req.index);
        const entry = offer.entries[i];
        if (!entry) return error('File not found in folder');
        filePath = path.join(offer.path, ...entry.rel.split('/'));
        if (!path.resolve(filePath).startsWith(path.resolve(offer.path))) return error('Invalid path');
        size = entry.size;
        for (let k = 0; k < i; k++) base += offer.entries[k].size;
      }
      const actual = fileSize(filePath);
      if (actual < 0) return error('Sender has moved or deleted this file');
      if (actual !== size) return error('File was changed on the sender PC');
      const offset = Math.max(0, Math.min(Number(req.offset) || 0, size));
      link.sendJson({ type: 'file-meta', size, offset });

      let last = 0;
      this._stream(link, fs.createReadStream(filePath, { start: offset, highWaterMark: CHUNK }), offset, (sent, force) => {
        const now = Date.now();
        if (!force && now - last < PROGRESS_INTERVAL) return;
        last = now;
        this.m.emit('file-progress', {
          conv: offer.conv, msgId: offer.msgId, peerId: hello.id, upload: true, done: base + sent, size: offer.size,
        });
      });
    });
  }

  _serveUpdate(link, error) {
    const pkg = this.m.updatePackage;
    if (!pkg) return error('No update available');
    link.sendJson({ type: 'update-meta', version: pkg.version, meta: pkg.meta, size: pkg.size });
    this._stream(link, pkg.open(), 0, () => {});
  }

  _stream(link, rs, start, onProgress) {
    let sent = start;
    rs.on('data', (chunk) => {
      sent += chunk.length;
      if (!link.sendBin(chunk)) {
        rs.pause();
        link.socket.once('drain', () => rs.resume());
      }
      onProgress(sent, false);
    });
    rs.on('end', () => {
      link.sendJson({ type: 'file-end', size: sent });
      onProgress(sent, true);
    });
    rs.on('error', (err) => {
      if (!link.closed) link.sendJson({ type: 'file-error', error: err.message });
    });
    link.on('close', () => rs.destroy());
  }

  // ---------- receiver side ----------
  isActive(tid) {
    return this.downloads.has(tid);
  }

  async download(conv, msgId) {
    const msg = this.m.store.getMessage(conv, msgId);
    if (!msg || msg.kind !== 'file' || msg.from === this.m.id) return;
    const f = msg.file;
    if (f.state === 'done' || this.downloads.has(f.tid)) return;
    const peer = this.m.peers.get(msg.from);
    if (!peer || !peer.online || !peer.host) {
      return this._fail(conv, msgId, 'Sender is offline. Try again when they are online.');
    }

    const dir = this.m.settings.downloadDir;
    const job = { conv, link: null, cancelled: false, parts: [] };
    this.downloads.set(f.tid, job);
    this._update(conv, msgId, { state: 'downloading', error: null });

    let received = 0;
    let last = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let speed = 0;
    const onData = (n) => {
      received += n;
      const now = Date.now();
      if (now - last < PROGRESS_INTERVAL) return;
      last = now;
      const dt = (now - lastTime) / 1000;
      if (dt >= 0.5) {
        speed = (received - lastBytes) / dt;
        lastBytes = received;
        lastTime = now;
      }
      this.m.emit('file-progress', { conv, msgId, done: received, size: f.size, speed });
    };

    try {
      fs.mkdirSync(dir, { recursive: true });
      job.link = await connect(peer.host, peer.port, this.m._hello('file'));
      const ch = channel(job.link);
      if (job.cancelled) throw new Error('cancelled');

      let finalPath;
      if (f.folder) {
        finalPath = await this._downloadFolder(job, ch, msg, dir, (n) => { received += n; }, onData);
      } else {
        const name = sanitizeFileName(f.name);
        const part = path.join(dir, `${name}.${f.tid.slice(0, 8)}.part`);
        job.parts.push(part);
        let offset = fileSize(part);
        if (offset < 0 || offset > f.size) offset = 0;
        received = offset;
        lastBytes = offset;
        await request(job.link, ch, { type: 'file-get', tid: f.tid, offset }, { part, append: offset > 0, onData });
        if (fileSize(part) !== f.size) throw new Error('Transfer incomplete. Click retry to resume.');
        finalPath = uniquePath(dir, name);
        fs.renameSync(part, finalPath);
      }
      this._update(conv, msgId, { state: 'done', path: finalPath, error: null });
      this.m.emit('file-done', { conv, msgId, path: finalPath });
    } catch (err) {
      if (job.cancelled) {
        if (!f.folder) for (const p of job.parts) fs.rmSync(p, { force: true });
        this._update(conv, msgId, { state: 'offered', error: null });
      } else {
        const text = /ECONNREFUSED|ETIMEDOUT|timeout/i.test(err.message) ? `Could not reach sender (${err.message})` : err.message;
        this._fail(conv, msgId, text);
      }
    } finally {
      this.downloads.delete(f.tid);
      if (job.link) job.link.close();
    }
  }

  async _downloadFolder(job, ch, msg, dir, skipBytes, onData) {
    const f = msg.file;
    const list = await request(job.link, ch, { type: 'file-list', tid: f.tid });
    const entries = (Array.isArray(list.entries) ? list.entries : []).slice(0, MAX_ENTRIES)
      .filter((e) => e && typeof e.rel === 'string' && Number.isFinite(e.size));
    // Retry continues in the same folder.
    let root = f.path && fs.existsSync(f.path) ? f.path : uniquePath(dir, sanitizeFileName(f.name));
    fs.mkdirSync(root, { recursive: true });
    root = path.resolve(root);
    this.m.store.updateMessage(job.conv, msg.id, { file: { path: root } });

    for (let i = 0; i < entries.length; i++) {
      if (job.cancelled) throw new Error('cancelled');
      const e = entries[i];
      const segs = e.rel.split('/').filter(Boolean).map(sanitizeFileName);
      const target = path.join(root, ...segs);
      if (!target.startsWith(root + path.sep)) continue;
      if (fileSize(target) === e.size) {
        skipBytes(e.size);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const part = `${target}.part`;
      let offset = fileSize(part);
      if (offset < 0 || offset > e.size) offset = 0;
      skipBytes(offset);
      await request(job.link, ch, { type: 'file-get', tid: f.tid, index: i, offset }, { part, append: offset > 0, onData });
      if (fileSize(part) !== e.size) throw new Error('Transfer incomplete. Click retry to resume.');
      fs.rmSync(target, { force: true });
      fs.renameSync(part, target);
    }
    return root;
  }

  cancel(tid) {
    const job = this.downloads.get(tid);
    if (!job) return;
    job.cancelled = true;
    if (job.link) job.link.close();
  }

  // Downloads another PC's app update package to `dest`.
  async fetchUpdate(peerId, dest, fsMod = fs) {
    const peer = this.m.peers.get(peerId);
    if (!peer || !peer.online) throw new Error('Peer offline');
    const link = await connect(peer.host, peer.port, this.m._hello('file'));
    try {
      const ch = channel(link);
      const meta = await request(link, ch, { type: 'update-get' }, { part: dest, fsMod });
      if (!meta || fileSize(dest, fsMod) !== meta.size) throw new Error('Update download incomplete');
      return meta;
    } finally {
      link.close();
    }
  }

  _fail(conv, msgId, error) {
    this._update(conv, msgId, { state: 'failed', error });
  }

  _update(conv, msgId, filePatch) {
    const msg = this.m.store.updateMessage(conv, msgId, { file: filePatch });
    if (msg) this.m.emit('message', { conv, msg, isNew: false });
  }

  stop() {
    for (const job of this.downloads.values()) {
      job.cancelled = false;
      if (job.link) job.link.close();
    }
    for (const link of this.uploads) link.close();
  }
}

module.exports = { FileTransfers, sanitizeFileName, uniquePath };
