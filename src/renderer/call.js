'use strict';
/* global api, I18N */
// Voice and video calls. Every participant connects directly to every other
// participant over the LAN (WebRTC); the call setup messages travel over the
// app's encrypted chat connections.

const params = new URLSearchParams(location.search);
const sid = params.get('sid');
const role = params.get('role'); // 'caller' or 'callee'
let t = (k, v) => I18N.translate(params.get('lang') || 'en', k, v);

const ICON = {
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.7 2.5M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/></svg>',
  cam: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  camOff: '<svg viewBox="0 0 24 24"><path d="M16 16v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1M10 5h4a2 2 0 0 1 2 2v3.3l5-3.3v10M3 3l18 18"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  hang: '<svg viewBox="0 0 24 24"><path d="M3 15.5c5-4.7 13-4.7 18 0l-2.4 2.4-3.2-1.8.2-2.4a10 10 0 0 0-7.2 0l.2 2.4-3.2 1.8z"/></svg>',
};
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } };
const RING_FOR = 50000;

let info = null;
let local = new MediaStream();
let micTrack = null;
let camTrack = null;
let micOn = true;
let camOn = false;
let connectedAt = 0;
let ended = false;
let clockTimer = null;
let ringback = null;
let audioCtx = null;
const peers = new Map(); // peerId -> { pc, tile, ice: [], stream, connected, state }
const invited = new Set(); // people still ringing

const $ = (id) => document.getElementById(id);

function send(peerId, data) {
  api.rtcSend(peerId, sid, data);
}

function nameOf(id) {
  return (info.people[id] && info.people[id].name) || t('Someone');
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase();
}

function color(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const p = [['#4f63f5', '#7c5cf6'], ['#0ea5e9', '#2563eb'], ['#10b981', '#059669'], ['#f59e0b', '#ea580c'], ['#ef4444', '#db2777'], ['#8b5cf6', '#6d28d9']];
  const [a, b] = p[h % p.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function setStatus(text) {
  $('status').textContent = text;
}

// ------------------------------------------------------------------ tiles
function layout() {
  const n = $('stage').children.length;
  $('stage').style.setProperty('--cols', n <= 1 ? 1 : n <= 4 ? 2 : 3);
}

function tileFor(id) {
  const existing = $('stage').querySelector(`[data-peer="${CSS.escape(id)}"]`);
  if (existing) return existing;
  const p = info.people[id] || {};
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.peer = id;
  const avatar = p.avatar ? `<img src="${p.avatar}" alt="">` : initials(p.name);
  tile.innerHTML = `<video autoplay playsinline></video>
    <div class="avatar-wrap"><div class="avatar" style="background:${color(id)}">${avatar}</div></div>
    <div class="tile-state"></div>
    <div class="tile-label"><span></span></div>`;
  tile.querySelector('.tile-label span').textContent = nameOf(id);
  $('stage').append(tile);
  layout();
  return tile;
}

function setTileState(id, text, ringing = false) {
  const tile = tileFor(id);
  tile.querySelector('.tile-state').textContent = text || '';
  tile.classList.toggle('ringing', ringing);
}

function removeTile(id, delay = 0) {
  setTimeout(() => {
    const tile = $('stage').querySelector(`[data-peer="${CSS.escape(id)}"]`);
    if (tile && !peers.has(id)) {
      tile.remove();
      layout();
    }
  }, delay);
}

function updateTileVideo(id) {
  const entry = peers.get(id);
  if (!entry) return;
  const v = entry.stream && entry.stream.getVideoTracks()[0];
  const showing = !!v && v.readyState === 'live' && !v.muted && entry.state.cam !== false;
  entry.tile.classList.toggle('has-video', showing);
}

function updateTileMic(id) {
  const entry = peers.get(id);
  if (!entry) return;
  const label = entry.tile.querySelector('.tile-label');
  const off = entry.state.mic === false;
  const icon = label.querySelector('svg');
  if (off && !icon) label.insertAdjacentHTML('beforeend', ICON.micOff);
  if (!off && icon) icon.remove();
}

// ------------------------------------------------------------------ audio level ("who is speaking")
function watchLevel(entry) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const track = entry.stream.getAudioTracks()[0];
    if (!track || entry.analyser) return;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    entry.analyser = analyser;
    entry.levelData = new Uint8Array(analyser.fftSize);
  } catch { /* audio analysis is optional */ }
}

