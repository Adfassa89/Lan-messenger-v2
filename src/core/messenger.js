'use strict';
// The heart of the app: keeps track of people on the network, delivers
// messages reliably (queued until the other PC confirms it received them)
// and stores history. It has no user interface and no Electron dependency,
// so it can be tested on its own.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { Link, connect } = require('./protocol');
const { Discovery, localAddresses, parseHost } = require('./discovery');
const { Store } = require('./store');
const { FileTransfers } = require('./files');

const OFFLINE_AFTER = 17000;
const ACK_TIMEOUT = 20000;
const PING_INTERVAL = 8000;
const MAX_TEXT = 20000;
const RELIABLE = new Set(['msg', 'read']);

const uuid = () => crypto.randomUUID();

function defaultSettings(downloadDir) {
  return {
    theme: 'system',
    downloadDir,
    autoAccept: true,
    autoAcceptMaxMB: 100,
    notifications: true,
    sound: true,
    minimizeToTray: true,
    startWithWindows: false,
    autoAway: true,
    enterToSend: true,
  };
}

function preview(msg) {
  if (msg.kind === 'file') return `📎 ${msg.file.name}`;
  return (msg.text || '').replace(/\s+/g, ' ').slice(0, 120);
}

class Messenger extends EventEmitter {
  constructor({
    dataDir,
    downloadDir = path.join(os.homedir(), 'Downloads', 'LAN Messenger'),
    tcpPort = 50101,
    udpPort = 50100,
    broadcast = true,
    appVersion = '2.0.0',
    defaultName = os.userInfo().username || os.hostname(),
  }) {
    super();
    this.store = new Store(dataDir);
    this.tcpPort = tcpPort;
    this.udpPort = udpPort;
    this.appVersion = appVersion;

    const config = this.store.get('config', {});
    if (!config.id) config.id = uuid();
    if (!config.name) config.name = defaultName;
    if (config.dept === undefined) config.dept = '';
    if (!config.status) config.status = 'online';
    config.settings = { ...defaultSettings(downloadDir), ...(config.settings || {}) };
    if (!Array.isArray(config.manualPeers)) config.manualPeers = [];
    this.store.set('config', config);
    this.config = config;

    this.contacts = this.store.get('contacts', {});
    this.groups = this.store.get('groups', {});
    this.convs = this.store.get('conversations', {});
    this.outbox = this.store.get('outbox', []);
    this.offers = this.store.get('offers', {});

    this.peers = new Map();
    for (const c of Object.values(this.contacts)) this.peers.set(c.id, { ...c, online: false, status: 'offline' });

    this.out = new Map(); // peerId -> outbound link state
    this.ackTimers = new Map(); // `${peerId}:${rid}` -> timer
    this.inbound = new Set();
    this.seen = new Map(); // rid -> time, to drop duplicates
    this.files = new FileTransfers(this);
    this.broadcastEnabled = broadcast;
    this.started = false;
    this._pruneOffers();
  }

  get id() { return this.config.id; }
  get settings() { return this.config.settings; }

