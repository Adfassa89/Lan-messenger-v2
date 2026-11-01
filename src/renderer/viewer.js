'use strict';
/* global api, I18N */
// Shows another PC's shared screen.

const params = new URLSearchParams(location.search);
const peerId = params.get('peer');
const sid = params.get('sid');
const name = params.get('name') || '';
const lang = params.get('lang') || 'en';
const t = (k, v) => I18N.translate(lang, k, v);

const video = document.getElementById('video');
const status = document.getElementById('status');
let pc = null;
const pendingIce = [];

document.title = t("{name}'s screen", { name });
document.getElementById('title').textContent = t("{name}'s screen", { name });
const btnFit = document.getElementById('btnFit');
const btnFull = document.getElementById('btnFull');
btnFit.textContent = t('Actual size');
btnFull.textContent = t('Full screen');
status.textContent = t('Connecting…');

btnFit.onclick = () => {
  const actual = document.body.classList.toggle('actual');
  btnFit.textContent = actual ? t('Fit to window') : t('Actual size');
};
btnFull.onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
};
video.addEventListener('dblclick', () => { if (!document.body.classList.contains('controlling')) btnFull.onclick(); });

// ------------------------------------------------------------------ remote help
// Ask to control the other PC; once allowed, this window's mouse and keyboard
// work on their shared screen.
const btnCtl = document.getElementById('btnCtl');
const note = document.getElementById('note');
let ctl = 'off'; // off | asking | on
const held = new Set();
let queue = [];
let flushTimer = null;
function showNote(text, ms = 4000) {
  note.textContent = text;
  note.classList.toggle('hidden', !text);
  clearTimeout(showNote.timer);
  if (text && ms) showNote.timer = setTimeout(() => note.classList.add('hidden'), ms);
}
function setCtl(state) {
  ctl = state;
  document.body.classList.toggle('controlling', state === 'on');
  btnCtl.textContent = state === 'on' ? t('Stop control') : state === 'asking' ? t('Asking…') : t('Request control');
  btnCtl.disabled = state === 'asking';
  if (state !== 'on') releaseAll();
}
setCtl('off');
btnCtl.onclick = () => {
  if (ctl === 'on') {
    api.rtcSend(peerId, sid, { kind: 'ctl-end' });
    setCtl('off');
    showNote(t('You stopped controlling {name}\'s PC', { name }));
  } else if (ctl === 'off') {
    if (!video.srcObject) return;
    api.rtcSend(peerId, sid, { kind: 'ctl-req' });
    setCtl('asking');
    showNote(t('Waiting for {name} to allow control…', { name }), 0);
  }
};
function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!queue.length) return;
  api.rtcSend(peerId, sid, { kind: 'in', ev: queue });
  queue = [];
}
function push(ev, now) {
  if (ctl !== 'on') return;
  const last = queue[queue.length - 1];
  if (ev.t === 'm' && last && last.t === 'm') queue[queue.length - 1] = ev; // only the latest position matters
  else queue.push(ev);
  if (now) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, 30);
}
// Mouse position on the picture, 0 – 1 across the shared screen (letterboxing removed).
function pos(e) {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth || r.width;
  const vh = video.videoHeight || r.height;
  const k = document.body.classList.contains('actual') ? 1 : Math.min(r.width / vw, r.height / vh);
  const w = vw * k;
  const h = vh * k;
  const x = (e.clientX - r.left - (r.width - w) / 2) / w;
  const y = (e.clientY - r.top - (r.height - h) / 2) / h;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}
video.addEventListener('mousemove', (e) => { const p = pos(e); if (p.inside) push({ t: 'm', x: p.x, y: p.y }); });
video.addEventListener('mousedown', (e) => {
  if (ctl !== 'on') return;
  e.preventDefault();
  const p = pos(e);
  if (!p.inside) return;
  held.add(`b${e.button}`);
  push({ t: 'd', b: e.button, x: p.x, y: p.y }, true);
});
window.addEventListener('mouseup', (e) => {
  if (ctl !== 'on' || !held.has(`b${e.button}`)) return;
  held.delete(`b${e.button}`);
  const p = pos(e);
  push({ t: 'u', b: e.button, x: p.x, y: p.y }, true);
});
video.addEventListener('wheel', (e) => { if (ctl === 'on') { e.preventDefault(); push({ t: 'w', dy: e.deltaY }, true); } }, { passive: false });
video.addEventListener('contextmenu', (e) => { if (ctl === 'on') e.preventDefault(); });
window.addEventListener('keydown', (e) => {
  if (ctl !== 'on') return;
  e.preventDefault();
  held.add(`k${e.code}`);
  push({ t: 'k', c: e.code, d: 1 }, true);
}, true);
window.addEventListener('keyup', (e) => {
  if (ctl !== 'on') return;
  e.preventDefault();
  held.delete(`k${e.code}`);
  push({ t: 'k', c: e.code, d: 0 }, true);
}, true);
// Leaving the window lets go of everything that was held down.
function releaseAll() {
  if (!held.size) return;
  const ev = [...held].map((h) => (h[0] === 'b' ? { t: 'u', b: Number(h.slice(1)) } : { t: 'k', c: h.slice(1), d: 0 }));
  held.clear();
  api.rtcSend(peerId, sid, { kind: 'in', ev });
}
window.addEventListener('blur', () => { if (ctl === 'on') releaseAll(); });

function ended() {
  setCtl('off');
  status.textContent = t('Screen sharing has ended');
  video.srcObject = null;
  if (pc) pc.close();
  pc = null;
}

api.on(async ({ type, payload }) => {
  if (type !== 'rtc' || payload.sid !== sid || payload.peerId !== peerId) return;
  const { data } = payload;
  try {
    if (data.kind === 'offer') {
      if (pc) pc.close();
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.onicecandidate = (e) => {
        if (e.candidate) api.rtcSend(peerId, sid, { kind: 'ice', candidate: e.candidate.toJSON() });
      };
      pc.ontrack = (e) => {
        video.srcObject = e.streams[0] || new MediaStream([e.track]);
        status.textContent = '';
      };
      pc.onconnectionstatechange = () => {
        if (pc && pc.connectionState === 'failed') status.textContent = t('Connection lost');
      };
      await pc.setRemoteDescription(data.sdp);
      for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      api.rtcSend(peerId, sid, { kind: 'answer', sdp: pc.localDescription.toJSON() });
    } else if (data.kind === 'ice') {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else pendingIce.push(data.candidate);
    } else if (data.kind === 'end') {
      ended();
    } else if (data.kind === 'ctl-ok') {
      setCtl('on');
      showNote(t('You are controlling {name}\'s PC. Your mouse and keyboard work on their screen.', { name }));
    } else if (data.kind === 'ctl-no') {
      setCtl('off');
      showNote({
        window: t('{name} is sharing a single window. Control works only when the entire screen is shared.', { name }),
        unsupported: t('Remote control is not available on {name}\'s PC.', { name }),
        busy: t('Someone else is controlling {name}\'s PC.', { name }),
      }[data.reason] || t('{name} did not allow control.', { name }));
    } else if (data.kind === 'ctl-end') {
      setCtl('off');
      showNote(t('{name} took back control', { name }));
    }
  } catch (err) {
    status.textContent = `${t('Connection lost')}: ${err.message}`;
  }
});

api.rtcSend(peerId, sid, { kind: 'accept' });
