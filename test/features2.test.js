'use strict';
// "Seen by" in groups, the Files tab, the Downloads list, Remote help input.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makePair, waitFor } = require('./helpers');
const { RemoteInput, vkFor } = require('../src/main/remote-input');

test('group messages record who read them and when', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online, 8000, 'discovery');
    const conv = alice.createGroup('Pit crew', [bob.id]);
    const msg = alice.sendText(conv, 'Blast at 14:00');
    await waitFor(() => bob.loadMessages(conv).some((m) => m.id === msg.id), 5000, 'arrived');
    const before = Date.now();
    bob.markRead(conv);
    const seen = await waitFor(() => {
      const m = alice.store.getMessage(conv, msg.id);
      return m.readBy.includes(bob.id) && m;
    }, 5000, 'seen');
    assert.ok(seen.readAt[bob.id] >= before - 1000 && seen.readAt[bob.id] <= Date.now());
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('Files tab lists a chat\'s files; Downloads lists received files until cleared', async () => {
  const [alice, bob] = makePair();
  bob.setSettings({ autoAccept: true, autoAcceptMaxMB: 100 });
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    const src = path.join(alice.dir, 'plan.pdf');
    fs.writeFileSync(src, 'pdf');
    const [msg] = alice.sendFiles(bob.id, [src]);
    await waitFor(() => bob.store.getMessage(alice.id, msg.id)?.file.state === 'done', 15000, 'downloaded');
    alice.sendText(bob.id, 'not a file');
    assert.deepStrictEqual(alice.chatFiles(bob.id).map((f) => f.file.name), ['plan.pdf']);
    const dl = bob.downloads();
    assert.strictEqual(dl.length, 1);
    assert.strictEqual(dl[0].file.name, 'plan.pdf');
    assert.ok(dl[0].at > 0);
    assert.strictEqual(alice.downloads().length, 0, 'files you sent are not downloads');
    bob.setSettings({ downloadsClearedAt: Date.now() + 1 });
    assert.strictEqual(bob.downloads().length, 0);
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('remote help turns mouse and key events into input commands and lets go of held keys', () => {
  const r = new RemoteInput({ log: [] });
  r.start();
  r.move(10.4, 20.6);
  r.button(0, true);
  r.key('ControlLeft', true);
  r.key('KeyC', true);
  r.key('NotAKey', true);
  r.wheel(100);
  r.stop();
  assert.deepStrictEqual(r.log, ['m 10 21', 'd l', 'k 162 1 0', 'k 67 1 0', 'w -120', 'u l', 'k 162 0 0', 'k 67 0 0']);
  assert.deepStrictEqual(vkFor('ArrowUp'), { vk: 0x26, ext: 1 });
  assert.deepStrictEqual(vkFor('F5'), { vk: 0x74, ext: 0 });
});

test('Tank can only be started and received in a private chat', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    const group = alice.createGroup('Pit crew', [bob.id]);
    assert.throws(() => alice.createWarlock(group, 'tank'), /private chat/);
    const g = alice.createWarlock(bob.id, 'tank');
    await waitFor(() => bob.loadMessages(alice.id).some((m) => m.id === g.id), 5000, 'invite arrived');
    assert.strictEqual(bob.loadMessages(alice.id).find((m) => m.id === g.id).game.type, 'tank');
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('two members of a group can play a game; the others watch', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    const group = alice.createGroup('Pit crew', [bob.id]);
    await waitFor(() => bob.groups[group.slice(2)], 5000, 'group arrived');
    assert.throws(() => alice.createGame(group, 'ttt'), /Choose who/);
    const g = alice.createGame(group, 'ttt', { opponent: bob.id });
    await waitFor(() => bob.loadMessages(group).some((m) => m.id === g.id), 5000, 'invite arrived');
    const first = g.game.players[0] === alice.id ? alice : bob;
    first.gameMove(group, g.id, { cell: 4 });
    const other = first === alice ? bob : alice;
    await waitFor(() => other.loadMessages(group).find((m) => m.id === g.id).game.moves.length === 1, 5000, 'move arrived');
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('PCs pass on who else is online, so PCs that cannot hear each other still meet', async () => {
  const [alice, bob] = makePair();
  const { Messenger } = require('../src/core/messenger');
  const { tmpDir, nextPort } = require('./helpers');
  const dir = tmpDir('Carol');
  const carol = new Messenger({ dataDir: dir, downloadDir: path.join(dir, 'downloads'), tcpPort: nextPort(), udpPort: nextPort(), broadcast: false, defaultName: 'Carol' });
  // Carol only knows Bob; Alice only knows Bob.
  carol.config.manualPeers = [`127.0.0.1:${bob.ports.udp}`];
  bob.config.manualPeers.push(`127.0.0.1:${carol.udpPort}`);
  await alice.start();
  await bob.start();
  await carol.start();
  try {
    await waitFor(() => alice.peers.get(carol.id)?.online && carol.peers.get(alice.id)?.online, 20000, 'Alice and Carol meet through Bob');
    const msg = alice.sendText(carol.id, 'Hello from the other subnet');
    await waitFor(() => carol.loadMessages(alice.id).some((m) => m.id === msg.id), 8000, 'message delivered');
  } finally {
    await alice.stop();
    await bob.stop();
    await carol.stop();
  }
});
