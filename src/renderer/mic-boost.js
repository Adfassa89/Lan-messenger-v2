'use strict';
// Microphone boost (Settings → Microphone boost, 100 – 300 %), for quiet
// microphones such as some wireless earbuds. The microphone's sound goes
// through a gain stage, then a soft limiter that stops loud parts from distorting,
// into a new track that is recorded or sent in calls instead of the original.

const MicBoost = (() => {
  const clamp = (pct) => Math.max(100, Math.min(300, Math.round(Number(pct) || 100)));
  // Soft limiter curve: unchanged up to 0.7, then rounded off smoothly towards 0.98.
  const HEADROOM = 4;
  const CURVE = (() => {
    const n = 4096;
    const c = new Float32Array(n);
    const knee = 0.7;
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * HEADROOM;
      const a = Math.abs(x);
      const y = a <= knee ? a : knee + (0.98 - knee) * Math.tanh((a - knee) / (0.98 - knee));
      c[i] = Math.sign(x) * y;
    }
    return c;
  })();

  // rawTrack: the microphone's audio track. Returns { track, raw, setGain(pct), stop() }.
  function create(rawTrack, pct) {
    let ctx = null;
    try {
      ctx = new AudioContext();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
      const gain = ctx.createGain();
      gain.gain.value = clamp(pct) / 100 / HEADROOM;
      // A soft limiter: the shaper's input range [-1, 1] stands for [-HEADROOM, HEADROOM]
      // after the boost, so up to 4x full scale is shaped instead of cut off hard.
      const limiter = ctx.createWaveShaper();
      limiter.curve = CURVE;
      limiter.oversample = '4x';
      const dest = ctx.createMediaStreamDestination();
      src.connect(gain).connect(limiter).connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      return {
        track,
        raw: rawTrack,
        setGain(p) { gain.gain.setTargetAtTime(clamp(p) / 100 / HEADROOM, ctx.currentTime, 0.04); },
        stop() {
          try { rawTrack.stop(); } catch { /* already stopped */ }
          try { track.stop(); } catch { /* already stopped */ }
          ctx.close().catch(() => {});
        },
      };
    } catch {
      // Web Audio not available: use the microphone as it is.
      if (ctx) ctx.close().catch(() => {});
      return { track: rawTrack, raw: rawTrack, setGain() {}, stop() { try { rawTrack.stop(); } catch { /* ignore */ } } };
    }
  }

  return { create, clamp };
})();
