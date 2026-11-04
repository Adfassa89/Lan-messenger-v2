'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RtcTune = require('../src/renderer/rtc-tune');

const OFFER = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 63', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ''].join('\r\n');

test('voice asks for error correction and silence suppression, at a low bitrate', () => {
  const out = RtcTune.sdp({ type: 'offer', sdp: OFFER });
  const fmtp = out.sdp.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
  for (const p of ['minptime=10', 'useinbandfec=1', 'usedtx=1', 'maxaveragebitrate=32000', 'stereo=0']) assert.ok(fmtp.includes(p), p);
  assert.ok(out.sdp.includes('a=fmtp:63 111/111'), 'other codecs untouched');
  assert.strictEqual(out.type, 'offer');
});

test('video gets lighter as more people join', () => {
  const one = RtcTune.videoLimits(1);
  const three = RtcTune.videoLimits(3);
  const five = RtcTune.videoLimits(5);
  assert.ok(one.maxBitrate > three.maxBitrate && three.maxBitrate > five.maxBitrate);
  assert.ok(one.scaleResolutionDownBy < five.scaleResolutionDownBy);
  // A 6-person call: about 2.5 Mbps sent per PC instead of 12.5.
  assert.ok(five.maxBitrate * 5 <= 2_500_000);
});
