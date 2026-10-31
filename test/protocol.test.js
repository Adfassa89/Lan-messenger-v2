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

test('Windows Firewall check results and the rules the "Allow" button adds', () => {
  const { parseCheck, allowScript, checkScript } = require('../src/main/firewall');
  assert.strictEqual(parseCheck('3,2,0\r\n'), 'ok');
  assert.strictEqual(parseCheck('3,2,1'), 'blocked'); // a block rule wins over allow rules
  assert.strictEqual(parseCheck('3,0,0'), 'missing');
  assert.strictEqual(parseCheck('0,0,0'), 'off');
  assert.strictEqual(parseCheck('Get-NetFirewallRule : not recognized'), 'unknown');
  const exe = 'C:\\Users\\Ali\\AppData\\Local\\Temp\\2abc\\LAN Messenger 2.exe';
  const script = allowScript(exe, 50101, 50100);
  assert.match(script, /delete rule name=all program="C:\\Users\\Ali\\AppData\\Local\\Temp\\2abc\\LAN Messenger 2\.exe"/);
  assert.match(script, /add rule name="LAN Messenger 2" dir=in action=allow program="[^"]+LAN Messenger 2\.exe"/);
  assert.match(script, /protocol=TCP localport=50101/);
  assert.match(script, /protocol=UDP localport=50100/);
  assert.match(checkScript("C:\\it's\\app.exe", 50101, 50100), /'C:\\it''s\\app\.exe'/); // quotes escaped for PowerShell
});
