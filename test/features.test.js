'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makePair, waitFor } = require('./helpers');
const { signMeta, verifyMeta, compareVersions, sha256FileSync } = require('../src/core/update');

// Starts two connected PCs, runs fn, always shuts them down.
async function withPair(fn) {
  const [alice, bob] = makePair();
  await alice.start();
  await bob.start();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');
    await fn(alice, bob);
  } finally {
    await alice.stop();
    await bob.stop();
  }
}

const msgAt = (m, conv, id) => m.store.getMessage(conv, id);

test('reply, reactions, edit and delete for everyone', () => withPair(async (alice, bob) => {
  const first = alice.sendText(bob.id, 'Is the haul road open?');
  await waitFor(() => msgAt(bob, alice.id, first.id), 5000, 'first');

  const reply = bob.sendText(alice.id, 'Yes, since 7am', { replyTo: first.id });
  const got = await waitFor(() => msgAt(alice, bob.id, reply.id), 5000, 'reply');
  assert.strictEqual(got.replyTo.id, first.id);
  assert.strictEqual(got.replyTo.preview, 'Is the haul road open?');

  alice.react(bob.id, reply.id, '👍');
  await waitFor(() => msgAt(bob, alice.id, reply.id).reactions?.['👍']?.includes(alice.id), 5000, 'reaction');
  alice.react(bob.id, reply.id, '👍'); // toggles off
  await waitFor(() => !msgAt(bob, alice.id, reply.id).reactions?.['👍'], 5000, 'reaction removed');

  alice.editMessage(bob.id, first.id, 'Is the north haul road open?');
  await waitFor(() => msgAt(bob, alice.id, first.id).text === 'Is the north haul road open?', 5000, 'edit');
  assert.ok(msgAt(bob, alice.id, first.id).edited);

  // Bob may not edit Alice's message.
  assert.throws(() => bob.editMessage(alice.id, first.id, 'hacked'));

  alice.unsendMessage(bob.id, first.id);
  await waitFor(() => msgAt(bob, alice.id, first.id).deleted, 5000, 'unsend');
  assert.strictEqual(msgAt(bob, alice.id, first.id).text, '');
}));

test('pins and polls are shared with everyone in a group', () => withPair(async (alice, bob) => {
  const conv = alice.createGroup('Shift A', [bob.id]);
  const poll = alice.createPoll(conv, 'Meeting day?', ['Monday', 'Tuesday', 'Wednesday']);
  await waitFor(() => msgAt(bob, conv, poll.id), 5000, 'poll arrives');
  assert.deepStrictEqual(msgAt(bob, conv, poll.id).poll.options, ['Monday', 'Tuesday', 'Wednesday']);

  bob.vote(conv, poll.id, [1]);
  alice.vote(conv, poll.id, [1]);
  await waitFor(() => msgAt(alice, conv, poll.id).poll.votes[bob.id]?.[0] === 1, 5000, 'bob vote at alice');
  await waitFor(() => msgAt(bob, conv, poll.id).poll.votes[alice.id]?.[0] === 1, 5000, 'alice vote at bob');

  // Single-choice polls keep one answer only.
  bob.vote(conv, poll.id, [0, 2]);
  await waitFor(() => msgAt(alice, conv, poll.id).poll.votes[bob.id].join() === '0', 5000, 'single choice');

  bob.pinMessage(conv, poll.id, true);
  await waitFor(() => alice.convs[conv].pins?.some((p) => p.id === poll.id), 5000, 'pinned');
  bob.pinMessage(conv, poll.id, false);
  await waitFor(() => !alice.convs[conv].pins.length, 5000, 'unpinned');
}));

test('urgent alerts report who acknowledged them', () => withPair(async (alice, bob) => {
  const alert = alice.sendText('broadcast', 'Blast in 15 minutes – clear zone B', { urgent: true });
  const got = await waitFor(() => msgAt(bob, 'broadcast', alert.id), 5000, 'alert');
  assert.strictEqual(got.urgent, true);
  bob.ackUrgent('broadcast', alert.id);
  await waitFor(() => msgAt(alice, 'broadcast', alert.id).acks.includes(bob.id), 5000, 'ack');
  assert.ok(msgAt(bob, 'broadcast', alert.id).acked);
}));

test('scheduled messages are sent at the chosen time', () => withPair(async (alice, bob) => {
  const item = alice.scheduleMessage(bob.id, 'Shift starts now', Date.now() + 500);
  assert.strictEqual(alice.scheduled.length, 1);
  const cancelled = alice.scheduleMessage(bob.id, 'never', Date.now() + 60000);
  alice.cancelScheduled(cancelled.id);
  await waitFor(() => bob.loadMessages(alice.id).some((m) => m.text === 'Shift starts now'), 10000, 'scheduled send');
  assert.strictEqual(alice.scheduled.length, 0);
  assert.ok(item.id);
}));

