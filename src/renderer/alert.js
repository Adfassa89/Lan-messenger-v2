'use strict';
/* global api, I18N */
// Full-attention alert window with an alarm sound that keeps going until
// the person clicks Acknowledge.

const params = new URLSearchParams(location.search);
const conv = params.get('conv');
const id = params.get('id');
let ctx = null;
let alarm = null;

function beep() {
  try {
    ctx = ctx || new AudioContext();
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(i % 2 ? 660 : 990, now + i * 0.22);
      g.gain.setValueAtTime(0.0001, now + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.22 + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(now + i * 0.22);
      o.stop(now + i * 0.22 + 0.21);
    }
  } catch { /* no audio device */ }
}

async function init() {
  const info = await api.getMessage(conv, id);
  if (!info) return window.close();
  const { msg, convTitle, language } = info;
  const t = (k, v) => I18N.translate(language, k, v);
  document.title = t('Urgent alert');
  document.getElementById('label').textContent = t('URGENT ALERT');
  const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const where = conv === msg.from ? '' : ` · ${convTitle}`;
  document.getElementById('from').textContent = `${t('From {name}', { name: msg.fromName })}${where} · ${time}`;
  document.getElementById('text').textContent = msg.text;
  const ack = document.getElementById('btnAck');
  const open = document.getElementById('btnOpen');
  ack.textContent = t('Acknowledge');
  open.textContent = t('Acknowledge & open chat');
  const done = async (openChat) => {
    clearInterval(alarm);
    if (openChat) await api.openConv(conv);
    await api.ackUrgent(conv, id);
  };
  ack.onclick = () => done(false);
  open.onclick = () => done(true);
  ack.focus();
  if (msg.acked) return;
  beep();
  let n = 0;
  // Loud for the first minute, then a reminder every 10 seconds.
  alarm = setInterval(() => {
    n++;
    if (n < 40 || n % 7 === 0) beep();
  }, 1500);
}

init();
