'use strict';
// The updater normally runs only inside the installed app. Here Electron's
// `app`, `original-fs` and the signing key are replaced by test versions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { makePair, waitFor, tmpDir } = require('./helpers');
const { signMeta, sha256FileSync } = require('../src/core/update');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const dataDir = tmpDir('updater');
const fakes = {
  electron: { app: { isPackaged: true, getPath: () => dataDir } },
  'original-fs': fs,
};
const realLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (fakes[request]) return fakes[request];
  if (request.endsWith('update-key')) return publicKey.export({ type: 'spki', format: 'pem' });
  return realLoad.call(this, request, parent, isMain);
};
if (!process.versions.electron) Object.defineProperty(process.versions, 'electron', { value: '44.0.0' });
const { Updater } = require('../src/main/updater');

test('"Check for updates" downloads a newer version from another PC and reports progress', async () => {
  const [alice, bob] = makePair();
  const pkg = path.join(alice.dir, 'app.asar');
  fs.writeFileSync(pkg, crypto.randomBytes(3 * 1024 * 1024));
  const meta = signMeta(privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    version: '9.9.9', em: '44', sha256: sha256FileSync(pkg, fs), size: fs.statSync(pkg).size,
  });
  alice.updatePackage = { version: '9.9.9', meta, size: meta.size, open: () => fs.createReadStream(pkg) };
  Object.assign(alice.infoExtras, { upd: '9.9.9', em: '44' });
  await alice.start();
  await bob.start();
  const statuses = [];
  let ready = null;
  const updater = new Updater(bob, { version: '2.6.0', onReady: (v) => { ready = v; }, onStatus: (s) => statuses.push(s) });
  try {
    await waitFor(() => bob.peers.get(alice.id)?.upd === '9.9.9', 8000, 'Alice announces 9.9.9');
    bob.setSettings({ autoUpdate: false }); // the button works even with automatic updates off
    const st = await updater.check({ manual: true });
    assert.strictEqual(st.state, 'ready');
    assert.strictEqual(ready, '9.9.9');
    assert.ok(statuses.some((s) => s.state === 'downloading' && s.from === 'Alice'), 'download shown');
    assert.ok(statuses.some((s) => s.state === 'downloading' && s.size === meta.size && s.done > 0), 'progress shown');
    assert.ok(fs.existsSync(path.join(dataDir, 'updates', 'app-9.9.9.asar')));
    // Nothing newer left: the next check says so.
    const again = await updater.check({ manual: true });
    assert.strictEqual(again.state, 'ready');
    assert.strictEqual(again.staged, '9.9.9');
  } finally {
    updater.stop();
    await alice.stop();
    await bob.stop();
  }
});
