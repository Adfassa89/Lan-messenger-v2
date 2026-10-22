'use strict';
// Local storage for settings, contacts and chat history.
// Everything is plain JSON on disk, written atomically (write to a temp file,
// then rename) so a crash or power cut never leaves a half-written file.

const fs = require('fs');
const path = require('path');

const SAVE_DELAY = 400;

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Antivirus or indexers on Windows sometimes lock the target briefly.
    if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err;
    fs.writeFileSync(file, data);
    fs.rmSync(tmp, { force: true });
  }
}

function readJson(file, fallback) {
  for (const f of [file, `${file}.tmp`]) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch { /* try next */ }
  }
  return fallback;
}

function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.historyDir = path.join(dir, 'history');
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.docs = new Map(); // name -> data
    this.dirty = new Set(); // doc names or 'h:<conv>'
    this.timer = null;
    this.histories = new Map(); // conv -> { list, index: Map(id -> msg) }
  }

  // ---- generic documents (config, contacts, outbox, ...) ----
  get(name, fallback) {
    if (!this.docs.has(name)) this.docs.set(name, readJson(path.join(this.dir, `${name}.json`), fallback));
    return this.docs.get(name);
  }

  set(name, data) {
    this.docs.set(name, data);
    this.touch(name);
  }

  touch(name) {
    this.dirty.add(name);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const key of this.dirty) {
      try {
        if (key.startsWith('h:')) {
          const conv = key.slice(2);
          const h = this.histories.get(conv);
          if (h) writeAtomic(path.join(this.historyDir, `${safeName(conv)}.json`), JSON.stringify(h.list));
        } else {
          writeAtomic(path.join(this.dir, `${key}.json`), JSON.stringify(this.docs.get(key), null, 1));
        }
      } catch (err) {
        console.error('Failed to save', key, err);
      }
    }
    this.dirty.clear();
  }

  // ---- chat history ----
  _history(conv) {
    let h = this.histories.get(conv);
    if (!h) {
      const list = readJson(path.join(this.historyDir, `${safeName(conv)}.json`), []);
      h = { list, index: new Map(list.map((m) => [m.id, m])) };
      this.histories.set(conv, h);
    }
    return h;
  }

  messages(conv, { before, limit = 100 } = {}) {
    const { list } = this._history(conv);
    let end = list.length;
    if (before) {
      const i = list.findIndex((m) => m.id === before);
      if (i >= 0) end = i;
    }
    return list.slice(Math.max(0, end - limit), end);
  }

  hasMessage(conv, id) {
    return this._history(conv).index.has(id);
  }

  getMessage(conv, id) {
    return this._history(conv).index.get(id) || null;
  }

  addMessage(conv, msg) {
    const h = this._history(conv);
    if (h.index.has(msg.id)) return false;
    // Keep history ordered by time even if messages arrive late.
    let i = h.list.length;
    while (i > 0 && h.list[i - 1].ts > msg.ts) i--;
    h.list.splice(i, 0, msg);
    h.index.set(msg.id, msg);
    this.touch(`h:${conv}`);
    return true;
  }

  updateMessage(conv, id, patch) {
    const msg = this._history(conv).index.get(id);
    if (!msg) return null;
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && msg[k] && typeof msg[k] === 'object') {
        Object.assign(msg[k], v);
      } else {
        msg[k] = v;
      }
    }
    this.touch(`h:${conv}`);
    return msg;
  }

  deleteMessage(conv, id) {
    const h = this._history(conv);
    const i = h.list.findIndex((m) => m.id === id);
    if (i < 0) return false;
    h.list.splice(i, 1);
    h.index.delete(id);
    this.touch(`h:${conv}`);
    return true;
  }

  clearHistory(conv) {
    const h = this._history(conv);
    h.list.length = 0;
    h.index.clear();
    this.touch(`h:${conv}`);
  }

  allConversationIds() {
    const ids = new Set(this.histories.keys());
    for (const conv of Object.keys(this.get('conversations', {}))) ids.add(conv);
    return [...ids];
  }

  search(query, limit = 200) {
    const q = query.toLowerCase();
    const results = [];
    for (const conv of this.allConversationIds()) {
      for (const m of this._history(conv).list) {
        const hay = `${m.text || ''} ${m.file ? m.file.name : ''}`.toLowerCase();
        if (hay.includes(q)) results.push({ conv, msg: m });
      }
    }
    results.sort((a, b) => b.msg.ts - a.msg.ts);
    return results.slice(0, limit);
  }
}

module.exports = { Store, writeAtomic, readJson };