  // ------------------------------------------------------------------ life cycle
  async start() {
    this.server = net.createServer((socket) => this._onInbound(socket));
    this.server.on('error', (err) => this.emit('warning', `Server: ${err.message}`));
    this.port = await new Promise((resolve, reject) => {
      const tryListen = (port, fallback) => {
        const onError = (err) => {
          if (fallback && err.code === 'EADDRINUSE') tryListen(0, false);
          else reject(err);
        };
        this.server.once('error', onError);
        this.server.listen(port, '0.0.0.0', () => {
          this.server.off('error', onError);
          resolve(this.server.address().port);
        });
      };
      tryListen(this.tcpPort, true);
    });

    this.discovery = new Discovery({
      port: this.udpPort,
      broadcast: this.broadcastEnabled,
      getInfo: () => this._info(),
      getManualHosts: () => this.config.manualPeers,
    });
    this.discovery.on('peer', (p) => this._touchPeer(p));
    this.discovery.on('bye', (id) => this._setOffline(id));
    this.discovery.on('warning', (w) => this.emit('warning', w));
    this.discovery.start();

    this.sweepTimer = setInterval(() => this._sweep(), 3000);
    this.pingTimer = setInterval(() => this._pingAll(), PING_INTERVAL);
    this.started = true;
    setTimeout(() => this._probeManual(), 500);
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.sweepTimer);
    clearInterval(this.pingTimer);
    for (const t of this.ackTimers.values()) clearTimeout(t);
    this.ackTimers.clear();
    for (const st of this.out.values()) {
      clearTimeout(st.retryTimer);
      if (st.link) st.link.close();
    }
    for (const l of this.inbound) l.close();
    this.files.stop();
    this.discovery.stop();
    await new Promise((r) => this.server.close(() => r()));
    this.store.flush();
  }

  _info() {
    return {
      id: this.id,
      name: this.config.name,
      dept: this.config.dept,
      status: this.config.status,
      port: this.port,
      app: this.appVersion,
    };
  }

  _hello(purpose) {
    return { ...this._info(), purpose };
  }

  // ------------------------------------------------------------------ state for the UI
  getState() {
    return {
      me: { ...this._info(), addresses: localAddresses() },
      settings: this.settings,
      manualPeers: this.config.manualPeers,
      peers: this.listPeers(),
      groups: Object.values(this.groups),
      convs: Object.values(this.convs),
    };
  }

  listPeers() {
    return [...this.peers.values()].map((p) => ({
      id: p.id, name: p.name, dept: p.dept || '', host: p.host, port: p.port,
      online: !!p.online, status: p.online ? p.status : 'offline', lastSeen: p.lastSeen || 0,
    }));
  }

  // ------------------------------------------------------------------ peers
  _touchPeer(info, { fromLink = false } = {}) {
    if (!info || !info.id || info.id === this.id) return;
    const now = Date.now();
    const prev = this.peers.get(info.id);
    const wasOnline = prev && prev.online;
    const p = prev ? { ...prev } : { id: info.id };
    let changed = !wasOnline;
    for (const k of ['name', 'dept', 'status', 'host', 'port']) {
      if (info[k] !== undefined && info[k] !== '' && p[k] !== info[k]) {
        if (k === 'host' && fromLink && prev && prev.host && prev.online) continue;
        p[k] = info[k];
        changed = true;
      }
    }
    if (info.dept === '' && p.dept) { p.dept = ''; changed = true; }
    p.online = true;
    p.lastSeen = now;
    this.peers.set(p.id, p);

    const c = this.contacts[p.id];
    if (!c || changed || now - (c.lastSeen || 0) > 60000) {
      this.contacts[p.id] = { id: p.id, name: p.name, dept: p.dept || '', host: p.host, port: p.port, lastSeen: now };
      this.store.touch('contacts');
    }
    if (changed) this.emit('peers', this.listPeers());
    if (this.outbox.some((e) => e.peerId === p.id)) this._flush(p.id);
  }

  _setOffline(id) {
    const p = this.peers.get(id);
    if (!p || !p.online) return;
    p.online = false;
    this.emit('peers', this.listPeers());
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    for (const p of this.peers.values()) {
      if (p.online && now - p.lastSeen > OFFLINE_AFTER) {
        p.online = false;
        changed = true;
      }
    }
    if (changed) this.emit('peers', this.listPeers());
    for (const [rid, t] of this.seen) if (now - t > 3600000) this.seen.delete(rid);
  }

  _pingAll() {
    for (const st of this.out.values()) {
      if (st.link && !st.link.closed) st.link.sendJson({ type: 'ping', ...this._presence() });
    }
    for (const l of this.inbound) if (l.key && l.purpose === 'chat') l.sendJson({ type: 'ping', ...this._presence() });
    this._probeManual();
  }

  _presence() {
    return { name: this.config.name, dept: this.config.dept, status: this.config.status };
  }

  // Manually added hosts are also tried over TCP, in case UDP is blocked.
  _probeManual() {
    const now = Date.now();
    for (const entry of this.config.manualPeers) {
      const t = parseHost(entry, this.tcpPort);
      if (!t) continue;
      const known = [...this.peers.values()].some((p) => p.host === t.host && p.online && now - p.lastSeen < 12000);
      if (!known) this.probe(t.host, this.tcpPort);
    }
  }

  async probe(host, port = this.tcpPort) {
    try {
      const link = await connect(host, port, this._hello('probe'), { timeout: 3000 });
      this._touchPeer({ ...link.peer, host: link.remoteAddress || host });
      link.close();
      return link.peer.id;
    } catch {
      return null;
    }
  }

  addManualPeer(entry) {
    const e = String(entry || '').trim();
    if (!parseHost(e, 0)) throw new Error('Enter an IP address or computer name, e.g. 192.168.1.20');
    if (!this.config.manualPeers.includes(e)) this.config.manualPeers.push(e);
    this.store.touch('config');
    this.discovery.ping(e);
    const t = parseHost(e, this.tcpPort);
    return this.probe(t.host, this.tcpPort);
  }

  removeManualPeer(entry) {
    this.config.manualPeers = this.config.manualPeers.filter((e) => e !== entry);
    this.store.touch('config');
  }

  forgetContact(id) {
    delete this.contacts[id];
    this.peers.delete(id);
    this.outbox = this.outbox.filter((e) => e.peerId !== id);
    this.store.set('outbox', this.outbox);
    this.store.touch('contacts');
    this.emit('peers', this.listPeers());
  }

  // ------------------------------------------------------------------ connections
  _onInbound(socket) {
    const link = new Link(socket, this._hello('server'));
    this.inbound.add(link);
    link.on('close', () => this.inbound.delete(link));
    link.on('ready', (h) => {
      link.purpose = h.purpose;
      if (h.purpose === 'file') return this.files.serve(link, h);
      this._touchPeer({ ...h, host: link.remoteAddress }, { fromLink: true });
      if (h.purpose === 'chat') link.on('json', (obj) => this._onWire(h.id, obj, link));
    });
  }

  _outState(peerId) {
    let st = this.out.get(peerId);
    if (!st) {
      st = { link: null, connecting: null, inflight: new Set(), failures: 0, backoffUntil: 0, flushing: false, again: false, retryTimer: null };
      this.out.set(peerId, st);
    }
    return st;
  }

  _ensureLink(peerId) {
    const st = this._outState(peerId);
    if (st.link && !st.link.closed) return Promise.resolve(st.link);
    if (st.connecting) return st.connecting;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.host) return Promise.reject(new Error('Unknown address'));
    st.connecting = connect(peer.host, peer.port, this._hello('chat'), {
      setup: (link) => {
        if (link.peer.id !== peerId) throw new Error('Unexpected peer at this address');
        link.on('json', (obj) => this._onWire(peerId, obj, link));
      },
    }).then((link) => {
      st.link = link;
      st.failures = 0;
      link.on('close', () => {
        if (st.link !== link) return;
        st.link = null;
        st.inflight.clear();
        for (const [k, t] of this.ackTimers) {
          if (k.startsWith(`${peerId}:`)) {
            clearTimeout(t);
            this.ackTimers.delete(k);
          }
        }
        if (this.started && this.outbox.some((e) => e.peerId === peerId)) this._scheduleRetry(peerId, 1000);
      });
      return link;
    }).finally(() => {
      st.connecting = null;
    });
    return st.connecting;
  }

  _scheduleRetry(peerId, delay) {
    const st = this._outState(peerId);
    clearTimeout(st.retryTimer);
    st.retryTimer = setTimeout(() => this._flush(peerId), delay);
  }

  async _flush(peerId) {
    if (!this.started) return;
    const st = this._outState(peerId);
    if (st.flushing) {
      st.again = true;
      return;
    }
    const peer = this.peers.get(peerId);
    if (!peer || !peer.online) return;
    if (Date.now() < st.backoffUntil) return this._scheduleRetry(peerId, st.backoffUntil - Date.now() + 20);
    const todo = () => this.outbox.filter((e) => e.peerId === peerId && !st.inflight.has(e.rid));
    if (!todo().length) return;

    st.flushing = true;
    try {
      const link = await this._ensureLink(peerId);
      for (const e of todo()) {
        st.inflight.add(e.rid);
        link.sendJson({ ...e.wire, rid: e.rid });
        const key = `${peerId}:${e.rid}`;
        clearTimeout(this.ackTimers.get(key));
        this.ackTimers.set(key, setTimeout(() => {
          this.ackTimers.delete(key);
          link.close(new Error('No acknowledgement'));
        }, ACK_TIMEOUT));
      }
    } catch {
      st.failures++;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(st.failures, 5));
      st.backoffUntil = Date.now() + delay;
      this._scheduleRetry(peerId, delay + 20);
    } finally {
      st.flushing = false;
      if (st.again) {
        st.again = false;
        this._flush(peerId);
      }
    }
  }

  _enqueue(peerId, wire, rid = wire.id || uuid()) {
    this.outbox.push({ peerId, rid, wire });
    this.store.set('outbox', this.outbox);
    this._flush(peerId);
  }

  // Ephemeral (not queued) message to anyone currently online.
  _sendNow(peerId, wire) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.online) return;
    this._ensureLink(peerId).then((link) => link.sendJson(wire)).catch(() => {});
  }

  // ------------------------------------------------------------------ incoming
  _onWire(peerId, obj, link) {
    if (!obj || typeof obj.type !== 'string') return;
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.lastSeen = Date.now();
      if (!peer.online) this._touchPeer({ id: peerId });
    }
    switch (obj.type) {
      case 'ack': return this._onAck(peerId, obj.rid);
      case 'ping':
      case 'presence':
        if (peer && (obj.name !== peer.name || obj.status !== peer.status || obj.dept !== peer.dept)) {
          this._touchPeer({ id: peerId, name: obj.name, dept: obj.dept, status: obj.status });
        }
        return;
      case 'typing': {
        const conv = obj.group ? `g:${obj.group}` : peerId;
        if (obj.group && !this.groups[obj.group]) return;
        return this.emit('typing', { conv, peerId });
      }
      default:
        break;
    }
    if (!RELIABLE.has(obj.type) || typeof obj.rid !== 'string') return;
    const dupKey = `${peerId}:${obj.rid}`;
    if (!this.seen.has(dupKey)) {
      this.seen.set(dupKey, Date.now());
      try {
        if (obj.type === 'msg') this._onMsg(peerId, obj);
        else if (obj.type === 'read') this._onRead(peerId, obj);
      } catch (err) {
        this.emit('warning', `Bad message from ${peerId}: ${err.message}`);
      }
    }
    // Acknowledge even duplicates: the sender clearly missed our first ack.
    link.sendJson({ type: 'ack', rid: obj.rid });
  }

  _onAck(peerId, rid) {
    const key = `${peerId}:${rid}`;
    clearTimeout(this.ackTimers.get(key));
    this.ackTimers.delete(key);
    const st = this._outState(peerId);
    st.inflight.delete(rid);
    const i = this.outbox.findIndex((e) => e.peerId === peerId && e.rid === rid);
    if (i < 0) return;
    const [entry] = this.outbox.splice(i, 1);
    this.store.set('outbox', this.outbox);
    if (entry.wire.type === 'msg') {
      const conv = entry.conv || this._convForWire(entry.wire, peerId);
      const msg = this.store.getMessage(conv, entry.wire.id);
      if (msg) {
        if (!msg.deliveredTo.includes(peerId)) msg.deliveredTo.push(peerId);
        this._recomputeStatus(conv, msg);
      }
    }
  }

  _convForWire(wire, peerId) {
    if (wire.broadcast) return 'broadcast';
    if (wire.group) return `g:${wire.group.id}`;
    return peerId;
  }

  _recomputeStatus(conv, msg) {
    const total = (msg.recipients || []).length;
    let status;
    if (total && msg.readBy.length >= total) status = 'read';
    else if (total && msg.deliveredTo.length >= total) status = 'delivered';
    else if (msg.deliveredTo.length) status = 'partial';
    else status = 'queued';
    this.store.updateMessage(conv, msg.id, { status });
    this.emit('message', { conv, msg, isNew: false });
  }

  _onMsg(peerId, w) {
    const kind = ['text', 'file', 'system'].includes(w.kind) ? w.kind : 'text';
    let conv = peerId;
    let type = 'direct';
    if (w.broadcast) {
      conv = 'broadcast';
      type = 'broadcast';
    } else if (w.group && typeof w.group.id === 'string') {
      const members = Array.isArray(w.group.members) ? w.group.members.filter((x) => typeof x === 'string') : [];
      if (!members.includes(this.id) && !this.groups[w.group.id]) return;
      conv = `g:${w.group.id}`;
      type = 'group';
      this.groups[w.group.id] = { id: w.group.id, name: String(w.group.name || 'Group').slice(0, 80), members };
      if (!members.includes(this.id)) delete this.groups[w.group.id];
      this.store.touch('groups');
      this.emit('groups', Object.values(this.groups));
    }
    if (this.store.hasMessage(conv, w.id)) return;
    const peer = this.peers.get(peerId);
    const msg = {
      id: String(w.id),
      from: peerId,
      fromName: (peer && peer.name) || String(w.fromName || 'Unknown'),
      ts: Date.now(),
      sentTs: Number(w.ts) || Date.now(),
      kind,
      text: String(w.text || '').slice(0, MAX_TEXT),
      status: 'received',
      read: false,
    };
    if (kind === 'file') {
      if (!w.file || typeof w.file.tid !== 'string') return;
      msg.file = { tid: w.file.tid, name: String(w.file.name || 'file'), size: Number(w.file.size) || 0, state: 'offered' };
    }
    this.store.addMessage(conv, msg);
    this._bumpConv(conv, type, msg, kind !== 'system');
    this.emit('message', { conv, msg, isNew: true, incoming: true });

    if (kind === 'file' && this.settings.autoAccept && msg.file.size <= this.settings.autoAcceptMaxMB * 1024 * 1024) {
      setImmediate(() => this.files.download(conv, msg.id));
    }
  }

  _onRead(peerId, w) {
    const conv = w.broadcast ? 'broadcast' : w.group ? `g:${w.group}` : peerId;
    for (const id of Array.isArray(w.ids) ? w.ids : []) {
      const msg = this.store.getMessage(conv, id);
      if (!msg || msg.from !== this.id) continue;
      if (!msg.readBy.includes(peerId)) msg.readBy.push(peerId);
      if (!msg.deliveredTo.includes(peerId)) msg.deliveredTo.push(peerId);
      this._recomputeStatus(conv, msg);
    }
  }

  // ------------------------------------------------------------------ conversations
  _convType(conv) {
    if (conv === 'broadcast') return 'broadcast';
    if (conv.startsWith('g:')) return 'group';
    return 'direct';
  }

  _bumpConv(conv, type, msg, countUnread) {
    const c = this.convs[conv] || { id: conv, type, unread: 0 };
    c.lastTs = msg.ts;
    c.lastText = preview(msg);
    c.lastFrom = msg.from;
    if (countUnread && msg.from !== this.id) c.unread = (c.unread || 0) + 1;
    this.convs[conv] = c;
    this.store.touch('conversations');
    this.emit('conv', c);
  }

  recipients(conv) {
    const type = this._convType(conv);
    if (type === 'direct') return [conv];
    if (type === 'group') {
      const g = this.groups[conv.slice(2)];
      return g ? g.members.filter((m) => m !== this.id) : [];
    }
    return [...this.peers.keys()];
  }

  _wireFor(conv, msg) {
    const wire = { type: 'msg', id: msg.id, ts: msg.ts, kind: msg.kind, text: msg.text, fromName: this.config.name };
    if (msg.file) wire.file = { tid: msg.file.tid, name: msg.file.name, size: msg.file.size };
    const type = this._convType(conv);
    if (type === 'broadcast') wire.broadcast = true;
    if (type === 'group') wire.group = this.groups[conv.slice(2)];
    return wire;
  }

  _sendMsg(conv, fields, recipients = this.recipients(conv)) {
    const type = this._convType(conv);
    if (type === 'group' && !this.groups[conv.slice(2)]) throw new Error('You are not a member of this group');
    const msg = {
      id: uuid(),
      from: this.id,
      fromName: this.config.name,
      ts: Date.now(),
      kind: 'text',
      text: '',
      status: 'queued',
      recipients,
      deliveredTo: [],
      readBy: [],
      ...fields,
    };
    this.store.addMessage(conv, msg);
    this._bumpConv(conv, type, msg, false);
    this.emit('message', { conv, msg, isNew: true });
    const wire = this._wireFor(conv, msg);
    for (const peerId of recipients) {
      this.outbox.push({ peerId, rid: msg.id, wire, conv });
    }
    this.store.set('outbox', this.outbox);
    for (const peerId of recipients) this._flush(peerId);
    if (!recipients.length) this._recomputeStatus(conv, msg);
    return msg;
  }

  sendText(conv, text) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (t.length > MAX_TEXT) throw new Error(`Message is too long (max ${MAX_TEXT} characters)`);
    return this._sendMsg(conv, { kind: 'text', text: t });
  }

  sendFiles(conv, paths) {
    const sent = [];
    for (const p of paths) {
      let stat;
      try {
        stat = fs.statSync(p);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const tid = uuid();
      const name = path.basename(p);
      const recipients = this.recipients(conv);
      const msg = this._sendMsg(conv, { kind: 'file', file: { tid, name, size: stat.size, path: p, state: 'sent' } }, recipients);
      this.offers[tid] = { path: p, name, size: stat.size, allowed: recipients, conv, msgId: msg.id, ts: Date.now() };
      this.store.touch('offers');
      sent.push(msg);
    }
    return sent;
  }

  _pruneOffers() {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    let changed = false;
    for (const [tid, o] of Object.entries(this.offers)) {
      if (o.ts < cutoff) {
        delete this.offers[tid];
        changed = true;
      }
    }
    if (changed) this.store.touch('offers');
  }

  acceptFile(conv, msgId) { return this.files.download(conv, msgId); }

  cancelFile(conv, msgId) {
    const msg = this.store.getMessage(conv, msgId);
    if (msg && msg.file) this.files.cancel(msg.file.tid);
  }

  markRead(conv) {
    const c = this.convs[conv];
    if (c && c.unread) {
      c.unread = 0;
      this.store.touch('conversations');
      this.emit('conv', c);
    }
    const unread = this.store.messages(conv, { limit: 500 }).filter((m) => m.from !== this.id && m.read === false);
    if (!unread.length) return;
    const bySender = new Map();
    for (const m of unread) {
      this.store.updateMessage(conv, m.id, { read: true });
      if (!bySender.has(m.from)) bySender.set(m.from, []);
      bySender.get(m.from).push(m.id);
    }
    const type = this._convType(conv);
    for (const [peerId, ids] of bySender) {
      const wire = { type: 'read', ids };
      if (type === 'group') wire.group = conv.slice(2);
      if (type === 'broadcast') wire.broadcast = true;
      this._enqueue(peerId, wire, uuid());
    }
  }

  sendTyping(conv) {
    const type = this._convType(conv);
    if (type === 'broadcast') return;
    const wire = { type: 'typing' };
    if (type === 'group') wire.group = conv.slice(2);
    for (const peerId of this.recipients(conv)) this._sendNow(peerId, wire);
  }

  loadMessages(conv, opts) {
    return this.store.messages(conv, opts);
  }

  search(query) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    return this.store.search(q);
  }

  deleteMessage(conv, id) {
    this.store.deleteMessage(conv, id);
  }

  clearConversation(conv) {
    this.store.clearHistory(conv);
    const c = this.convs[conv];
    if (c) {
      c.lastText = '';
      c.unread = 0;
      this.store.touch('conversations');
      this.emit('conv', c);
    }
  }

  // ------------------------------------------------------------------ groups
  createGroup(name, memberIds) {
    const members = [...new Set([this.id, ...memberIds.filter((m) => this.peers.has(m))])];
    if (members.length < 2) throw new Error('Choose at least one person for the group');
    const g = { id: uuid(), name: String(name || '').trim().slice(0, 80) || 'New group', members };
    this.groups[g.id] = g;
    this.store.touch('groups');
    this.emit('groups', Object.values(this.groups));
    const conv = `g:${g.id}`;
    this._sendMsg(conv, { kind: 'system', text: `${this.config.name} created the group "${g.name}"` });
    return conv;
  }

  updateGroup(groupId, { name, addMembers = [] }) {
    const g = this.groups[groupId];
    if (!g) throw new Error('Group not found');
    const before = new Set(g.members);
    const added = addMembers.filter((m) => !before.has(m) && this.peers.has(m));
    if (name && name.trim()) g.name = name.trim().slice(0, 80);
    g.members.push(...added);
    this.store.touch('groups');
    this.emit('groups', Object.values(this.groups));
    const names = added.map((m) => this.peers.get(m).name);
    const text = names.length
      ? `${this.config.name} added ${names.join(', ')}`
      : `${this.config.name} renamed the group to "${g.name}"`;
    this._sendMsg(`g:${groupId}`, { kind: 'system', text });
  }

  leaveGroup(groupId) {
    const g = this.groups[groupId];
    if (!g) return;
    const conv = `g:${groupId}`;
    const recipients = g.members.filter((m) => m !== this.id);
    g.members = recipients;
    this._sendMsg(conv, { kind: 'system', text: `${this.config.name} left the group` }, recipients);
    delete this.groups[groupId];
    delete this.convs[conv];
    this.store.touch('groups');
    this.store.touch('conversations');
    this.emit('groups', Object.values(this.groups));
  }

  // ------------------------------------------------------------------ profile / settings
  setProfile({ name, dept, status }) {
    if (typeof name === 'string' && name.trim()) this.config.name = name.trim().slice(0, 60);
    if (typeof dept === 'string') this.config.dept = dept.trim().slice(0, 60);
    if (['online', 'away', 'busy'].includes(status)) this.config.status = status;
    this.store.touch('config');
    if (this.started) {
      this.discovery.announce();
      for (const peerId of this.out.keys()) this._sendNow(peerId, { type: 'presence', ...this._presence() });
    }
    this.emit('me', this.getState().me);
  }

  setSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in this.config.settings) this.config.settings[k] = v;
    }
    this.store.touch('config');
    return this.settings;
  }
}

module.exports = { Messenger, preview };
