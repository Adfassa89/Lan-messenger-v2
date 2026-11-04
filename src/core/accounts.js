'use strict';
// Local accounts: up to 4 per PC, each with its own name, chats and settings,
// protected by a 4 – 6 digit PIN. They are not Windows accounts or e-mail
// accounts: they live in one folder for the whole PC, so any Windows user can
// sign in to any of them.
//
// Each account's files are encrypted with its own random key. That key is
// stored only wrapped (encrypted) with the PIN, so without the PIN or a backup
// the chats cannot be read, and there is no way to recover them.
//
// Deleting an account needs its PIN, or a deletion request that has waited a
// full 30 days.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const MAX_ACCOUNTS = 4;
const DELETE_WAIT = 30 * 86400000;
const MAGIC = Buffer.from('LME1');
const BACKUP_MAGIC = Buffer.from('LMBK1');
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
// Wrong PINs: after 5 in a row the account waits 30 s, then twice as long each time.
const FREE_TRIES = 5;

const validPin = (pin) => typeof pin === 'string' && /^\d{4,6}$/.test(pin);
const derive = (pin, salt) => crypto.scryptSync(String(pin), salt, 32, KDF);

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
function open(key, buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

// What the Store uses to read and write an account's files.
function cipherFor(key) {
  return {
    isEncrypted: (buf) => buf.length > 32 && buf.subarray(0, 4).equals(MAGIC),
    encrypt: (text) => Buffer.concat([MAGIC, seal(key, Buffer.from(text, 'utf8'))]),
    decrypt: (buf) => open(key, buf.subarray(4)).toString('utf8'),
  };
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Every file of an account folder, relative paths (the lock file aside).
function walk(dir, base = dir, out = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile() && e.name !== '.inuse' && !e.name.endsWith('.tmp')) out.push(path.relative(base, p));
  }
  return out;
}

