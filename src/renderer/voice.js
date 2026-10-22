'use strict';
/* global api, $, esc, t, toast, call, replyOpts, fmtDuration, ICONS, S, refreshMsgDom */
// Voice messages: recording with the microphone, and playback in the chat.

const Voice = (() => {
  const MAX_MS = 5 * 60 * 1000;
  let rec = null;
  const audio = new Audio();
  let playing = null; // { id, conv, duration }
  const cache = new Map(); // file path -> data URL

  function showRecorder() {
    const box = $('#recorder');
    box.classList.remove('hidden');
    $('#composer').classList.add('hidden');
    box.innerHTML = `<span class="rec-dot"></span><span class="rec-time">0:00</span>
      <canvas class="rec-level" width="240" height="32"></canvas>
      <span class="rec-label">${esc(t('Recording…'))}</span>
      <button class="btn" data-rec="cancel">${esc(t('Cancel'))}</button>
      <button class="btn primary" data-rec="send">${esc(t('Send'))}</button>`;
    box.onclick = (e) => {
      const b = e.target.closest('[data-rec]');
      if (!b || !rec) return;
      rec.cancelled = b.dataset.rec === 'cancel';
      rec.mr.stop();
    };
  }

  function hideRecorder() {
    $('#recorder').classList.add('hidden');
    $('#composer').classList.remove('hidden');
  }

  async function record(conv) {
    if (rec) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      toast(t('No microphone found, or access to it was blocked'), 'error');
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 });
    const actx = new AudioContext();
    const analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    actx.createMediaStreamSource(stream).connect(analyser);
    rec = { mr, chunks: [], start: Date.now(), stream, conv, cancelled: false, actx, analyser, levels: [] };
    mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    mr.onstop = async () => {
      const r = rec;
      rec = null;
      clearInterval(r.timer);
      r.stream.getTracks().forEach((tr) => tr.stop());
      r.actx.close();
      hideRecorder();
      if (r.cancelled) return;
      const duration = Date.now() - r.start;
      if (duration < 800) return toast(t('Too short – click the microphone, speak, then click Send'));
      const blob = new Blob(r.chunks, { type: 'audio/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await call(api.sendVoice(r.conv, bytes, duration, replyOpts()));
    };
    mr.start(250);
    showRecorder();
    const data = new Uint8Array(analyser.frequencyBinCount);
    rec.timer = setInterval(() => {
      if (!rec) return;
      const ms = Date.now() - rec.start;
      $('#recorder .rec-time').textContent = fmtDuration(ms);
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      rec.levels.push(peak / 128);
      if (rec.levels.length > 60) rec.levels.shift();
      const cv = $('#recorder .rec-level');
      if (cv) {
        const g = cv.getContext('2d');
        g.clearRect(0, 0, cv.width, cv.height);
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
        rec.levels.forEach((lv, i) => {
          const h = Math.max(2, lv * cv.height * 1.6);
          g.fillRect(i * 4, (cv.height - h) / 2, 2.5, Math.min(cv.height, h));
        });
      }
      if (ms >= MAX_MS) rec.mr.stop();
    }, 100);
  }

  function bubbleHtml(m, out) {
    const f = m.file;
    if (!out && f.state !== 'done') {
      if (f.state === 'failed') {
        return `<div class="voice"><div class="ferr">${esc(f.error || t('Download failed'))}</div><button class="fbtn" data-act="download">${esc(t('Retry'))}</button></div>`;
      }
      return `<div class="voice"><span class="vplay disabled">${ICONS.play}</span><div class="vmain"><div class="vbar"><div></div></div><div class="vtime">${esc(t('Loading…'))}</div></div></div>`;
    }
    const isPlaying = playing && playing.id === m.id && !audio.paused;
    const pct = playing && playing.id === m.id ? Math.min(100, (audio.currentTime * 1000 / Math.max(1, f.duration)) * 100) : 0;
    const time = playing && playing.id === m.id ? fmtDuration(audio.currentTime * 1000) : fmtDuration(f.duration);
    return `<div class="voice"><button class="vplay" data-act="play" title="${esc(isPlaying ? t('Pause') : t('Play'))}">${isPlaying ? ICONS.pause : ICONS.play}</button>
      <div class="vmain"><div class="vbar" data-act="seek"><div style="width:${pct}%"></div></div><div class="vtime">🎤 ${time}</div></div></div>`;
  }

  async function toggle(m) {
    if (playing && playing.id === m.id) {
      if (audio.paused) audio.play(); else audio.pause();
      return;
    }
    const prev = playing;
    let src = cache.get(m.file.path);
    if (!src) {
      src = await api.readMedia(m.file.path);
      if (!src) return toast(t('File not found. It may have been moved or deleted.'), 'error');
      cache.set(m.file.path, src);
    }
    playing = { id: m.id, conv: S.active, duration: m.file.duration };
    if (prev) refreshMsgDom(prev.conv, prev.id);
    audio.src = src;
    audio.play();
  }

  function seek(m, e, bar) {
    if (!playing || playing.id !== m.id) return;
    const r = bar.getBoundingClientRect();
    audio.currentTime = ((e.clientX - r.left) / r.width) * (playing.duration / 1000);
  }

  const refresh = () => { if (playing) refreshMsgDom(playing.conv, playing.id); };
  audio.addEventListener('play', refresh);
  audio.addEventListener('pause', refresh);
  audio.addEventListener('timeupdate', refresh);
  audio.addEventListener('ended', () => {
    const p = playing;
    playing = null;
    if (p) refreshMsgDom(p.conv, p.id);
  });

  return { record, bubbleHtml, toggle, seek };
})();
