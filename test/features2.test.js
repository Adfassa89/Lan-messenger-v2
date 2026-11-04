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

test('game invites and results are cleared 6 hours after the game was last played', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    const chat = alice.sendText(bob.id, 'Shift report attached');
    const g = alice.createGame(bob.id, 'ttt');
    const arena = alice.createWarlock(bob.id, 'thirteen');
    const result = alice.sendGameResult(bob.id, '🃏 13 – Bob wins!');
    await waitFor(() => bob.loadMessages(alice.id).length === 4, 5000, 'all arrived');
    assert.ok(bob.loadMessages(alice.id).find((m) => m.id === result.id).gameResult, 'result marked on the other PC');
    // Five hours later nothing has gone; a move resets the clock.
    const t0 = Date.now();
    assert.strictEqual(alice.purgeGames({ now: t0 + 5 * 3600000 }).length, 0);
    let purged = null;
    alice.once('purged', (list) => { purged = list; });
    const out = alice.purgeGames({ now: t0 + 6 * 3600000 + 1000 });
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(new Set(out[0].ids), new Set([g.id, arena.id, result.id]));
    assert.ok(purged);
    assert.deepStrictEqual(alice.loadMessages(bob.id).map((m) => m.id), [chat.id]);
    assert.strictEqual(alice.convs[bob.id].lastText, 'Shift report attached');
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('a new version of the app clears all game history at start', async () => {
  const [alice, bob] = makePair();
  alice.appVersion = '9.0.0';
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online, 8000, 'discovery');
    alice.createGame(bob.id, 'c4');
    alice.sendText(bob.id, '🔥 Warlock – Alice wins!'); // an old-style result
    alice.sendText(bob.id, 'Keep this');
    await alice.stop();
    alice.appVersion = '9.0.1';
    await alice.start();
    assert.deepStrictEqual(alice.loadMessages(bob.id).map((m) => m.text), ['Keep this']);
    // Restarting the same version leaves new games alone.
    alice.createGame(bob.id, 'c4');
    await alice.stop();
    await alice.start();
    assert.strictEqual(alice.loadMessages(bob.id).filter((m) => m.kind === 'game').length, 1);
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('@mentions, muting, forwarding and saved messages', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    const group = alice.createGroup('Pit crew', [bob.id]);
    await waitFor(() => bob.groups[group.slice(2)], 5000, 'group arrived');
    const m = alice.sendText(group, `@Bob please check pump 3`, { mentions: [bob.id, 'stranger'] });
    assert.deepStrictEqual(m.mentions, [bob.id], 'only members can be mentioned');
    await waitFor(() => bob.loadMessages(group).some((x) => x.id === m.id), 5000, 'mention arrived');
    assert.deepStrictEqual(bob.loadMessages(group).find((x) => x.id === m.id).mentions, [bob.id]);
    assert.strictEqual(bob.convs[group].mention, true);
    bob.markRead(group);
    assert.strictEqual(bob.convs[group].mention, false);
    // Mute for an hour, then always, then unmute.
    bob.muteConv(group, Date.now() + 3600000);
    assert.ok(bob.isMuted(group));
    bob.muteConv(group, -1);
    assert.ok(bob.isMuted(group));
    bob.muteConv(group, 0);
    assert.ok(!bob.isMuted(group));
    // Forward Alice's message to Alice in private: it says who wrote it.
    const f = bob.forward(group, m.id, alice.id);
    assert.deepStrictEqual(f.fwd, { name: alice.config.name });
    await waitFor(() => alice.loadMessages(bob.id).some((x) => x.id === f.id && x.fwd && x.fwd.name === alice.config.name), 5000, 'forward arrived');
    // Save and unsave.
    assert.strictEqual(bob.toggleSaved(group, m.id), true);
    assert.strictEqual(bob.savedMessages()[0].msg.id, m.id);
    assert.strictEqual(bob.toggleSaved(group, m.id), false);
    assert.strictEqual(bob.savedMessages().length, 0);
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('announcements track who read and who confirmed them', async () => {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    const a = alice.sendAnnouncement('broadcast', { title: 'Blasting at 14:00', text: 'Pit 3, keep 500 m away.', confirm: true });
    await waitFor(() => bob.loadMessages('broadcast').some((m) => m.id === a.id), 5000, 'arrived');
    const got = bob.loadMessages('broadcast').find((m) => m.id === a.id);
    assert.deepStrictEqual(got.announce, { title: 'Blasting at 14:00', confirm: true });
    bob.markRead('broadcast');
    await waitFor(() => (alice.store.getMessage('broadcast', a.id).readBy || []).includes(bob.id), 5000, 'read');
    bob.ackUrgent('broadcast', a.id);
    await waitFor(() => (alice.store.getMessage('broadcast', a.id).acks || []).includes(bob.id), 5000, 'confirmed');
    assert.ok(alice.store.getMessage('broadcast', a.id).ackAt[bob.id] > 0);
  } finally {
    await alice.stop();
    await bob.stop();
  }
});

test('storage: old received files and voice messages can be removed, own files never', async () => {
  const [alice] = makePair();
  const dl = alice.settings.downloadDir;
  fs.mkdirSync(dl, { recursive: true });
  const recv = path.join(dl, 'report.xlsx');
  fs.writeFileSync(recv, Buffer.alloc(5000));
  const mine = path.join(alice.dir, 'my-own-plan.pdf');
  fs.writeFileSync(mine, Buffer.alloc(3000));
  const old = Date.now() - 200 * 86400000;
  alice.store.addMessage('peer1', { id: 'r1', from: 'peer1', ts: old, kind: 'file', file: { name: 'report.xlsx', size: 5000, path: recv, state: 'done' } });
  alice.store.addMessage('peer1', { id: 's1', from: alice.id, ts: old, kind: 'file', file: { name: 'my-own-plan.pdf', size: 3000, path: mine, state: 'sent' } });
  const report = alice.storageReport();
  assert.strictEqual(report[0].files, 5000, 'only the received file counts');
  assert.deepStrictEqual(alice.cleanStorage({ olderThanDays: 365 }), { freed: 0, count: 0 }, 'not old enough');
  const r = alice.cleanStorage({ olderThanDays: 90 });
  assert.deepStrictEqual(r, { freed: 5000, count: 1 });
  assert.ok(!fs.existsSync(recv));
  assert.ok(fs.existsSync(mine), 'your own file stays');
  assert.strictEqual(alice.store.getMessage('peer1', 'r1').file.state, 'removed');
});
