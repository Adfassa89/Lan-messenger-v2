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
