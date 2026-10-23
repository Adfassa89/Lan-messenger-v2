'use strict';
/* global api, I18N */
// Incoming call pop-up with a ringtone.

const sid = new URLSearchParams(location.search).get('sid');
let ctx = null;
let ringTimer = null;

function ringtone() {
  try {
    ctx = ctx || new AudioContext();
    const now = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      for (const f of [523, 659]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const start = now + i * 0.45;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.12, start + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.38);
        o.connect(g).connect(ctx.destination);
        o.start(start);
        o.stop(start + 0.4);
      }
    }
  } catch { /* no audio device */ }
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

async function init() {
  const info = await api.callInfo(sid);
  if (!info) return window.close();
  const t = (k, v) => I18N.translate(info.language, k, v);
  const caller = info.people[info.from] || { name: t('Someone') };
  document.title = t('Incoming call');
  document.getElementById('kind').textContent = info.video ? t('Incoming video call') : t('Incoming voice call');
  document.getElementById('name').textContent = caller.name;
  document.getElementById('group').textContent = info.isGroup ? info.convTitle : '';
  const av = document.getElementById('avatar');
  if (caller.avatar) {
    const img = new Image();
    img.src = caller.avatar;
    av.append(img);
  } else {
    av.textContent = initials(caller.name);
  }
  const btns = { btnDecline: t('Decline'), btnVoice: t('Voice'), btnVideo: t('Video') };
  for (const [id, label] of Object.entries(btns)) document.querySelector(`#${id} span`).textContent = label;
  const stop = () => clearInterval(ringTimer);
  document.getElementById('btnDecline').onclick = () => { stop(); api.callDecline(sid); };
  document.getElementById('btnVoice').onclick = () => { stop(); api.callAccept(sid, false); };
  document.getElementById('btnVideo').onclick = () => { stop(); api.callAccept(sid, true); };
  if (info.sound) {
    ringtone();
    ringTimer = setInterval(ringtone, 2200);
  }
}

init();
