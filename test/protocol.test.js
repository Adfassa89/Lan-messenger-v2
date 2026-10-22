'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { FrameReader, frame, seal, open, makeKeyPair, deriveKey } = require('../src/core/protocol');
const { sanitizeFileName } = require('../src/core/files');

test('frames survive arbitrary TCP chunking', () => {
  const payloads = [Buffer.from('a'), Buffer.alloc(0), crypto.randomBytes(70000), Buffer.from('end')];
  const wire = Buffer.concat(payloads.map(frame));
  const got = [];
  const r = new FrameReader((f) => got.push(Buffer.from(f)));
  for (let i = 0; i < wire.length; i += 7) r.push(wire.subarray(i, i + 7));
  assert.deepStrictEqual(got, payloads);
});

test('both sides derive the same key and tampering is detected', () => {
  const a = makeKeyPair();
  const b = makeKeyPair();
  const ka = deriveKey(a.privateKey, b.pub, 'A', 'B');
  const kb = deriveKey(b.privateKey, a.pub, 'B', 'A');
  assert.ok(ka.equals(kb));
  const sealed = seal(ka, 1, Buffer.from('secret'));
  assert.strictEqual(open(kb, sealed).payload.toString(), 'secret');
  sealed[sealed.length - 1] ^= 1;
  assert.throws(() => open(kb, sealed));
});

test('file names from the network are made safe for Windows', () => {
  assert.strictEqual(sanitizeFileName('..\\..\\Windows\\evil.exe'), 'evil.exe');
  assert.strictEqual(sanitizeFileName('a:b*c?.txt'), 'a_b_c_.txt');
  assert.strictEqual(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.strictEqual(sanitizeFileName('report. '), 'report');
  assert.strictEqual(sanitizeFileName(''), 'file');
});