test('folders arrive complete with their structure', () => withPair(async (alice, bob) => {
  const src = path.join(alice.dir, 'Pit design');
  fs.mkdirSync(path.join(src, 'sections', 'north'), { recursive: true });
  const files = {
    'plan.dxf': crypto.randomBytes(300 * 1024),
    'sections/s1.csv': Buffer.from('x,y,z\n1,2,3\n'),
    'sections/north/s2.csv': crypto.randomBytes(1024 * 1024 + 7),
    'empty.txt': Buffer.alloc(0),
  };
  for (const [rel, data] of Object.entries(files)) fs.writeFileSync(path.join(src, rel), data);

  const msg = alice.sendFolder(bob.id, src);
  assert.strictEqual(msg.file.count, 4);
  const done = await waitFor(() => {
    const m = msgAt(bob, alice.id, msg.id);
    return m && m.file.state === 'done' && m;
  }, 15000, 'folder done');
  assert.strictEqual(path.basename(done.file.path), 'Pit design');
  for (const [rel, data] of Object.entries(files)) {
    assert.ok(fs.readFileSync(path.join(done.file.path, rel)).equals(data), rel);
  }
}));

test('voice messages download automatically even when auto-download is off', () => withPair(async (alice, bob) => {
  bob.setSettings({ autoAccept: false });
  const voice = path.join(alice.dir, 'voice.webm');
  fs.writeFileSync(voice, crypto.randomBytes(40000));
  const [msg] = alice.sendFiles(bob.id, [voice], { voice: true, duration: 3200 });
  const got = await waitFor(() => {
    const m = msgAt(bob, alice.id, msg.id);
    return m && m.file.state === 'done' && m;
  }, 10000, 'voice done');
  assert.strictEqual(got.file.voice, true);
  assert.strictEqual(got.file.duration, 3200);
}));

test('profile pictures are shared', () => withPair(async (alice, bob) => {
  const pic = `data:image/png;base64,${crypto.randomBytes(2000).toString('base64')}`;
  alice.setAvatar(pic);
  await waitFor(() => bob.contacts[alice.id].avatar === pic, 15000, 'avatar');
  assert.strictEqual(bob.getState().avatars[alice.id], pic);
}));

test('signed app updates are fetched and verified', () => withPair(async (alice, bob) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const pkg = path.join(alice.dir, 'app.asar');
  fs.writeFileSync(pkg, crypto.randomBytes(2 * 1024 * 1024));
  const meta = signMeta(priv, { version: '9.9.9', em: '44', sha256: sha256FileSync(pkg, fs), size: fs.statSync(pkg).size });
  alice.updatePackage = { version: '9.9.9', meta, size: meta.size, open: () => fs.createReadStream(pkg) };

  const dest = path.join(bob.dir, 'download.asar');
  const res = await bob.fetchUpdate(alice.id, dest);
  assert.ok(verifyMeta(pub, res.meta));
  assert.strictEqual(sha256FileSync(dest, fs), meta.sha256);

  // Any tampering breaks the signature.
  assert.ok(!verifyMeta(pub, { ...res.meta, version: '10.0.0' }));
  assert.ok(!verifyMeta(pub, { ...res.meta, sha256: '0'.repeat(64) }));
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.ok(!verifyMeta(other, res.meta));
}));

test('version comparison', () => {
  assert.strictEqual(compareVersions('2.1.0', '2.0.9'), 1);
  assert.strictEqual(compareVersions('2.0.0', '2.0'), 0);
  assert.strictEqual(compareVersions('2.0.10', '2.0.9'), 1);
  assert.strictEqual(compareVersions('1.9.9', '2.0.0'), -1);
});

test('folders with many files and slow disks never stall', () => withPair(async (alice, bob) => {
  const src = path.join(alice.dir, 'Survey');
  fs.mkdirSync(src);
  const files = {};
  for (let i = 0; i < 25; i++) {
    files[`f${String(i).padStart(2, '0')}.bin`] = crypto.randomBytes(i % 3 === 0 ? 3 * 1024 * 1024 : 10 + i);
  }
  for (const [rel, data] of Object.entries(files)) fs.writeFileSync(path.join(src, rel), data);
  // A tiny disk buffer makes every write report "buffer full", so the
  // socket pauses after each chunk, like a slow network drive.
  const origCreate = fs.createWriteStream;
  fs.createWriteStream = (p, opts) => origCreate(p, { ...opts, highWaterMark: 1 });
  try {
    const msg = alice.sendFolder(bob.id, src);
    const done = await waitFor(() => {
      const m = msgAt(bob, alice.id, msg.id);
      return m && m.file.state === 'done' && m;
    }, 30000, 'folder done');
    for (const [rel, data] of Object.entries(files)) {
      assert.ok(fs.readFileSync(path.join(done.file.path, rel)).equals(data), rel);
    }
  } finally {
    fs.createWriteStream = origCreate;
  }
}));

test('calls are recorded in the chat history', () => withPair(async (alice) => {
  const bobId = [...alice.peers.keys()][0];
  alice.logCall(bobId, { video: true, outgoing: true, duration: 95000 });
  const missed = alice.logCall(bobId, { missed: true, peerId: bobId });
  const list = alice.loadMessages(bobId);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list[0].call, { video: true, outgoing: true, duration: 95000, missed: false, declined: false });
  assert.strictEqual(missed.from, bobId);
  assert.strictEqual(alice.convs[bobId].unread, 1);
  assert.strictEqual(alice.convs[bobId].lastText, '📵');
}));

