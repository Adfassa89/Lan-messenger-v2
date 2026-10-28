'use strict';
/* global api, $, el, esc, t, toast, call, modal, S, convRecipients, convName, peerName, avatarHtml, playSound */
// Screen sharing. The picture goes directly from PC to PC over the LAN
// (WebRTC); the invitation and connection details travel over the
// existing encrypted chat connection.

const Share = (() => {
  let session = null; // { sid, conv, stream, pcs: Map(peerId -> pc), invited: [], watching: Set }
  const invites = new Map(); // sid -> { peerId, card, timer }

  function newPc(peerId, sid) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (e) => {
      if (e.candidate) api.rtcSend(peerId, sid, { kind: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.pendingIce = [];
    return pc;
  }

  async function addIce(pc, candidate) {
    if (!pc.remoteDescription) {
      pc.pendingIce.push(candidate);
      return;
    }
    try { await pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
  }

  async function flushIce(pc) {
    for (const c of pc.pendingIce.splice(0)) {
      try { await pc.addIceCandidate(c); } catch { /* ignore */ }
    }
  }

  async function pickSource() {
    const sources = await call(api.shareSources());
    if (!sources) return null;
    if (!sources.length) {
      toast(t('Nothing to share was found'), 'error');
      return null;
    }
    sources.sort((a, b) => b.screen - a.screen);
    return new Promise((resolve) => {
      let picked = null;
      modal({
        title: t('Share your screen'),
        wide: true,
        body: `<p class="modal-note">${esc(t('Choose what the other people will see. They can only watch – they cannot control your PC.'))}</p>
          <div class="source-grid">${sources.map((s, i) => `<button class="source" data-i="${i}">
            <img src="${s.thumb}" alt=""><span>${esc(s.screen ? t('Entire screen') + (sources.filter((x) => x.screen).length > 1 ? ` (${esc(s.name)})` : '') : s.name)}</span></button>`).join('')}</div>`,
        onClose: () => resolve(picked),
        onOpen: (m, close) => {
          m.querySelector('.source-grid').addEventListener('click', (e) => {
            const b = e.target.closest('[data-i]');
            if (!b) return;
            picked = sources[Number(b.dataset.i)];
            close();
          });
        },
      });
    });
  }

  async function start(conv) {
    if (session) {
      toast(t('You are already sharing your screen'));
      return;
    }
    const targets = convRecipients(conv).filter((id) => S.peers.get(id)?.online);
    if (!targets.length) {
      toast(t('Nobody in this chat is online right now'), 'error');
      return;
    }
    const source = await pickSource();
    if (!source) return;
    await api.shareSelect(source.id);
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    } catch (err) {
      toast(t('Screen sharing could not start: {error}', { error: err.message }), 'error');
      return;
    }
    const [track] = stream.getVideoTracks();
    if (track) {
      track.contentHint = 'detail';
      track.onended = () => stop();
    }
    session = { sid: crypto.randomUUID(), conv, stream, pcs: new Map(), invited: targets, watching: new Set() };
    for (const peerId of targets) api.rtcSend(peerId, session.sid, { kind: 'invite', name: S.me.name, chat: convName(conv) });
    render();
    toast(t('Invitation sent. Waiting for people to start watching.'));
  }

  function stop() {
    if (!session) return;
    const s = session;
    session = null;
    for (const peerId of s.invited) api.rtcSend(peerId, s.sid, { kind: 'end' });
    for (const pc of s.pcs.values()) pc.close();
    s.stream.getTracks().forEach((tr) => tr.stop());
    render();
  }

  async function onAccept(peerId) {
    const old = session.pcs.get(peerId);
    if (old) old.close();
    const pc = newPc(peerId, session.sid);
    session.pcs.set(peerId, pc);
    for (const track of session.stream.getTracks()) {
      pc.addTransceiver(track, { direction: 'sendonly', streams: [session.stream], sendEncodings: [{ maxBitrate: 8_000_000 }] });
    }
    pc.onconnectionstatechange = () => {
      if (!session) return;
      if (pc.connectionState === 'connected') session.watching.add(peerId);
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) session.watching.delete(peerId);
      render();
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    api.rtcSend(peerId, session.sid, { kind: 'offer', sdp: pc.localDescription.toJSON() });
  }

  function showInvite(peerId, sid, data) {
    if (invites.has(sid)) return;
    const name = String(data.name || peerName(peerId)).slice(0, 60);
    const card = el('div', 'invite-card', `${avatarHtml('direct', peerId, name, null)}
      <div class="ic-body"><b>${esc(t('{name} is sharing their screen', { name }))}</b><span>${esc(String(data.chat || ''))}</span></div>
      <div class="ic-btns"><button class="btn" data-no>${esc(t('Decline'))}</button><button class="btn primary" data-yes>${esc(t('Watch'))}</button></div>`);
    const remove = () => {
      clearTimeout(entry.timer);
      leave(card);
      invites.delete(sid);
    };
    const entry = { peerId, card, timer: setTimeout(remove, 120000) };
    card.querySelector('[data-yes]').onclick = () => {
      remove();
      api.openViewer(peerId, sid, name);
    };
    card.querySelector('[data-no]').onclick = () => {
      remove();
      api.rtcSend(peerId, sid, { kind: 'decline' });
    };
    invites.set(sid, entry);
    $('#invites').append(card);
    if (S.settings.sound) playSound();
  }

  async function onRtc({ peerId, sid, data }) {
    if (data.kind === 'invite') return showInvite(peerId, sid, data);
    if (data.kind === 'end' && invites.has(sid)) {
      const inv = invites.get(sid);
      clearTimeout(inv.timer);
      leave(inv.card);
      invites.delete(sid);
    }
    if (!session || sid !== session.sid || !session.invited.includes(peerId)) return;
    const pc = session.pcs.get(peerId);
    try {
      if (data.kind === 'accept') await onAccept(peerId);
      else if (data.kind === 'answer' && pc) {
        await pc.setRemoteDescription(data.sdp);
        await flushIce(pc);
      } else if (data.kind === 'ice' && pc) await addIce(pc, data.candidate);
      else if (data.kind === 'end' || data.kind === 'decline') {
        if (pc) pc.close();
        session.pcs.delete(peerId);
        session.watching.delete(peerId);
        render();
      }
    } catch (err) {
      console.warn('Screen share:', err);
    }
  }

  function render() {
    const b = $('#shareBanner');
    if (!session) {
      b.classList.add('hidden');
      return;
    }
    b.classList.remove('hidden');
    const watching = [...session.watching].map(peerName);
    b.innerHTML = `<span class="live-dot"></span><b>${esc(t('You are sharing your screen'))}</b>
      <span>${esc(watching.length ? t('Watching: {names}', { names: watching.join(', ') }) : t('Waiting for people to start watching…'))}</span>
      <button class="btn danger" id="btnStopShare">${esc(t('Stop sharing'))}</button>`;
    $('#btnStopShare').onclick = stop;
  }

  return { start, stop, onRtc, render };
})();