function levelLoop() {
  for (const entry of peers.values()) {
    if (!entry.analyser) continue;
    entry.analyser.getByteTimeDomainData(entry.levelData);
    let peak = 0;
    for (const v of entry.levelData) peak = Math.max(peak, Math.abs(v - 128));
    entry.tile.classList.toggle('speaking', peak > 14 && entry.state.mic !== false);
  }
  if (!ended) requestAnimationFrame(levelLoop);
}

// ------------------------------------------------------------------ connections
function myState() {
  return { kind: 'call-state', mic: micOn && !!micTrack, cam: camOn && !!camTrack };
}

function broadcastState() {
  for (const id of peers.keys()) send(id, myState());
}

function newPeer(id) {
  const old = peers.get(id);
  if (old) old.pc.close();
  const pc = new RTCPeerConnection({ iceServers: [] });
  const entry = { pc, tile: tileFor(id), ice: [], stream: new MediaStream(), connected: false, state: {} };
  peers.set(id, entry);
  setTileState(id, t('Connecting…'));
  entry.tile.querySelector('video').srcObject = entry.stream;
  pc.onicecandidate = (e) => {
    if (e.candidate) send(id, { kind: 'call-ice', candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    entry.stream.addTrack(e.track);
    e.track.onmute = () => updateTileVideo(id);
    e.track.onunmute = () => updateTileVideo(id);
    e.track.onended = () => updateTileVideo(id);
    if (e.track.kind === 'audio') watchLevel(entry);
    updateTileVideo(id);
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      entry.connected = true;
      clearTimeout(entry.dropTimer);
      setTileState(id, '');
      onConnected(id);
    } else if (s === 'disconnected') {
      setTileState(id, t('Reconnecting…'));
      entry.dropTimer = setTimeout(() => dropPeer(id, t('Connection lost')), 10000);
    } else if (s === 'failed') {
      dropPeer(id, t('Connection lost'));
    }
  };
  return entry;
}

async function attachLocal(pc) {
  for (const tr of pc.getTransceivers()) {
    const kind = tr.receiver.track.kind;
    tr.direction = 'sendrecv';
    await tr.sender.replaceTrack(kind === 'audio' ? micTrack : (camOn ? camTrack : null));
    if (kind === 'video') {
      const p = tr.sender.getParameters();
      p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = 2_500_000;
      tr.sender.setParameters(p).catch(() => {});
    }
  }
}

async function offerTo(id) {
  const entry = newPeer(id);
  const { pc } = entry;
  // Always negotiate audio and video, so the camera can be switched on
  // later without renegotiating.
  pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.addTransceiver('video', { direction: 'sendrecv' });
  await attachLocal(pc);
  await pc.setLocalDescription(await pc.createOffer());
  send(id, { kind: 'call-offer', sdp: pc.localDescription.toJSON() });
  send(id, myState());
}

async function onOffer(id, sdp) {
  const entry = newPeer(id);
  const { pc } = entry;
  await pc.setRemoteDescription(sdp);
  await attachLocal(pc);
  await pc.setLocalDescription(await pc.createAnswer());
  send(id, { kind: 'call-answer', sdp: pc.localDescription.toJSON() });
  send(id, myState());
  await flushIce(entry);
}

async function flushIce(entry) {
  for (const c of entry.ice.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
}

function onJoin(id) {
  invited.delete(id);
  if (peers.has(id) && peers.get(id).connected) return;
  // The participant with the smaller id makes the offer, so two people
  // never offer to each other at the same time.
  if (info.me.id < id) offerTo(id).catch((e) => console.warn(e));
  // Otherwise answer with our own join; they have the smaller id and will
  // offer. This cannot loop, because exactly one side always offers.
  else send(id, { kind: 'call-join' });
}

function onConnected() {
  stopRingback();
  if (!connectedAt) {
    connectedAt = Date.now();
    api.callConnected(sid);
    clockTimer = setInterval(updateClock, 1000);
  }
  updateClock();
}

function updateClock() {
  if (!connectedAt) return;
  const s = Math.floor((Date.now() - connectedAt) / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(hh ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  setStatus(hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`);
}

function dropPeer(id, reason) {
  const entry = peers.get(id);
  if (!entry) return;
  clearTimeout(entry.dropTimer);
  entry.pc.close();
  peers.delete(id);
  setTileState(id, reason);
  removeTile(id, 2500);
  checkEnd();
}

function anyoneLeft() {
  return peers.size > 0 || invited.size > 0;
}

function checkEnd() {
  if (ended || anyoneLeft()) return;
  setStatus(connectedAt ? t('Call ended') : t('No answer'));
  setTimeout(() => hangup(), 1500);
}

async function handle({ type, payload }) {
  if (type !== 'rtc' || payload.sid !== sid || ended) return;
  const { peerId: id, data } = payload;
  try {
    switch (data.kind) {
      case 'call-join': onJoin(id); break;
      case 'call-offer': invited.delete(id); await onOffer(id, data.sdp); break;
      case 'call-answer': {
        const entry = peers.get(id);
        if (entry) {
          await entry.pc.setRemoteDescription(data.sdp);
          await flushIce(entry);
        }
        break;
      }
      case 'call-ice': {
        const entry = peers.get(id);
        if (!entry) break;
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
        else entry.ice.push(data.candidate);
        break;
      }
      case 'call-state': {
        const entry = peers.get(id);
        if (!entry) break;
        entry.state = { mic: data.mic !== false, cam: data.cam !== false };
        updateTileMic(id);
        updateTileVideo(id);
        break;
      }
      case 'call-leave':
      case 'call-cancel':
        invited.delete(id);
        if (peers.has(id)) dropPeer(id, t('Left the call'));
        else { setTileState(id, t('Left the call')); removeTile(id, 2000); checkEnd(); }
        break;
      case 'call-decline': {
        invited.delete(id);
        const reason = { busy: t('Busy in another call'), timeout: t('No answer') }[data.reason] || t('Declined');
        setTileState(id, reason);
        removeTile(id, 2500);
        checkEnd();
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.warn('Call:', err);
  }
}

// ------------------------------------------------------------------ local media
async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: video ? VIDEO : false });
  } catch {
    if (video) {
      toast(t('Camera not available – joining with voice only'));
      return getMedia(false);
    }
    toast(t('No microphone found – others will not hear you'));
    return new MediaStream();
  }
}

function showSelf() {
  $('selfVideo').srcObject = camOn && camTrack ? new MediaStream([camTrack]) : null;
  $('selfOff').classList.toggle('hidden', !!(camOn && camTrack));
  $('selfOff').textContent = t('Camera off');
}

function renderControls() {
  const mic = $('btnMic');
  mic.innerHTML = micOn && micTrack ? ICON.mic : ICON.micOff;
  mic.classList.toggle('off', !(micOn && micTrack));
  mic.title = micOn ? t('Mute microphone') : t('Unmute microphone');
  const cam = $('btnCam');
  cam.innerHTML = camOn ? ICON.cam : ICON.camOff;
  cam.classList.toggle('off', !camOn);
  cam.title = camOn ? t('Turn camera off') : t('Turn camera on');
  $('btnDevices').innerHTML = ICON.gear;
  $('btnDevices').title = t('Microphone, camera and speaker');
  $('btnHang').innerHTML = ICON.hang;
  $('btnHang').title = t('Hang up');
}

async function replaceForAll(kind, track) {
  for (const { pc } of peers.values()) {
    for (const tr of pc.getTransceivers()) {
      if (tr.receiver.track.kind === kind) await tr.sender.replaceTrack(track).catch(() => {});
    }
  }
}

function toggleMic() {
  if (!micTrack) return toast(t('No microphone found – others will not hear you'));
  micOn = !micOn;
  micTrack.enabled = micOn;
  renderControls();
  broadcastState();
}

async function setCamera(on, deviceId) {
  if (on) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { ...VIDEO, deviceId: { exact: deviceId } } : VIDEO });
      if (camTrack) camTrack.stop();
      camTrack = s.getVideoTracks()[0];
      camOn = true;
    } catch {
      toast(t('Camera not available'));
      return;
    }
  } else {
    camOn = false;
    if (camTrack) camTrack.stop();
    camTrack = null;
  }
  await replaceForAll('video', camOn ? camTrack : null);
  showSelf();
  renderControls();
  broadcastState();
}

async function setMicrophone(deviceId) {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO, deviceId: { exact: deviceId } } });
    if (micTrack) micTrack.stop();
    micTrack = s.getAudioTracks()[0];
    micTrack.enabled = micOn;
    await replaceForAll('audio', micTrack);
    renderControls();
  } catch {
    toast(t('This microphone could not be used'));
  }
}

let speakerId = '';
async function devicesMenu() {
  const menu = $('menu');
  if (!menu.classList.contains('hidden')) return menu.classList.add('hidden');
  const devices = await navigator.mediaDevices.enumerateDevices();
  const section = (title, kind, current) => {
    const list = devices.filter((d) => d.kind === kind);
    if (!list.length) return '';
    return `<h4>${title}</h4>${list.map((d, i) => `<button data-kind="${kind}" data-id="${d.deviceId}" class="${d.deviceId === current ? 'on' : ''}">${(d.label || `${title} ${i + 1}`).replace(/[<>&]/g, '')}</button>`).join('')}`;
  };
  const micId = micTrack && micTrack.getSettings().deviceId;
  const camId = camTrack && camTrack.getSettings().deviceId;
  menu.innerHTML = section(t('Microphone'), 'audioinput', micId)
    + section(t('Camera'), 'videoinput', camId)
    + section(t('Speaker'), 'audiooutput', speakerId || 'default');
  menu.classList.remove('hidden');
}

$('menu').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('menu').classList.add('hidden');
  const id = b.dataset.id;
  if (b.dataset.kind === 'audioinput') await setMicrophone(id);
  else if (b.dataset.kind === 'videoinput') await setCamera(true, id);
  else if (b.dataset.kind === 'audiooutput') {
    speakerId = id;
    for (const v of document.querySelectorAll('.tile video')) v.setSinkId(id).catch(() => {});
  }
});

// ------------------------------------------------------------------ ringback tone for the caller
function startRingback() {
  if (!info.sound) return;
  const beep = () => {
    try {
      audioCtx = audioCtx || new AudioContext();
      const now = audioCtx.currentTime;
      for (const f of [440, 480]) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.05, now + 0.05);
        g.gain.setValueAtTime(0.05, now + 1.2);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
        o.connect(g).connect(audioCtx.destination);
        o.start(now);
        o.stop(now + 1.35);
      }
    } catch { /* no audio */ }
  };
  beep();
  ringback = setInterval(beep, 4000);
}

function stopRingback() {
  clearInterval(ringback);
  ringback = null;
}

// ------------------------------------------------------------------ hang up
function hangup() {
  if (ended) return;
  ended = true;
  stopRingback();
  clearInterval(clockTimer);
  const someoneConnected = [...peers.values()].some((p) => p.connected);
  for (const id of info.members) {
    if (peers.has(id)) send(id, { kind: 'call-leave' });
    else if (invited.has(id) && role === 'caller' && !someoneConnected) send(id, { kind: 'call-cancel' });
    else send(id, { kind: 'call-leave' });
  }
  for (const { pc } of peers.values()) pc.close();
  for (const tr of local.getTracks()) tr.stop();
  if (camTrack) camTrack.stop();
  if (micTrack) micTrack.stop();
  api.callEnded(sid, { duration: connectedAt ? Date.now() - connectedAt : 0 });
}

// ------------------------------------------------------------------ start
async function init() {
  info = await api.callInfo(sid);
  if (!info) return window.close();
  t = (k, v) => I18N.translate(info.language, k, v);
  document.title = t('Call with {name}', { name: info.convTitle });
  $('title').textContent = info.convTitle;
  setStatus(role === 'caller' ? t('Calling…') : t('Connecting…'));
  local = await getMedia(info.video);
  micTrack = local.getAudioTracks()[0] || null;
  camTrack = local.getVideoTracks()[0] || null;
  camOn = !!camTrack;
  showSelf();
  renderControls();
  $('btnMic').onclick = toggleMic;
  $('btnCam').onclick = () => setCamera(!camOn);
  $('btnDevices').onclick = devicesMenu;
  $('btnHang').onclick = hangup;
  window.addEventListener('beforeunload', hangup);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'm') toggleMic();
  });
  api.on(handle);
  requestAnimationFrame(levelLoop);

  if (role === 'caller') {
    // Only the caller hears about declines, so only the caller tracks who is still ringing.
    for (const id of info.members) invited.add(id);
    for (const id of info.members) setTileState(id, t('Ringing…'), true);
    startRingback();
    setTimeout(() => {
      if (connectedAt || ended) return;
      for (const id of [...invited]) {
        send(id, { kind: 'call-cancel' });
        invited.delete(id);
        setTileState(id, t('No answer'));
      }
      checkEnd();
    }, RING_FOR);
  } else {
    // Tell everyone in the call we are here; they connect to us.
    for (const id of info.members) send(id, { kind: 'call-join' });
    setTimeout(() => {
      if (connectedAt || ended) return;
      setStatus(t('Could not connect'));
      setTimeout(hangup, 1500);
    }, 20000);
  }
}

init();
