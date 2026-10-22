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
video.addEventListener('dblclick', () => btnFull.onclick());

function ended() {
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
    }
  } catch (err) {
    status.textContent = `${t('Connection lost')}: ${err.message}`;
  }
});

api.rtcSend(peerId, sid, { kind: 'accept' });