class Accounts {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'accounts.json');
    fs.mkdirSync(root, { recursive: true });
  }

  _read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { accounts: Array.isArray(d.accounts) ? d.accounts : [] };
    } catch { return { accounts: [] }; }
  }
  _write(d) { writeAtomic(this.file, JSON.stringify(d, null, 1)); }
  _find(d, id) {
    const a = d.accounts.find((x) => x.id === id);
    if (!a) throw new Error('Account not found');
    return a;
  }

  dir(id) { return path.join(this.root, String(id).replace(/[^a-z0-9]/g, '')); }

  // What the sign-in screen shows (nothing secret).
  list() {
    const now = Date.now();
    return this._read().accounts.map((a) => ({
      id: a.id, name: a.name, avatar: a.avatar || null, created: a.created,
      deleteRequestedAt: a.deleteRequestedAt || 0,
      deletableAt: a.deleteRequestedAt ? a.deleteRequestedAt + DELETE_WAIT : 0,
      canDeleteNow: !!a.deleteRequestedAt && now >= a.deleteRequestedAt + DELETE_WAIT,
      waitUntil: a.lockUntil && a.lockUntil > now ? a.lockUntil : 0,
    }));
  }

  get full() { return this._read().accounts.length >= MAX_ACCOUNTS; }

  create(name, pin, { id } = {}) {
    if (!validPin(pin)) throw new Error('The PIN must be 4 to 6 digits');
    const d = this._read();
    if (d.accounts.length >= MAX_ACCOUNTS) throw new Error('This PC already has 4 accounts');
    const acc = { id: id || crypto.randomBytes(8).toString('hex'), name: String(name || '').trim().slice(0, 60) || 'User', created: Date.now() };
    const key = crypto.randomBytes(32);
    Object.assign(acc, this._wrap(key, pin));
    fs.mkdirSync(this.dir(acc.id), { recursive: true });
    d.accounts.push(acc);
    this._write(d);
    return { id: acc.id, key };
  }

  _wrap(key, pin) {
    const salt = crypto.randomBytes(16);
    return { salt: salt.toString('base64'), wrapped: seal(derive(pin, salt), key).toString('base64') };
  }

  // The account's key, or an error for a wrong PIN (with a growing wait after 5 in a row).
  unlock(id, pin) {
    const d = this._read();
    const a = this._find(d, id);
    const now = Date.now();
    if (a.lockUntil && a.lockUntil > now) {
      const e = new Error('Too many wrong PINs. Try again later.');
      e.waitUntil = a.lockUntil;
      throw e;
    }
    let key = null;
    if (validPin(pin)) {
      try { key = open(derive(pin, Buffer.from(a.salt, 'base64')), Buffer.from(a.wrapped, 'base64')); } catch { key = null; }
    }
    if (!key) {
      a.fails = (a.fails || 0) + 1;
      if (a.fails >= FREE_TRIES) a.lockUntil = now + 30000 * 2 ** Math.min(8, a.fails - FREE_TRIES);
      this._write(d);
      const e = new Error('Wrong PIN');
      e.waitUntil = a.lockUntil || 0;
      throw e;
    }
    // The right PIN clears the count, and cancels a pending deletion request.
    if (a.fails || a.lockUntil || a.deleteRequestedAt) {
      delete a.fails;
      delete a.lockUntil;
      delete a.deleteRequestedAt;
      this._write(d);
    }
    return key;
  }

  // For a lock screen: is this the PIN? (Counts towards the wrong-PIN wait.)
  check(id, pin) {
    this.unlock(id, pin);
    return true;
  }

  changePin(id, oldPin, newPin) {
    if (!validPin(newPin)) throw new Error('The PIN must be 4 to 6 digits');
    const key = this.unlock(id, oldPin);
    const d = this._read();
    Object.assign(this._find(d, id), this._wrap(key, newPin));
    this._write(d);
  }

  update(id, patch) {
    const d = this._read();
    const a = this._find(d, id);
    if (patch.name !== undefined) a.name = String(patch.name).trim().slice(0, 60) || a.name;
    if (patch.avatar !== undefined) a.avatar = typeof patch.avatar === 'string' && patch.avatar.length < 200000 ? patch.avatar : null;
    this._write(d);
  }

  // Without the PIN: ask, then wait 30 days.
  requestDelete(id) {
    const d = this._read();
    const a = this._find(d, id);
    if (!a.deleteRequestedAt) a.deleteRequestedAt = Date.now();
    this._write(d);
    return a.deleteRequestedAt + DELETE_WAIT;
  }

  cancelDelete(id) {
    const d = this._read();
    delete this._find(d, id).deleteRequestedAt;
    this._write(d);
  }

  // With the PIN at once, or without it once the 30 days are over.
  remove(id, pin, { now = Date.now() } = {}) {
    const d = this._read();
    const a = this._find(d, id);
    const waited = a.deleteRequestedAt && now >= a.deleteRequestedAt + DELETE_WAIT;
    if (!waited) this.unlock(id, pin);
    if (this.inUseBy(id)) throw new Error('This account is signed in on this PC right now');
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    const after = this._read();
    after.accounts = after.accounts.filter((x) => x.id !== id);
    this._write(after);
  }

  // ---- one sign-in at a time per account (two Windows users on one PC) ----
  inUseBy(id) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(this.dir(id), '.inuse'), 'utf8'));
      if (!pid || pid === process.pid) return 0;
      try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : 0; }
    } catch { return 0; }
  }
  claim(id) {
    const other = this.inUseBy(id);
    if (other) throw new Error('This account is already signed in on another Windows user of this PC');
    fs.writeFileSync(path.join(this.dir(id), '.inuse'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  }
  release(id) {
    try {
      const f = path.join(this.dir(id), '.inuse');
      const { pid } = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (pid === process.pid) fs.rmSync(f, { force: true });
    } catch { /* not ours */ }
  }

  // ---- the profile from before accounts becomes an account ----
  // Copies the old folder's chats and settings into the new account, encrypted,
  // then removes the plain copies.
  migrate(legacyDir, name, pin) {
    const { id, key } = this.create(name, pin);
    const dest = this.dir(id);
    const cipher = cipherFor(key);
    const moved = [];
    const copy = (rel, encrypt) => {
      const from = path.join(legacyDir, rel);
      const to = path.join(dest, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const buf = fs.readFileSync(from);
      fs.writeFileSync(to, encrypt ? cipher.encrypt(buf.toString('utf8')) : buf);
      moved.push(from);
    };
    for (const f of fs.readdirSync(legacyDir)) if (f.endsWith('.json') && fs.statSync(path.join(legacyDir, f)).isFile()) copy(f, true);
    for (const sub of ['history']) for (const rel of walk(path.join(legacyDir, sub))) copy(path.join(sub, rel), rel.endsWith('.json'));
    for (const rel of walk(path.join(legacyDir, 'attachments'))) copy(path.join('attachments', rel), false);
    for (const f of moved) fs.rmSync(f, { force: true });
    fs.rmSync(path.join(legacyDir, 'history'), { recursive: true, force: true });
    fs.rmSync(path.join(legacyDir, 'attachments'), { recursive: true, force: true });
    return { id, key };
  }

  // ---- backup ----
  // One file with everything of the account (decrypted inside, then sealed
  // with the PIN), so it can be restored on any PC that knows the PIN.
  backup(id, key, pin, file) {
    const unlocked = this.unlock(id, pin);
    if (!unlocked.equals(key)) throw new Error('Wrong PIN');
    const cipher = cipherFor(key);
    const dir = this.dir(id);
    const acc = this.list().find((a) => a.id === id);
    const files = {};
    for (const rel of walk(dir)) {
      const buf = fs.readFileSync(path.join(dir, rel));
      files[rel.split(path.sep).join('/')] = (cipher.isEncrypted(buf) ? Buffer.from(cipher.decrypt(buf), 'utf8') : buf).toString('base64');
    }
    const payload = zlib.gzipSync(JSON.stringify({ v: 1, name: acc.name, avatar: acc.avatar || null, at: Date.now(), files }));
    const salt = crypto.randomBytes(16);
    writeAtomic(file, Buffer.concat([BACKUP_MAGIC, salt, seal(derive(pin, salt), payload)]));
    return Object.keys(files).length;
  }

  // A backup becomes a new account here (same PIN); its chats and identity come back.
  restore(file, pin) {
    const buf = fs.readFileSync(file);
    if (!buf.subarray(0, 5).equals(BACKUP_MAGIC)) throw new Error('This is not a LAN Messenger backup');
    if (!validPin(pin)) throw new Error('Wrong PIN');
    let data;
    try {
      data = JSON.parse(zlib.gunzipSync(open(derive(pin, buf.subarray(5, 21)), buf.subarray(21))).toString('utf8'));
    } catch { throw new Error('Wrong PIN'); }
    const { id, key } = this.create(data.name, pin);
    const dir = this.dir(id);
    const cipher = cipherFor(key);
    for (const [rel, b64] of Object.entries(data.files || {})) {
      if (rel.includes('..') || path.isAbsolute(rel)) continue;
      const to = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const raw = Buffer.from(b64, 'base64');
      fs.writeFileSync(to, rel.endsWith('.json') ? cipher.encrypt(raw.toString('utf8')) : raw);
    }
    if (data.avatar) this.update(id, { avatar: data.avatar });
    return { id, key, name: data.name };
  }
}

module.exports = { Accounts, cipherFor, validPin, MAX_ACCOUNTS, DELETE_WAIT };
