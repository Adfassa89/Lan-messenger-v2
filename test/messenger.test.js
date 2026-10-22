'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Messenger } = require('../src/core/messenger');

let portBase = 41000 + Math.floor(Math.random() * 2000) * 4;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lanmsg-${label}-`));
}

// Two "PCs" on one machine: different ports, each told where the other is.
function makePair() {
  const a = { udp: portBase++, tcp: portBase++ };
  const b = { udp: portBase++, tcp: portBase++ };
  const mk = (me, other, name) => {
    const dir = tmpDir(name);
    const m = new Messenger({
      dataDir: dir,
      downloadDir: path.join(dir, 'downloads'),
      tcpPort: me.tcp,
      udpPort: me.udp,
      broadcast: false,
      defaultName: name,
    });
    m.config.manualPeers = [`127.0.0.1:${other.udp}`];
    m.dir = dir;
    m.ports = me;
    return m;
  };
  return [mk(a, b, 'Alice'), mk(b, a, 'Bob')];
}

function waitFor(fn, timeout = 8000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('peers discover each other and exchange messages with receipts', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    assert.strictEqual(alice.peers.get(bob.id).name, 'Bob');

    const sent = alice.sendText(bob.id, 'Hello Bob 👋');
    const got = await waitFor(() => bob.loadMessages(alice.id).find((m) => m.id === sent.id), 5000, 'message');
    assert.strictEqual(got.text, 'Hello Bob 👋');
    assert.strictEqual(bob.convs[alice.id].unread, 1);

    await waitFor(() => alice.store.getMessage(bob.id, sent.id).status === 'delivered', 5000, 'delivered');
    bob.markRead(alice.id);
    await waitFor(() => alice.store.getMessage(bob.id, sent.id).status === 'read', 5000, 'read');
    assert.strictEqual(bob.convs[alice.id].unread, 0);

    // Reply in the other direction.
    bob.sendText(alice.id, 'Hi Alice');
    await waitFor(() => alice.loadMessages(bob.id).some((m) => m.text === 'Hi Alice'), 5000, 'reply');
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('messages to an offline person are delivered when they come online', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  await waitFor(() => alice.peers.get(bob.id)?.online, 8000, 'discovery');
  const bobId = bob.id;
  await bob.stop();
  await waitFor(() => !alice.peers.get(bobId).online, 3000, 'bye');

  const msg = alice.sendText(bobId, 'Read this when you are back');
  assert.strictEqual(alice.store.getMessage(bobId, msg.id).status, 'queued');
  assert.strictEqual(alice.outbox.length, 1);

  // Bob's PC starts again (same data folder = same identity).
  const bob2 = new Messenger({
    dataDir: bob.dir, tcpPort: bob.ports.tcp, udpPort: bob.ports.udp, broadcast: false,
  });
  await bob2.start();
  try {
    assert.strictEqual(bob2.id, bobId);
    await waitFor(() => bob2.loadMessages(alice.id).some((m) => m.id === msg.id), 10000, 'queued delivery');
    await waitFor(() => alice.outbox.length === 0, 5000, 'outbox empty');
    assert.strictEqual(alice.store.getMessage(bobId, msg.id).status, 'delivered');
  } finally {
    await alice.stop();
    await bob2.stop();
  }
});

test('file transfer is complete and byte-identical', async () => {
  const [alice, bob] = makePair();
  bob.setSettings({ autoAccept: true, autoAcceptMaxMB: 100 });
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    const src = path.join(alice.dir, 'report.bin');
    const data = crypto.randomBytes(5 * 1024 * 1024 + 123);
    fs.writeFileSync(src, data);

    const [msg] = alice.sendFiles(alice.recipients(bob.id)[0], [src]);
    const done = await waitFor(() => {
      const m = bob.store.getMessage(alice.id, msg.id);
      return m && m.file.state === 'done' && m;
    }, 15000, 'file done');
    assert.strictEqual(path.basename(done.file.path), 'report.bin');
    assert.ok(fs.readFileSync(done.file.path).equals(data));

    // Same name again must not overwrite the first file.
    const [msg2] = alice.sendFiles(bob.id, [src]);
    const done2 = await waitFor(() => {
      const m = bob.store.getMessage(alice.id, msg2.id);
      return m && m.file.state === 'done' && m;
    }, 15000, 'second file');
    assert.strictEqual(path.basename(done2.file.path), 'report (1).bin');
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('group chat reaches every member', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online, 8000, 'discovery');
    const conv = alice.createGroup('Planning team', [bob.id]);
    alice.sendText(conv, 'Shift plan is ready');
    await waitFor(() => bob.loadMessages(conv).some((m) => m.text === 'Shift plan is ready'), 5000, 'group msg');
    assert.strictEqual(bob.groups[conv.slice(2)].name, 'Planning team');

    bob.sendText(conv, 'Thanks');
    await waitFor(() => alice.loadMessages(conv).some((m) => m.text === 'Thanks'), 5000, 'group reply');
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('history survives a restart', async () => {
  const dir = tmpDir('persist');
  const m1 = new Messenger({ dataDir: dir, tcpPort: portBase++, udpPort: portBase++, broadcast: false });
  await m1.start();
  m1.peers.set('someone', { id: 'someone', name: 'X', online: false });
  const msg = m1.sendText('someone', 'saved?');
  await m1.stop();

  const m2 = new Messenger({ dataDir: dir, tcpPort: portBase++, udpPort: portBase++, broadcast: false });
  assert.strictEqual(m2.loadMessages('someone')[0].id, msg.id);
  assert.strictEqual(m2.outbox.length, 1);
});

test('broadcast reaches everyone in the shared "Everyone" chat', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online, 8000, 'discovery');
    alice.sendText('broadcast', 'Blasting at 14:00 – clear the pit');
    await waitFor(() => bob.loadMessages('broadcast').some((m) => m.text.startsWith('Blasting')), 5000, 'broadcast');
    assert.strictEqual(bob.convs.broadcast.unread, 1);
  } finally {
    await alice.stop();
    await bob.stop();
  }
});
