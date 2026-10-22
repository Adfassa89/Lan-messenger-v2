'use strict';
// Finds other LAN Messenger PCs automatically using UDP broadcast.
// Every few seconds each PC announces "I'm here" on every network adapter.
// Hosts entered by hand (for PCs on other subnets) get the same packets
// sent to them directly.

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const { PROTOCOL } = require('./protocol');

const ANNOUNCE_INTERVAL = 5000;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      if (ni.internal || !ni.netmask) continue;
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// "host" or "host:port"
function parseHost(entry, defaultPort) {
  const m = String(entry).trim().match(/^([^:\s]+)(?::(\d+))?$/);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

class Discovery extends EventEmitter {
  // getInfo() returns the fields we announce: { id, name, dept, status, port }
  constructor({ port, getInfo, getManualHosts, broadcast = true }) {
    super();
    this.port = port;
    this.getInfo = getInfo;
    this.getManualHosts = getManualHosts || (() => []);
    this.broadcast = broadcast;
    this.socket = null;
    this.timer = null;
    this.retryTimer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._bind();
    this.timer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL);
  }

  _bind() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    sock.on('error', (err) => {
      this.emit('warning', `Discovery: ${err.message}`);
      sock.close();
      if (this.socket === sock) this.socket = null;
      if (!this.stopped) this.retryTimer = setTimeout(() => this._bind(), 10000);
    });
    sock.bind(this.port, () => {
      if (this.stopped) return sock.close();
      try {
        sock.setBroadcast(true);
      } catch { /* not fatal */ }
      this.socket = sock;
      this.query();
      this.announce();
    });
  }

  _packet(type) {
    return Buffer.from(JSON.stringify({ t: PROTOCOL, v: 2, type, ...this.getInfo() }));
  }

  _send(buf, host, port) {
    if (!this.socket) return;
    this.socket.send(buf, port, host, () => { /* unreachable hosts are expected */ });
  }

  _targets() {
    const targets = [];
    if (this.broadcast) for (const a of broadcastAddresses()) targets.push({ host: a, port: this.port });
    for (const entry of this.getManualHosts()) {
      const t = parseHost(entry, this.port);
      if (t) targets.push(t);
    }
    return targets;
  }

  _sendAll(type) {
    const buf = this._packet(type);
    for (const t of this._targets()) this._send(buf, t.host, t.port);
  }

  announce() { this._sendAll('announce'); }
  query() { this._sendAll('query'); }

  // Ask one host directly (used when the user types an IP address).
  ping(entry) {
    const t = parseHost(entry, this.port);
    if (!t) return;
    this._send(this._packet('query'), t.host, t.port);
  }

  _onMessage(buf, rinfo) {
    let p;
    try {
      p = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!p || p.t !== PROTOCOL || typeof p.id !== 'string') return;
    if (p.id === this.getInfo().id) return;
    if (p.type === 'bye') {
      this.emit('bye', p.id);
      return;
    }
    if (p.type === 'query') {
      // Answer directly so the asker learns about us immediately.
      this._send(this._packet('announce'), rinfo.address, rinfo.port);
    }
    this.emit('peer', {
      id: p.id,
      name: String(p.name || 'Unknown'),
      dept: String(p.dept || ''),
      status: String(p.status || 'online'),
      host: rinfo.address,
      port: Number(p.port),
      version: p.app || '',
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      const buf = this._packet('bye');
      const targets = this._targets();
      let left = targets.length;
      if (!left) return sock.close();
      for (const t of targets) {
        sock.send(buf, t.port, t.host, () => {
          if (--left === 0) sock.close();
        });
      }
    }
  }
}

module.exports = { Discovery, broadcastAddresses, localAddresses, parseHost };
