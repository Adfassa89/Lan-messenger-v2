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
  electron: { app: { isPackaged: true, getPath: () => dataDir }, net: { fetch: (...args) => fetch(...args) } },
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
  const updater = new Updater(bob, {
    version: '2.6.0', onReady: (v) => { ready = v; }, onStatus: (s) => statuses.push(s), releasesUrl: 'http://127.0.0.1:9/latest',
  });
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

// A stand-in for GitHub's "latest release" page and its files.
function fakeGitHub(release) {
  const http = require('http');
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/latest') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        tag_name: `v${release.version}`, html_url: `${base}/page`,
        assets: Object.keys(release.files).map((name) => ({ name, browser_download_url: `${base}/${name}` })),
      }));
    }
    const name = req.url.slice(1);
    if (!release.files[name]) { res.statusCode = 404; return res.end(); }
    return res.end(release.files[name]);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function fakeMessenger() {
  return { peers: new Map(), settings: { autoUpdate: true, internetUpdates: true }, infoExtras: {}, emit() {} };
}

test('"Check for updates" also takes a signed release from GitHub, and refuses a forged one', async () => {
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const meta = signMeta(priv, { version: '9.9.9', em: '44', sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length });
  const cases = [
    ['newer and signed', { 'app.asar': body, 'app.asar.sig': JSON.stringify(meta) }, '9.9.9', 'ready'],
    ['forged signature', { 'app.asar': body, 'app.asar.sig': JSON.stringify({ ...meta, sha256: '0'.repeat(64) }) }, '9.9.9', 'error'],
    ['needs the installer', { 'app.asar': body, 'app.asar.sig': JSON.stringify(signMeta(priv, { ...meta, em: '45' })) }, '9.9.9', 'installer'],
    ['installers only', { 'setup.exe': 'x' }, '9.9.9', 'installer'],
    ['already up to date', {}, '2.6.0', 'none'],
  ];
  for (const [name, files, version, want] of cases) {
    fs.rmSync(path.join(dataDir, 'updates'), { recursive: true, force: true });
    const server = await fakeGitHub({ version, files });
    const updater = new Updater(fakeMessenger(), {
      version: '2.6.0', onReady() {}, releasesUrl: `http://127.0.0.1:${server.address().port}/latest`,
    });
    try {
      const st = await updater.check({ manual: true });
      assert.strictEqual(st.state, want, `${name}: ${JSON.stringify(st)}`);
      const staged = fs.existsSync(path.join(dataDir, 'updates', 'app-9.9.9.asar'));
      assert.strictEqual(staged, want === 'ready', `${name}: staged=${staged}`);
      if (want === 'ready') assert.strictEqual(st.from, 'GitHub');
      if (version === '2.6.0') assert.strictEqual(st.internet, 'latest');
    } finally {
      server.close();
    }
  }
  // No internet at all: said plainly, not shown as an error.
  const offline = new Updater(fakeMessenger(), { version: '2.6.0', onReady() {}, releasesUrl: 'http://127.0.0.1:9/latest' });
  const st = await offline.check({ manual: true });
  assert.deepStrictEqual([st.state, st.internet], ['none', 'offline']);
});
