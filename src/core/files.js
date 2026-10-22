'use strict';
// File transfers. The receiver "pulls" a file from the sender over its own
// encrypted connection, so transfers never block chat messages and an
// interrupted download resumes from where it stopped.

const fs = require('fs');
const path = require('path');
const { connect } = require('./protocol');

const CHUNK = 256 * 1024;
const PROGRESS_INTERVAL = 200;

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

class FileTransfers {
  constructor(messenger) {
    this.m = messenger;
    this.downloads = new Map(); // tid -> { link, cancelled }
    this.uploads = new Set(); // links
  }

  // ---------- sender side ----------
  serve(link, hello) {
    this.uploads.add(link);
    link.on('close', () => this.uploads.delete(link));
    link.on('json', (req) => {
      if (req.type !== 'file-get') return;
      const offer = this.m.offers[req.tid];
      if (!offer || !offer.allowed.includes(hello.id)) {
        link.sendJson({ type: 'file-error', error: 'File is no longer available' });
        return link.close();
      }
      let stat;
      try {
        stat = fs.statSync(offer.path);
      } catch {
        link.sendJson({ type: 'file-error', error: 'Sender has moved or deleted this file' });
        return link.close();
      }
      if (stat.size !== offer.size) {
        link.sendJson({ type: 'file-error', error: 'File was changed on the sender PC' });
        return link.close();
      }
      const offset = Math.max(0, Math.min(Number(req.offset) || 0, stat.size));
      link.sendJson({ type: 'file-meta', size: stat.size, offset });
      this._stream(link, offer, offset, hello.id);
    });
  }

  _stream(link, offer, offset, peerId) {
    const rs = fs.createReadStream(offer.path, { start: offset, highWaterMark: CHUNK });
    let sent = offset;
    let last = 0;
    const progress = (force) => {
      const now = Date.now();
      if (!force && now - last < PROGRESS_INTERVAL) return;
      last = now;
      this.m.emit('file-progress', {
        conv: offer.conv, msgId: offer.msgId, peerId, upload: true, done: sent, size: offer.size,
      });
    };
    rs.on('data', (chunk) => {
      sent += chunk.length;
      if (!link.sendBin(chunk)) {
        rs.pause();
        link.socket.once('drain', () => rs.resume());
      }
      progress(false);
    });
    rs.on('end', () => {
      link.sendJson({ type: 'file-end', size: sent });
      progress(true);
      // The receiver closes the connection once the file is safely on disk.
      setTimeout(() => link.close(), 30000).unref();
    });
    rs.on('error', (err) => {
      if (!link.closed) link.sendJson({ type: 'file-error', error: err.message });
      link.close();
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
    fs.mkdirSync(dir, { recursive: true });
    const name = sanitizeFileName(f.name);
    const part = path.join(dir, `${name}.${f.tid.slice(0, 8)}.part`);
    let offset = 0;
    try {
      offset = fs.statSync(part).size;
      if (offset > f.size) {
        fs.rmSync(part, { force: true });
        offset = 0;
      }
    } catch { /* fresh download */ }

    const job = { link: null, cancelled: false };
    this.downloads.set(f.tid, job);
    this._update(conv, msgId, { state: 'downloading', error: null });

    let ws = null;
    let received = offset;
    let finished = false;
    let last = 0;
    let lastBytes = offset;
    let lastTime = Date.now();
    let speed = 0;

    const end = (err) => {
      if (finished) return;
      finished = true;
      this.downloads.delete(f.tid);
      const closeStream = (cb) => (ws ? ws.end(cb) : cb());
      closeStream(() => {
        if (job.link) job.link.close();
        if (job.cancelled) {
          fs.rmSync(part, { force: true });
          this._update(conv, msgId, { state: 'offered', error: null });
          return;
        }
        if (err) return this._fail(conv, msgId, err.message || String(err));
        try {
          const final = uniquePath(dir, name);
          fs.renameSync(part, final);
          this._update(conv, msgId, { state: 'done', path: final, error: null });
          this.m.emit('file-done', { conv, msgId, path: final });
        } catch (e) {
          this._fail(conv, msgId, e.message);
        }
      });
    };

    try {
      job.link = await connect(peer.host, peer.port, this.m._hello('file'), {
        setup: (link) => {
          link.on('json', (m) => {
            if (m.type === 'file-meta') {
              ws = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
              ws.on('error', (e) => end(e));
            } else if (m.type === 'file-error') {
              end(new Error(m.error));
            } else if (m.type === 'file-end') {
              if (received !== f.size) end(new Error('Transfer incomplete'));
              else end();
            }
          });
          link.on('bin', (buf) => {
            if (!ws) return;
            received += buf.length;
            if (!ws.write(buf)) {
              link.socket.pause();
              ws.once('drain', () => link.socket.resume());
            }
            const now = Date.now();
            if (now - last >= PROGRESS_INTERVAL) {
              last = now;
              const dt = (now - lastTime) / 1000;
              if (dt >= 0.5) {
                speed = (received - lastBytes) / dt;
                lastBytes = received;
                lastTime = now;
              }
              this.m.emit('file-progress', { conv, msgId, done: received, size: f.size, speed });
            }
          });
          link.on('close', () => end(new Error('Connection lost. Click retry to resume.')));
        },
      });
      if (job.cancelled) return end();
      job.link.sendJson({ type: 'file-get', tid: f.tid, offset });
    } catch (err) {
      end(new Error(`Could not reach sender (${err.message})`));
    }
  }

  cancel(tid) {
    const job = this.downloads.get(tid);
    if (!job) return;
    job.cancelled = true;
    if (job.link) job.link.close();
  }

  _fail(conv, msgId, error) {
    this._update(conv, msgId, { state: 'failed', error });
  }

  _update(conv, msgId, filePatch) {
    const msg = this.m.store.updateMessage(conv, msgId, { file: filePatch });
    if (msg) this.m.emit('message', { conv, msg, isNew: false });
  }

  stop() {
    for (const job of this.downloads.values()) if (job.link) job.link.close();
    for (const link of this.uploads) link.close();
  }
}

module.exports = { FileTransfers, sanitizeFileName, uniquePath };
