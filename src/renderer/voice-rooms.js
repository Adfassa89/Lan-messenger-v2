'use strict';
/* global api, S, t, esc, avatarHtml, peerName, call, toast, modal, MicBoost, $ */
// Voice rooms in group chats, like Discord's voice channels. A group has one
// or more rooms; anyone can walk in or out at any time and nobody is rung.
// People in the same room hear each other (each PC connects directly to the
// others in that room over the LAN); people in other rooms do not.
// Mute switches your microphone off; deafen also silences everyone else.
//
// No server: every PC in a room tells the group's online members which room
// it is in (and whether it is muted or deafened) every few seconds. The list
// of rooms is shared the same way.

const VoiceRooms = (() => {
  const SID = 'vr';
  const STATE_EVERY = 4000;
  const STATE_TTL = 15000;
  const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const ROOMS_KEY = 'lanmsg.voiceRooms.v1';
  const PREFS_KEY = 'lanmsg.voicePrefs.v1';

  // Where I am: { group, room } or null.
  let here = null;
  let muted = false;
  let deaf = false;
  let mutedBeforeDeaf = false;
  let stream = null; // raw microphone
  let boost = null;
  let sendTrack = null;
  let ctx = null;
  let localLevel = null;
  let joining = false;
  const others = new Map(); // peerId -> { group, room, muted, deaf, at }
  const links = new Map(); // peerId -> { pc, audio, level, speaking }
  let rooms = {}; // groupId -> { roomId: { name, at, del } }
  let timer = null;
  let levelTimer = null;
  let speakingMe = false;

  try { rooms = JSON.parse(localStorage.getItem(ROOMS_KEY) || '{}') || {}; } catch { rooms = {}; }
  try { ({ muted = false, deaf = false } = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* defaults */ }
  const saveRooms = () => { try { localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms)); } catch { /* ignore */ } };
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ muted, deaf })); } catch { /* ignore */ } };

  // ------------------------------------------------------------------ rooms
  const DEFAULT_ROOM = 'general';
  function roomList(group) {
    const r = rooms[group] || {};
    const list = Object.entries(r).filter(([, v]) => !v.del).map(([id, v]) => ({ id, name: v.name, at: v.at }));
    if (!list.some((x) => x.id === DEFAULT_ROOM)) list.unshift({ id: DEFAULT_ROOM, name: '', at: 0 });
    return list.sort((a, b) => (a.id === DEFAULT_ROOM ? -1 : b.id === DEFAULT_ROOM ? 1 : a.at - b.at));
  }
  const roomName = (group, id) => {
    if (id === DEFAULT_ROOM) return (rooms[group] && rooms[group][id] && rooms[group][id].name) || t('General');
    return (rooms[group] && rooms[group][id] && rooms[group][id].name) || t('Voice room');
  };
  // Last change wins, room by room; deleted rooms are remembered so they stay deleted.
  function mergeRooms(group, list) {
    if (!list || typeof list !== 'object') return false;
    const mine = rooms[group] || (rooms[group] = {});
    let changed = false;
    for (const [id, v] of Object.entries(list)) {
      if (!/^[a-z0-9-]{1,40}$/.test(id) || !v || typeof v !== 'object') continue;
      const at = Number(v.at) || 0;
      if (mine[id] && mine[id].at >= at) continue;
      mine[id] = { name: String(v.name || '').slice(0, 40), at, del: !!v.del };
      changed = true;
    }
    if (changed) saveRooms();
    return changed;
  }
  function members(group) {
    const g = S.groups.get(group);
    return g ? g.members.filter((m) => m !== S.me.id) : [];
  }
  function toGroup(group, data) {
    for (const id of members(group)) if (S.peers.get(id)?.online) api.rtcSend(id, SID, { g: group, ...data });
  }
  function shareRooms(group) { toGroup(group, { kind: 'vr-rooms', rooms: rooms[group] || {} }); }

  function addRoom(group) {
    modal({
      title: t('New voice room'),
      body: `<div class="field"><label>${esc(t('Room name'))}</label><input class="input" id="vrName" maxlength="40" placeholder="${esc(t('e.g. Planning'))}"></div>`,
      buttons: [
        { label: t('Cancel') },
        {
          label: t('Create'), cls: 'primary', action: (m) => {
            const name = $('#vrName', m).value.trim();
            if (!name) { toast(t('Please give the room a name'), 'error'); return false; }
            const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            mergeRooms(group, { [id]: { name, at: Date.now() } });
            shareRooms(group);
            render();
            return true;
          },
        },
      ],
    });
  }
  function renameRoom(group, id) {
    modal({
      title: t('Rename room'),
      body: `<div class="field"><label>${esc(t('Room name'))}</label><input class="input" id="vrName" maxlength="40" value="${esc(roomName(group, id))}"></div>`,
      buttons: [
        { label: t('Cancel') },
        {
          label: t('Save'), cls: 'primary', action: (m) => {
            const name = $('#vrName', m).value.trim();
            if (!name) return false;
            mergeRooms(group, { [id]: { name, at: Date.now() } });
            shareRooms(group);
            render();
            return true;
          },
        },
      ],
    });
  }
  function deleteRoom(group, id) {
    if (id === DEFAULT_ROOM) return;
    if (peopleIn(group, id).length) { toast(t('Only an empty room can be deleted'), 'error'); return; }
    mergeRooms(group, { [id]: { name: roomName(group, id), at: Date.now(), del: true } });
    shareRooms(group);
    render();
  }

  // Who is in a room right now (me included).
  function peopleIn(group, room) {
    const now = Date.now();
    const list = [];
    if (here && here.group === group && here.room === room) list.push({ id: S.me.id, muted, deaf, me: true });
    for (const [id, st] of others) {
      if (st.group === group && st.room === room && now - st.at < STATE_TTL && members(group).includes(id)) list.push({ id, muted: st.muted, deaf: st.deaf });
    }
    return list;
  }
  function busyCount(group) {
    return roomList(group).reduce((n, r) => n + peopleIn(group, r.id).length, 0);
  }

  // ------------------------------------------------------------------ joining
  async function join(group, room) {
    if (joining) return;
    if (here && here.group === group && here.room === room) return;
    joining = true;
    try {
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
        } catch {
          toast(t('Could not use the microphone'), 'error');
          return;
        }
        boost = MicBoost.create(stream.getAudioTracks()[0], S.settings.micBoost || 100);
        sendTrack = boost.track;
        localLevel = levelOf(new MediaStream([sendTrack]));
      }
      const before = here;
      if (before) toGroup(before.group, { kind: 'vr-state', room: null });
      here = { group, room };
      closeAll();
      applyMute();
      api.voiceActive(true).catch(() => {});
      sendState();
      toGroup(group, { kind: 'vr-hello' });
      sync();
      chime('join');
      if (!timer) timer = setInterval(tick, STATE_EVERY);
      if (!levelTimer) levelTimer = setInterval(levels, 120);
      render();
    } finally {
      joining = false;
    }
  }

  function leave() {
    if (!here) return;
    toGroup(here.group, { kind: 'vr-state', room: null });
    here = null;
    closeAll();
    clearInterval(timer);
    clearInterval(levelTimer);
    timer = null;
    levelTimer = null;
    if (boost) boost.stop();
    if (stream) for (const tr of stream.getTracks()) tr.stop();
    stream = null;
    boost = null;
    sendTrack = null;
    localLevel = null;
    speakingMe = false;
    api.voiceActive(false).catch(() => {});
    chime('leave');
    render();
  }

  function sendState() {
    if (!here) return;
    toGroup(here.group, { kind: 'vr-state', room: here.room, muted, deaf });
  }

  function tick() {
    sendState();
    sync();
    render();
  }

  function applyMute() {
    if (sendTrack) sendTrack.enabled = !muted && !deaf;
    for (const l of links.values()) if (l.audio) l.audio.muted = deaf;
  }
  function toggleMute() {
    if (deaf) { deaf = false; muted = false; } else muted = !muted;
    applyMute();
    savePrefs();
    sendState();
    chime(muted ? 'mute' : 'unmute');
    render();
  }
  function toggleDeaf() {
    if (!deaf) { mutedBeforeDeaf = muted; deaf = true; muted = true; } else { deaf = false; muted = mutedBeforeDeaf; }
    applyMute();
    savePrefs();
    sendState();
    chime(deaf ? 'deafen' : 'undeafen');
    render();
  }

  // ------------------------------------------------------------------ connections
  // Keep a connection to exactly the people in my room.
  function sync() {
    const want = new Set(here ? peopleIn(here.group, here.room).filter((p) => !p.me).map((p) => p.id) : []);
    for (const id of [...links.keys()]) if (!want.has(id)) dropLink(id);
    for (const id of want) {
      if (links.has(id)) continue;
      // The PC with the smaller id makes the offer, so two offers never cross.
      if (S.me.id < id) connect(id);
    }
  }

  function newLink(id) {
    dropLink(id);
    const pc = new RTCPeerConnection({ iceServers: [] });
    const link = { pc, audio: null, level: null, speaking: false };
    links.set(id, link);
    pc.addTrack(sendTrack, new MediaStream([sendTrack]));
    pc.onicecandidate = (e) => { if (e.candidate) api.rtcSend(id, SID, { g: here.group, kind: 'vr-ice', c: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      const s = e.streams[0] || new MediaStream([e.track]);
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = s;
      audio.muted = deaf;
      if (S.settings.speakerId && audio.setSinkId) audio.setSinkId(S.settings.speakerId).catch(() => {});
      link.audio = audio;
      link.level = levelOf(s);
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { dropLink(id); setTimeout(sync, 1500); }
    };
    return link;
  }

  async function connect(id) {
    const link = newLink(id);
    try {
      const offer = await link.pc.createOffer();
      await link.pc.setLocalDescription(offer);
      api.rtcSend(id, SID, { g: here.group, kind: 'vr-offer', room: here.room, sdp: link.pc.localDescription.toJSON() });
    } catch {
      dropLink(id);
    }
  }

  function dropLink(id) {
    const l = links.get(id);
    if (!l) return;
    links.delete(id);
    try { l.pc.close(); } catch { /* closed */ }
    if (l.audio) { l.audio.srcObject = null; l.audio.remove(); }
  }
  function closeAll() { for (const id of [...links.keys()]) dropLink(id); }

  // ------------------------------------------------------------------ messages
  async function onRtc({ peerId, data }) {
    const group = data && data.g;
    if (typeof group !== 'string' || !S.groups.has(group) || !members(group).includes(peerId)) return;
    const st = others.get(peerId);
    switch (data.kind) {
      case 'vr-state': {
        const room = typeof data.room === 'string' ? data.room.slice(0, 40) : null;
        const wasHere = st && here && st.group === here.group && st.room === here.room && Date.now() - st.at < STATE_TTL;
        if (!room) { if (st && st.group === group) others.delete(peerId); } else others.set(peerId, { group, room, muted: !!data.muted, deaf: !!data.deaf, at: Date.now() });
        const nowHere = room && here && here.group === group && here.room === room;
        if (here && !wasHere && nowHere) chime('join');
        if (here && wasHere && !nowHere) chime('leave');
        if (room && !rooms[group]?.[room] && room !== DEFAULT_ROOM) shareAsk(group, peerId);
        sync();
        render();
        break;
      }
      case 'vr-hello':
        // Someone opened the rooms: tell them where I am and which rooms there are.
        if (here) api.rtcSend(peerId, SID, { g: here.group, kind: 'vr-state', room: here.room, muted, deaf });
        if (rooms[group]) api.rtcSend(peerId, SID, { g: group, kind: 'vr-rooms', rooms: rooms[group] });
        break;
      case 'vr-rooms':
        if (mergeRooms(group, data.rooms)) render();
        break;
      case 'vr-offer': {
        if (!here || here.group !== group || here.room !== data.room) return;
        if (!stream) return;
        // Their room state may not have reached us yet: the offer says where they are.
        if (!st || st.room !== data.room) others.set(peerId, { group, room: data.room, muted: false, deaf: false, at: Date.now() });
        const link = newLink(peerId);
        try {
          await link.pc.setRemoteDescription(data.sdp);
          const answer = await link.pc.createAnswer();
          await link.pc.setLocalDescription(answer);
          api.rtcSend(peerId, SID, { g: group, kind: 'vr-answer', sdp: link.pc.localDescription.toJSON() });
          for (const c of link.pending || []) link.pc.addIceCandidate(c).catch(() => {});
        } catch {
          dropLink(peerId);
        }
        break;
      }
      case 'vr-answer': {
        const link = links.get(peerId);
        if (!link) return;
        try {
          await link.pc.setRemoteDescription(data.sdp);
          for (const c of link.pending || []) link.pc.addIceCandidate(c).catch(() => {});
        } catch { dropLink(peerId); }
        break;
      }
      case 'vr-ice': {
        const link = links.get(peerId);
        if (!link || !data.c) return;
        if (!link.pc.remoteDescription) (link.pending || (link.pending = [])).push(data.c);
        else link.pc.addIceCandidate(data.c).catch(() => {});
        break;
      }
      default:
        break;
    }
  }
  const asked = new Map();
  function shareAsk(group, peerId) {
    if (Date.now() - (asked.get(peerId) || 0) < 10000) return;
    asked.set(peerId, Date.now());
    api.rtcSend(peerId, SID, { g: group, kind: 'vr-hello' });
  }

  // When a group chat opens, ask who is where.
  function lookAround(group) {
    toGroup(group, { kind: 'vr-hello' });
  }

  // ------------------------------------------------------------------ speaking
  function levelOf(s) {
    try {
      ctx = ctx || new AudioContext();
      const src = ctx.createMediaStreamSource(s);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      return { an, buf: new Uint8Array(an.fftSize) };
    } catch { return null; }
  }
  function loud(l) {
    if (!l) return false;
    l.an.getByteTimeDomainData(l.buf);
    let peak = 0;
    for (const v of l.buf) peak = Math.max(peak, Math.abs(v - 128));
    return peak > 10;
  }
  function levels() {
    let changed = false;
    const me = !muted && !deaf && loud(localLevel);
    if (me !== speakingMe) { speakingMe = me; changed = true; }
    for (const l of links.values()) {
      const s = !deaf && loud(l.level);
      if (s !== l.speaking) { l.speaking = s; changed = true; }
    }
    if (changed) paintSpeaking();
  }
  function isSpeaking(id) {
    if (id === S.me.id) return speakingMe;
    const l = links.get(id);
    return !!(l && l.speaking);
  }
  function paintSpeaking() {
    for (const el of document.querySelectorAll('[data-vr-person]')) el.classList.toggle('speaking', isSpeaking(el.dataset.vrPerson));
  }

  // ------------------------------------------------------------------ sounds
  function chime(kind) {
    if (S.settings.sound === false) return;
    try {
      ctx = ctx || new AudioContext();
      const notes = { join: [523, 784], leave: [784, 523], mute: [440], unmute: [660], deafen: [392, 330], undeafen: [330, 494] }[kind] || [600];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        const t0 = ctx.currentTime + i * 0.09;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g).connect(ctx.destination);
        o.start(t0);
        o.stop(t0 + 0.2);
      });
    } catch { /* no audio device */ }
  }

  // ------------------------------------------------------------------ drawing
  const IC = {
    speaker: '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
    mic: '<svg class="ico" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg class="ico" viewBox="0 0 24 24"><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.7 2.5M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/></svg>',
    head: '<svg class="ico" viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
    headOff: '<svg class="ico" viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 12.7-6.5M20 12v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/></svg>',
    hang: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 15.5c5-4.7 13-4.7 18 0l-2.4 2.4-3.2-1.8.2-2.4a10 10 0 0 0-7.2 0l.2 2.4-3.2 1.8z"/></svg>',
    plus: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    more: '<svg class="ico" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  };

  function personHtml(p) {
    const icons = `${p.deaf ? `<i class="vr-flag" title="${esc(t('Deafened'))}">${IC.headOff}</i>` : p.muted ? `<i class="vr-flag" title="${esc(t('Muted'))}">${IC.micOff}</i>` : ''}`;
    return `<div class="vr-person${isSpeaking(p.id) ? ' speaking' : ''}" data-vr-person="${esc(p.id)}">${avatarHtml('direct', p.id, p.me ? S.me.name : peerName(p.id), null, 'sm')}<span>${esc(p.me ? S.me.name : peerName(p.id))}</span>${icons}</div>`;
  }

  // The strip under a group chat's header: its rooms, who is in each, join.
  function renderStrip() {
    const box = $('#voiceRooms');
    if (!box) return;
    const conv = S.active;
    if (!conv || !conv.startsWith('g:') || !S.groups.has(conv.slice(2))) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const group = conv.slice(2);
    const open = !(box.dataset.folded === group);
    const list = roomList(group);
    const total = busyCount(group);
    const cards = list.map((r) => {
      const people = peopleIn(group, r.id);
      const mine = here && here.group === group && here.room === r.id;
      return `<div class="vr-room${mine ? ' here' : ''}${people.length ? ' busy' : ''}">
        <button class="vr-room-head" data-join="${esc(r.id)}" title="${esc(mine ? t('You are in this room') : t('Join the room'))}">${IC.speaker}<b>${esc(roomName(group, r.id))}</b>${people.length ? `<small>${people.length}</small>` : ''}</button>
        <button class="vr-room-more" data-more="${esc(r.id)}" title="${esc(t('More'))}">${IC.more}</button>
        <div class="vr-people">${people.map(personHtml).join('') || `<span class="vr-empty">${esc(t('Empty: click to join'))}</span>`}</div>
      </div>`;
    }).join('');
    const html = `<div class="vr-top"><button class="vr-title" data-fold>${IC.speaker}<span>${esc(t('Voice rooms'))}</span>${total ? `<em>${esc(t('{n} in voice', { n: total }))}</em>` : ''}<span class="fold-arrow">${open ? '▾' : '▸'}</span></button>
      <button class="vr-add" data-add title="${esc(t('New voice room'))}">${IC.plus}</button></div>
      ${open ? `<div class="vr-rooms">${cards}</div>` : ''}`;
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
    box.classList.remove('hidden');
    box.dataset.group = group;
  }

  // The "voice connected" bar above the sidebar's footer, from any chat.
  function renderBar() {
    const bar = $('#vrBar');
    if (!bar) return;
    if (!here || !S.groups.has(here.group)) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    const g = S.groups.get(here.group);
    const n = peopleIn(here.group, here.room).length;
    const html = `<button class="vr-where" data-goto title="${esc(t('Open the group'))}"><span class="vr-live">${esc(t('Voice connected'))}</span><small>${esc(roomName(here.group, here.room))} · ${esc(g.name)} · ${n}</small></button>
      <button class="icon-btn vr-btn${muted ? ' off' : ''}" data-mute title="${esc(muted ? t('Unmute') : t('Mute'))}">${muted ? IC.micOff : IC.mic}</button>
      <button class="icon-btn vr-btn${deaf ? ' off' : ''}" data-deaf title="${esc(deaf ? t('Undeafen') : t('Deafen'))}">${deaf ? IC.headOff : IC.head}</button>
      <button class="icon-btn vr-btn leave" data-leave title="${esc(t('Leave the room'))}">${IC.hang}</button>`;
    if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
    bar.classList.remove('hidden');
  }

  function render() {
    renderStrip();
    renderBar();
    paintSpeaking();
    if (typeof renderList === 'function') renderList(); // eslint-disable-line no-undef
  }

  function roomMenu(group, id, anchor) {
    const r = anchor.getBoundingClientRect();
    const items = [{ label: t('Rename room'), action: () => renameRoom(group, id) }];
    if (id !== DEFAULT_ROOM) items.push({ label: t('Delete room'), danger: true, action: () => deleteRoom(group, id) });
    showMenu(items, r.left, r.bottom + 4); // eslint-disable-line no-undef
  }

  function bind() {
    $('#voiceRooms').addEventListener('click', (e) => {
      const group = $('#voiceRooms').dataset.group;
      if (!group) return;
      const j = e.target.closest('[data-join]');
      if (j) { join(group, j.dataset.join); return; }
      const more = e.target.closest('[data-more]');
      if (more) { roomMenu(group, more.dataset.more, more); return; }
      if (e.target.closest('[data-add]')) { addRoom(group); return; }
      if (e.target.closest('[data-fold]')) {
        const box = $('#voiceRooms');
        box.dataset.folded = box.dataset.folded === group ? '' : group;
        renderStrip();
      }
    });
    $('#vrBar').addEventListener('click', (e) => {
      if (e.target.closest('[data-mute]')) toggleMute();
      else if (e.target.closest('[data-deaf]')) toggleDeaf();
      else if (e.target.closest('[data-leave]')) leave();
      else if (e.target.closest('[data-goto]') && here) openConv(`g:${here.group}`); // eslint-disable-line no-undef
    });
    window.addEventListener('beforeunload', () => { if (here) toGroup(here.group, { kind: 'vr-state', room: null }); });
    // Others' states expire when their PC goes quiet.
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, st] of others) if (now - st.at > STATE_TTL) { others.delete(id); changed = true; }
      if (changed) { sync(); render(); }
    }, 5000);
  }

  return {
    bind, onRtc, render, lookAround, join, leave, toggleMute, toggleDeaf, busyCount, roomList, peopleIn,
    get here() { return here; },
    get muted() { return muted; },
    get deaf() { return deaf; },
    get links() { return links; },
  };
})();
