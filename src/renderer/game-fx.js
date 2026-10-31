'use strict';
// Game sounds and the end-of-game screen, shared by every game window.
// Sounds are synthesised with Web Audio, so no sound files are needed.
// "Game sounds" can be switched off (saved per PC).

const Sfx = (() => {
  const PREFS_KEY = 'lanmsg.games.v1';
  let ctx = null;

  function enabled() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').sounds !== false;
    } catch {
      return true;
    }
  }

  function audio() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // A tone with a quick attack and decay.
  function tone(freq, { at = 0, len = 0.12, vol = 0.12, type = 'sine', slide = 0 } = {}) {
    const a = audio();
    const t0 = a.currentTime + at;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + len);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    o.connect(g).connect(a.destination);
    o.start(t0);
    o.stop(t0 + len + 0.02);
  }

  // A short filtered noise burst: the "knock" of a piece on wood.
  function knock({ at = 0, freq = 900, len = 0.06, vol = 0.35, q = 1.2 } = {}) {
    const a = audio();
    const t0 = a.currentTime + at;
    const n = Math.floor(a.sampleRate * len);
    const buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = a.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(a.destination);
    src.start(t0);
  }

  const notes = (list, gap, opts) => list.forEach((f, i) => tone(f, { at: i * gap, ...opts }));
  // A bright chord for line clears, a semitone higher for each combo step.
  const clearChord = (freqs, combo) => {
    const up = 2 ** (Math.min(Math.max(combo, 0), 12) / 12);
    freqs.forEach((f, i) => tone(f * up, { at: i * 0.035, len: 0.22, vol: 0.06, type: 'square' }));
    knock({ freq: 2400, len: 0.04, vol: 0.2 });
  };

  const SOUNDS = {
    move: () => { knock({ freq: 750 }); tone(170, { len: 0.07, vol: 0.08 }); },
    capture: () => { knock({ freq: 1300, vol: 0.45 }); knock({ at: 0.035, freq: 600, vol: 0.3 }); tone(140, { len: 0.08, vol: 0.08 }); },
    castle: () => { knock({ freq: 750 }); knock({ at: 0.09, freq: 800 }); },
    check: () => { knock({ freq: 900 }); tone(1046, { at: 0.03, len: 0.18, vol: 0.07, type: 'triangle' }); },
    promote: () => { knock({ freq: 800 }); notes([784, 1046], 0.07, { len: 0.16, vol: 0.06, type: 'triangle' }); },
    premove: () => knock({ freq: 1500, len: 0.03, vol: 0.18 }),
    illegal: () => tone(110, { len: 0.16, vol: 0.09, type: 'square', slide: 0.8 }),
    start: () => notes([523, 784], 0.1, { len: 0.22, vol: 0.06, type: 'triangle' }),
    lowtime: () => notes([880, 880], 0.14, { len: 0.08, vol: 0.06, type: 'square' }),
    place: () => { tone(660, { len: 0.1, vol: 0.08, type: 'triangle', slide: 1.4 }); knock({ freq: 1800, len: 0.03, vol: 0.12 }); },
    drop: () => { tone(320, { len: 0.12, vol: 0.09, slide: 0.55 }); knock({ at: 0.09, freq: 420, vol: 0.4, len: 0.08 }); },
    notify: () => notes([660, 880], 0.08, { len: 0.12, vol: 0.05, type: 'triangle' }),
    win: () => { notes([523, 659, 784, 1046], 0.11, { len: 0.28, vol: 0.07, type: 'triangle' }); tone(1318, { at: 0.46, len: 0.5, vol: 0.05, type: 'sine' }); },
    lose: () => notes([392, 330, 262, 196], 0.16, { len: 0.32, vol: 0.06, type: 'sine' }),
    draw: () => notes([523, 523, 440], 0.14, { len: 0.22, vol: 0.05, type: 'triangle' }),
    // Tetris
    shift: () => knock({ freq: 2200, len: 0.02, vol: 0.06 }),
    rotate: () => tone(880, { len: 0.04, vol: 0.03, type: 'triangle' }),
    lock: () => knock({ freq: 500, len: 0.05, vol: 0.25 }),
    clear: (lines = 1) => notes([523, 659, 784, 1046].slice(0, Math.min(4, lines + 1)), 0.05, { len: 0.16, vol: 0.06, type: 'square' }),
    garbage: () => tone(130, { len: 0.18, vol: 0.09, type: 'sawtooth', slide: 0.6 }),
    countdown: () => tone(440, { len: 0.08, vol: 0.06, type: 'triangle' }),
    go: () => notes([660, 990], 0.06, { len: 0.2, vol: 0.07, type: 'triangle' }),
    harddrop: () => { knock({ freq: 260, len: 0.09, vol: 0.55, q: 0.8 }); tone(90, { len: 0.12, vol: 0.12, slide: 0.6 }); },
    // Line clears rise with the number of lines; combos raise the pitch.
    single: (combo = 0) => clearChord([523], combo),
    double: (combo = 0) => clearChord([523, 659], combo),
    triple: (combo = 0) => clearChord([523, 659, 784], combo),
    quad: (combo = 0) => { clearChord([523, 659, 784, 1046], combo); tone(130, { len: 0.35, vol: 0.12, type: 'sawtooth', slide: 0.5 }); },
    tspin: () => { notes([392, 587, 784, 1175], 0.045, { len: 0.18, vol: 0.06, type: 'square' }); tone(1568, { at: 0.2, len: 0.25, vol: 0.04 }); },
    b2b: () => tone(1318, { at: 0.12, len: 0.22, vol: 0.05, type: 'triangle' }),
    allclear: () => notes([523, 659, 784, 1046, 1318, 1568], 0.06, { len: 0.3, vol: 0.06, type: 'triangle' }),
    send: (lines = 1) => tone(300 + lines * 60, { len: 0.22, vol: 0.06, type: 'sawtooth', slide: 3 }),
    garbageRise: () => { tone(110, { len: 0.25, vol: 0.1, type: 'square', slide: 0.7 }); knock({ freq: 180, len: 0.1, vol: 0.4 }); },
    ko: () => { tone(220, { len: 0.6, vol: 0.12, type: 'sawtooth', slide: 0.25 }); knock({ freq: 120, len: 0.25, vol: 0.6, q: 0.6 }); },
    // Warlock
    wlFire: () => { tone(160, { len: 0.25, vol: 0.08, type: 'sawtooth', slide: 2.2 }); knock({ freq: 900, len: 0.12, vol: 0.25, q: 0.7 }); },
    wlWhoosh: () => knock({ freq: 1400, len: 0.18, vol: 0.25, q: 0.5 }),
    wlBoom: () => { knock({ freq: 220, len: 0.3, vol: 0.6, q: 0.6 }); tone(70, { len: 0.3, vol: 0.12, slide: 0.5 }); },
    wlClash: () => { knock({ freq: 1800, len: 0.12, vol: 0.4 }); tone(900, { len: 0.12, vol: 0.05, type: 'square', slide: 0.5 }); },
    wlBolt: () => { knock({ freq: 3000, len: 0.25, vol: 0.5, q: 0.4 }); tone(1200, { len: 0.2, vol: 0.05, type: 'sawtooth', slide: 0.3 }); },
    wlBlink: () => notes([1046, 1568, 2093], 0.03, { len: 0.12, vol: 0.05, type: 'sine' }),
    wlScourge: () => { tone(110, { len: 0.4, vol: 0.12, type: 'sawtooth', slide: 0.6 }); knock({ freq: 300, len: 0.3, vol: 0.5 }); },
    wlMeteor: () => { knock({ freq: 120, len: 0.6, vol: 0.9, q: 0.5 }); tone(55, { len: 0.6, vol: 0.18, slide: 0.6 }); },
    wlShield: () => tone(1318, { len: 0.25, vol: 0.06, type: 'triangle', slide: 1.3 }),
    wlChain: () => notes([660, 620, 700], 0.04, { len: 0.06, vol: 0.05, type: 'square' }),
    wlGravity: () => tone(90, { len: 0.8, vol: 0.1, type: 'sine', slide: 0.5 }),
    wlWind: () => knock({ freq: 600, len: 0.4, vol: 0.25, q: 0.3 }),
    wlRush: () => tone(220, { len: 0.3, vol: 0.08, type: 'sawtooth', slide: 1.8 }),
    wlHurt: () => knock({ freq: 400, len: 0.08, vol: 0.35 }),
    wlBurn: () => knock({ freq: 2500, len: 0.15, vol: 0.12, q: 0.3 }),
    wlDeath: () => { tone(330, { len: 0.7, vol: 0.1, type: 'sawtooth', slide: 0.2 }); knock({ freq: 160, len: 0.4, vol: 0.6 }); },
    wlShrink: () => { knock({ freq: 90, len: 0.7, vol: 0.5, q: 0.4 }); tone(45, { len: 0.7, vol: 0.12 }); },
    wlHorn: () => notes([294, 392, 587], 0.12, { len: 0.5, vol: 0.07, type: 'sawtooth' }),
    wlCoin: () => notes([1568, 2093], 0.05, { len: 0.1, vol: 0.05, type: 'square' }),
    roundWin: () => notes([659, 784, 1046], 0.09, { len: 0.22, vol: 0.06, type: 'triangle' }),
    roundLose: () => notes([440, 349, 294], 0.12, { len: 0.25, vol: 0.06, type: 'sine' }),
  };

  function play(name, arg) {
    if (!enabled() || !SOUNDS[name]) return;
    try { SOUNDS[name](arg); } catch { /* no audio device */ }
  }

  return { play, enabled };
})();

