'use strict';
// Shared tuning for calls, voice rooms and screen sharing:
//  - voice: Opus with in-band error correction (sound survives dropped packets
//    on Wi-Fi) and DTX (next to nothing is sent while you are silent);
//  - video: quality steps down as more people join, so a 6-person call does not
//    send six 720p streams from every PC;
//  - codecs: H.264 first where the PC has it (most office PCs encode it on the
//    graphics chip, which spares the processor), VP8 otherwise;
//  - quality: round-trip time, packet loss and jitter for each connection.

const RtcTune = (() => {
  const VOICE_BITRATE = 32000;

  // Asks the other side for DTX and FEC and caps the voice bitrate. The
  // parameters in a description tell the other side how to send to us, so
  // both PCs tune their own description.
  function sdp(desc) {
    if (!desc || !desc.sdp) return desc;
    const lines = desc.sdp.split('\r\n');
    const opus = new Set();
    for (const l of lines) {
      const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
      if (m) opus.add(m[1]);
    }
    const out = lines.map((l) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (!m || !opus.has(m[1])) return l;
      const params = new Map(m[2].split(';').map((kv) => kv.trim()).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]; }));
      params.set('useinbandfec', '1');
      params.set('usedtx', '1');
      params.set('maxaveragebitrate', String(VOICE_BITRATE));
      params.set('stereo', '0');
      return `a=fmtp:${m[1]} ${[...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')}`;
    });
    return { type: desc.type, sdp: out.join('\r\n') };
  }

  // H.264 first (hardware encoding on most PCs), then VP8, then the rest.
  function preferCodecs(transceiver) {
    try {
      if (!transceiver || !transceiver.setCodecPreferences || !window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
      const caps = RTCRtpReceiver.getCapabilities('video');
      if (!caps || !caps.codecs) return;
      const rank = (c) => {
        const mime = c.mimeType.toLowerCase();
        if (mime === 'video/h264') return /packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1;
        if (mime === 'video/vp8') return 2;
        if (mime === 'video/rtx' || mime === 'video/red' || mime === 'video/ulpfec') return 9;
        return 5;
      };
      const sorted = caps.codecs.slice().sort((a, b) => rank(a) - rank(b));
      transceiver.setCodecPreferences(sorted);
    } catch { /* keep the browser's own order */ }
  }

  // How sharp video may be with this many other people in the call.
  function videoLimits(others) {
    if (others <= 1) return { maxBitrate: 2_500_000, scaleResolutionDownBy: 1, maxFramerate: 24 }; // 720p
    if (others <= 3) return { maxBitrate: 1_000_000, scaleResolutionDownBy: 1.5, maxFramerate: 24 }; // ~480p
    return { maxBitrate: 500_000, scaleResolutionDownBy: 2, maxFramerate: 20 }; // ~360p
  }

  async function setEncoding(sender, patch, extra = {}) {
    if (!sender) return;
    try {
      const p = sender.getParameters();
      p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
      Object.assign(p.encodings[0], patch);
      Object.assign(p, extra);
      await sender.setParameters(p);
    } catch { /* not supported or not negotiated yet */ }
  }

  // Voice goes first when the network is busy.
  function tuneAudio(sender) {
    return setEncoding(sender, { maxBitrate: VOICE_BITRATE + 8000, priority: 'high', networkPriority: 'high' });
  }

  // Round-trip time (ms), packet loss (%) and jitter (ms) of a connection,
  // compared with the previous measurement.
  async function measure(pc, prev = {}) {
    const out = { rtt: null, loss: 0, jitter: 0, recv: 0, lost: 0 };
    try {
      const stats = await pc.getStats();
      let pairId = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && (r.id === pairId || (!pairId && r.nominated && r.state === 'succeeded')) && r.currentRoundTripTime !== undefined) out.rtt = Math.round(r.currentRoundTripTime * 1000);
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          out.recv += r.packetsReceived || 0;
          out.lost += r.packetsLost || 0;
          out.jitter = Math.max(out.jitter, Math.round((r.jitter || 0) * 1000));
        }
      });
    } catch { return null; }
    const dRecv = out.recv - (prev.recv || 0);
    const dLost = out.lost - (prev.lost || 0);
    out.loss = dRecv + dLost > 0 ? Math.max(0, Math.round((dLost / (dRecv + dLost)) * 1000) / 10) : 0;
    out.level = (out.rtt !== null && out.rtt > 300) || out.loss > 8 ? 'poor'
      : (out.rtt !== null && out.rtt > 120) || out.loss > 2 || out.jitter > 40 ? 'fair' : 'good';
    return out;
  }

  return { sdp, preferCodecs, videoLimits, setEncoding, tuneAudio, measure };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RtcTune;