test('chess moves travel between PCs and illegal moves are refused', () => withPair(async (alice, bob) => {
  const game = alice.createGame(bob.id, 'chess');
  await waitFor(() => msgAt(bob, alice.id, game.id), 5000, 'game invite');
  const [white, black] = game.game.players.map((id) => (id === alice.id ? alice : bob));
  const convOf = (m) => (m === alice ? bob.id : alice.id);
  white.gameMove(convOf(white), game.id, { from: 'e2', to: 'e4' });
  await waitFor(() => msgAt(black, convOf(black), game.id).game.moves.length === 1, 5000, 'move 1');
  assert.throws(() => white.gameMove(convOf(white), game.id, { from: 'd2', to: 'd4' }), /not allowed/);
  assert.throws(() => black.gameMove(convOf(black), game.id, { from: 'e7', to: 'e3' }), /not allowed/);
  black.gameMove(convOf(black), game.id, { from: 'e7', to: 'e5' });
  await waitFor(() => msgAt(white, convOf(white), game.id).game.moves.length === 2, 5000, 'move 2');
  black.gameMove(convOf(black), game.id, { resign: false, draw: 'offer' });
  await waitFor(() => msgAt(white, convOf(white), game.id).game.moves.length === 3, 5000, 'draw offer');
  // A tampered move sent directly is ignored by the other PC.
  const before = msgAt(white, convOf(white), game.id).game.moves.length;
  black._sendMeta(convOf(black), { type: 'game-move', id: game.id, m: { from: 'a7', to: 'a2' }, n: 3 });
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(msgAt(white, convOf(white), game.id).game.moves.length, before);
}));

test('a PC whose firewall blocks incoming connections can still chat, play and share files', async () => {
  const [alice, bob] = makePair();
  // Alice's firewall: every incoming connection is dropped, and only replies
  // to her own discovery questions get through (like Windows Firewall).
  alice._onInbound = (socket) => socket.destroy();
  let askedAt = 0;
  await bob.start();
  await alice.start();
  const q = alice.discovery.query.bind(alice.discovery);
  alice.discovery.query = () => { askedAt = Date.now(); q(); };
  const onMessage = alice.discovery._onMessage.bind(alice.discovery);
  alice.discovery._onMessage = (buf, rinfo) => { if (Date.now() - askedAt < 1500) onMessage(buf, rinfo); };
  alice.discovery.query();
  try {
    await waitFor(() => alice.peers.get(bob.id)?.online && bob.peers.get(alice.id)?.online, 8000, 'discovery');

    // Bob cannot connect to Alice, yet his messages reach her.
    const hi = bob.sendText(alice.id, 'Can you hear me?');
    await waitFor(() => msgAt(alice, bob.id, hi.id), 8000, 'message to the blocked PC');
    await waitFor(() => msgAt(bob, alice.id, hi.id).status === 'delivered', 5000, 'delivered');

    // Tic-tac-toe in both directions.
    const game = bob.createGame(alice.id, 'ttt');
    await waitFor(() => msgAt(alice, bob.id, game.id), 5000, 'game invite');
    bob.gameMove(alice.id, game.id, { cell: 4 });
    await waitFor(() => msgAt(alice, bob.id, game.id).game.moves.length === 1, 5000, 'move 1');
    alice.gameMove(bob.id, game.id, { cell: 0 });
    await waitFor(() => msgAt(bob, alice.id, game.id).game.moves.length === 2, 5000, 'move 2');

    // Bob downloads a file from Alice: she connects back to him to send it.
    const src = path.join(alice.dir, 'plan.bin');
    const data = crypto.randomBytes(3 * 1024 * 1024 + 7);
    fs.writeFileSync(src, data);
    const [offer] = alice.sendFiles(bob.id, [src]);
    await waitFor(() => msgAt(bob, alice.id, offer.id), 5000, 'file offer');
    bob.acceptFile(alice.id, offer.id);
    const got = await waitFor(() => {
      const m = msgAt(bob, alice.id, offer.id);
      return m.file.state === 'done' && m;
    }, 20000, 'file from the blocked PC');
    assert.ok(fs.readFileSync(got.file.path).equals(data));

    // App updates are shared from the blocked PC the same way.
    const pkg = path.join(alice.dir, 'app.asar');
    fs.writeFileSync(pkg, crypto.randomBytes(512 * 1024));
    alice.updatePackage = { version: '9.9.9', meta: { size: 512 * 1024 }, size: 512 * 1024, open: () => fs.createReadStream(pkg) };
    const dest = path.join(bob.dir, 'update.asar');
    await bob.fetchUpdate(alice.id, dest);
    assert.ok(fs.readFileSync(dest).equals(fs.readFileSync(pkg)));
  } finally {
    await alice.stop();
    await bob.stop();
  }
});