// The end-of-game screen, the same for every game: a card with the result,
// confetti when you win, a small shake when you lose.
const EndFx = (() => {
  let current = null;

  function close() {
    if (!current) return;
    const node = current;
    current = null;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }

  function confetti(layer) {
    const canvas = document.createElement('canvas');
    canvas.className = 'endfx-confetti';
    layer.append(canvas);
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width = innerWidth * dpr;
    const H = canvas.height = innerHeight * dpr;
    const g = canvas.getContext('2d');
    const colors = ['#f5cf3a', '#ef4565', '#4f8cff', '#3fbf6a', '#b552e0', '#f5922f'];
    const parts = Array.from({ length: 150 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.2,
      y: H * 0.42,
      vx: (Math.random() - 0.5) * 22 * dpr,
      vy: (-Math.random() * 18 - 8) * dpr,
      s: (Math.random() * 6 + 5) * dpr,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    // About 2.5 seconds, then the canvas is removed (nothing keeps running).
    const step = (now) => {
      const t = now - t0;
      g.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.55 * dpr;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        g.save();
        g.globalAlpha = Math.max(0, 1 - t / 2600);
        g.translate(p.x, p.y);
        g.rotate(p.r);
        g.fillStyle = p.c;
        g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        g.restore();
      }
      if (t < 2600 && canvas.isConnected) requestAnimationFrame(step);
      else canvas.remove();
    };
    requestAnimationFrame(step);
  }

  // outcome: 'win' | 'lose' | 'draw'
  function show({ outcome, title, detail = '', buttons = [] }) {
    close();
    const layer = document.createElement('div');
    layer.className = `endfx ${outcome}`;
    const icon = { win: '🏆', lose: '😔', draw: '🤝' }[outcome] || '🏁';
    layer.innerHTML = `<div class="endfx-card"><div class="endfx-icon">${icon}</div>
      <div class="endfx-title"></div><div class="endfx-detail"></div><div class="endfx-btns"></div></div>`;
    layer.querySelector('.endfx-title').textContent = title;
    layer.querySelector('.endfx-detail').textContent = detail;
    const row = layer.querySelector('.endfx-btns');
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      if (b.primary) btn.className = 'primary';
      btn.onclick = () => { close(); if (b.action) b.action(); };
      row.append(btn);
    }
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
    document.body.append(layer);
    current = layer;
    if (outcome === 'win') confetti(layer);
    Sfx.play(outcome === 'win' ? 'win' : outcome === 'lose' ? 'lose' : 'draw');
  }

  return { show, close, isOpen: () => !!current };
})();
