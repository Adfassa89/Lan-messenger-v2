'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Accounts, cipherFor, validPin, DELETE_WAIT } = require('../src/core/accounts');
const { Store } = require('../src/core/store');
const { tmpDir } = require('./helpers');

test('PINs are 4 to 6 digits', () => {
  for (const ok of ['1234', '00000', '987654']) assert.ok(validPin(ok), ok);
  for (const bad of ['123', '1234567', '12a4', '', ' 1234', 1234]) assert.ok(!validPin(bad), String(bad));
});

test('up to 4 accounts, each unlocked only by its PIN', () => {
  const acc = new Accounts(tmpDir('acc'));
  const a = acc.create('Anna', '1234');
  acc.create('Bat', '5678');
  acc.create('Saraa', '000000');
  acc.create('Dorj', '4321');
  assert.throws(() => acc.create('Fifth', '1111'), /4 accounts/);
  assert.throws(() => acc.create('Bad', '12'), /4 to 6/);
  assert.ok(acc.unlock(a.id, '1234').equals(a.key));
  assert.throws(() => acc.unlock(a.id, '9999'), /Wrong PIN/);
  assert.deepStrictEqual(acc.list().map((x) => x.name), ['Anna', 'Bat', 'Saraa', 'Dorj']);
});

test('chats are encrypted on disk and unreadable without the key', () => {
  const root = tmpDir('acc');
  const acc = new Accounts(root);
  const { id, key } = acc.create('Anna', '1234');
  const store = new Store(acc.dir(id), { cipher: cipherFor(key) });
  store.addMessage('peer1', { id: 'm1', ts: 1, text: 'Blast at 14:00 in pit 3' });
  store.set('config', { name: 'Anna' });
  store.flush();
  const raw = fs.readFileSync(path.join(acc.dir(id), 'history', 'peer1.json'));
  assert.ok(!raw.toString('latin1').includes('Blast'), 'not readable on disk');
  const again = new Store(acc.dir(id), { cipher: cipherFor(acc.unlock(id, '1234')) });
  assert.strictEqual(again.messages('peer1')[0].text, 'Blast at 14:00 in pit 3');
  const wrong = new Store(acc.dir(id), { cipher: cipherFor(Buffer.alloc(32)) });
  assert.deepStrictEqual(wrong.messages('peer1'), []);
});

test('wrong PINs: after 5 tries the account has to wait', () => {
  const acc = new Accounts(tmpDir('acc'));
  const { id } = acc.create('Anna', '1234');
  for (let i = 0; i < 5; i++) assert.throws(() => acc.unlock(id, '0000'));
  assert.throws(() => acc.unlock(id, '1234'), /Too many/);
  assert.ok(acc.list()[0].waitUntil > Date.now());
});

test('changing the PIN keeps the chats', () => {
  const acc = new Accounts(tmpDir('acc'));
  const { id, key } = acc.create('Anna', '1234');
  acc.changePin(id, '1234', '246810');
  assert.throws(() => acc.unlock(id, '1234'));
  assert.ok(acc.unlock(id, '246810').equals(key));
});

test('delete with the PIN at once, or without it only after 30 days', () => {
  const acc = new Accounts(tmpDir('acc'));
  const a = acc.create('Anna', '1234');
  const b = acc.create('Bat', '5678');
  assert.throws(() => acc.remove(a.id, '0000'), /Wrong PIN/);
  acc.remove(a.id, '1234');
  assert.ok(!fs.existsSync(acc.dir(a.id)));
  const until = acc.requestDelete(b.id);
  assert.ok(until - Date.now() > DELETE_WAIT - 5000);
  assert.throws(() => acc.remove(b.id, '', { now: Date.now() + 29 * 86400000 }));
  acc.remove(b.id, '', { now: Date.now() + DELETE_WAIT + 1000 });
  assert.strictEqual(acc.list().length, 0);
});

test('signing in with the PIN cancels a deletion request', () => {
  const acc = new Accounts(tmpDir('acc'));
  const { id } = acc.create('Anna', '1234');
  acc.requestDelete(id);
  acc.unlock(id, '1234');
  assert.strictEqual(acc.list()[0].deleteRequestedAt, 0);
});

test('the old profile becomes account 1, encrypted, with nothing left in plain text', () => {
  const legacy = tmpDir('legacy');
  fs.mkdirSync(path.join(legacy, 'history'));
  fs.writeFileSync(path.join(legacy, 'config.json'), JSON.stringify({ id: 'old-id', name: 'Tem' }));
  fs.writeFileSync(path.join(legacy, 'history', 'p.json'), JSON.stringify([{ id: 'x', ts: 1, text: 'secret shift note' }]));
  fs.writeFileSync(path.join(legacy, 'Preferences'), 'chromium file');
  const acc = new Accounts(tmpDir('acc'));
  const { id, key } = acc.migrate(legacy, 'Tem', '1234');
  assert.ok(!fs.existsSync(path.join(legacy, 'config.json')));
  assert.ok(!fs.existsSync(path.join(legacy, 'history')));
  assert.ok(fs.existsSync(path.join(legacy, 'Preferences')), 'Chromium files stay');
  const store = new Store(acc.dir(id), { cipher: cipherFor(key) });
  assert.strictEqual(store.get('config', {}).id, 'old-id');
  assert.strictEqual(store.messages('p')[0].text, 'secret shift note');
});

test('a backup restores the account elsewhere with the same PIN, and is useless without it', () => {
  const acc = new Accounts(tmpDir('acc'));
  const { id, key } = acc.create('Anna', '1234');
  const store = new Store(acc.dir(id), { cipher: cipherFor(key) });
  store.addMessage('peer1', { id: 'm1', ts: 1, text: 'keep me' });
  store.set('config', { id: 'anna-id', name: 'Anna' });
  store.flush();
  const file = path.join(tmpDir('bk'), 'anna.lmbackup');
  assert.throws(() => acc.backup(id, key, '9999', file));
  acc.backup(id, key, '1234', file);
  assert.ok(!fs.readFileSync(file).toString('latin1').includes('keep me'));
  const other = new Accounts(tmpDir('acc2'));
  assert.throws(() => other.restore(file, '0000'), /Wrong PIN/);
  const r = other.restore(file, '1234');
  const s2 = new Store(other.dir(r.id), { cipher: cipherFor(r.key) });
  assert.strictEqual(s2.messages('peer1')[0].text, 'keep me');
  assert.strictEqual(s2.get('config', {}).id, 'anna-id');
});

test('an account in use by another program cannot be claimed or deleted', () => {
  const acc = new Accounts(tmpDir('acc'));
  const { id } = acc.create('Anna', '1234');
  fs.writeFileSync(path.join(acc.dir(id), '.inuse'), JSON.stringify({ pid: process.ppid }));
  assert.throws(() => acc.claim(id), /another Windows user/);
  assert.throws(() => acc.remove(id, '1234'), /signed in/);
  fs.writeFileSync(path.join(acc.dir(id), '.inuse'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  acc.claim(id);
  acc.release(id);
});
