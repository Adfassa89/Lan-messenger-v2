'use strict';
// Wire protocol shared by chat and file connections.
//
// Every TCP connection starts with a plaintext "hello" frame from each side
// carrying an ephemeral X25519 public key. Both sides derive the same
// AES-256-GCM key from it, and every later frame is encrypted and
// authenticated. Frames are length-prefixed: [uint32 BE length][payload].

const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

const PROTOCOL = 'lanmsg';
const PROTOCOL_VERSION = 2;
const MAX_FRAME = 4 * 1024 * 1024;
const HANDSHAKE_TIMEOUT = 8000;

const T_JSON = 1;
const T_BIN = 2;

class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.chunks = [];
    this.len = 0;
    this.need = null;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.len += chunk.length;
    for (;;) {
      if (this.need === null) {
        if (this.len < 4) return;
        this.need = this._take(4).readUInt32BE(0);
        if (this.need > MAX_FRAME) throw new Error('Frame too large');
      }
      if (this.len < this.need) return;
      const frame = this._take(this.need);
      this.need = null;
      this.onFrame(frame);
    }
  }

  _take(n) {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.len -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - off);
      c.copy(out, off, 0, k);
      off += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.len -= n;
    return out;
  }
}

function frame(payload) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function makeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey,
    pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

function deriveKey(privateKey, peerPub, idA, idB) {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(peerPub, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const secret = crypto.diffieHellman({ privateKey, publicKey });
  const salt = [idA, idB].sort().join('|');
  return Buffer.from(crypto.hkdfSync('sha256', secret, salt, 'lan-messenger-v2', 32));
}

function seal(key, type, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from([type])), cipher.update(payload), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function open(key, data) {
  if (data.length < 29) throw new Error('Frame too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  return { type: pt[0], payload: pt.subarray(1) };
}

// One encrypted connection to a peer. Emits:
//   'ready' (peerHello), 'json' (obj), 'bin' (buffer), 'close' (err?)
class Link extends EventEmitter {
  constructor(socket, hello) {
    super();
    this.socket = socket;
    this.hello = hello; // our own hello fields: { id, name, port, ... }
    this.peer = null;
    this.key = null;
    this.closed = false;
    this.keys = makeKeyPair();
    this.reader = new FrameReader((f) => this._onFrame(f));

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.on('data', (chunk) => {
      try {
        this.reader.push(chunk);
      } catch (err) {
        this.close(err);
      }
    });
    socket.on('error', (err) => this.close(err));
    socket.on('close', () => this.close());

    this.handshakeTimer = setTimeout(() => this.close(new Error('Handshake timeout')), HANDSHAKE_TIMEOUT);
    this._write(frame(Buffer.from(JSON.stringify({
      proto: PROTOCOL,
      v: PROTOCOL_VERSION,
      pub: this.keys.pub,
      ...hello,
    }))));
  }

  get remoteAddress() {
    const a = this.socket.remoteAddress || '';
    return a.startsWith('::ffff:') ? a.slice(7) : a;
  }

  _write(buf) {
    if (this.closed) return false;
    return this.socket.write(buf);
  }

  _onFrame(data) {
    if (this.closed) return;
    if (!this.key) {
      let h;
      try {
        h = JSON.parse(data.toString('utf8'));
      } catch {
        throw new Error('Bad handshake');
      }
      if (h.proto !== PROTOCOL || typeof h.id !== 'string' || typeof h.pub !== 'string') {
        throw new Error('Not a LAN Messenger peer');
      }
      if (h.id === this.hello.id) throw new Error('Connected to self');
      this.key = deriveKey(this.keys.privateKey, h.pub, this.hello.id, h.id);
      this.peer = h;
      clearTimeout(this.handshakeTimer);
      this.emit('ready', h);
      return;
    }
    const { type, payload } = open(this.key, data);
    if (type === T_JSON) this.emit('json', JSON.parse(payload.toString('utf8')));
    else if (type === T_BIN) this.emit('bin', payload);
  }

  sendJson(obj) {
    if (!this.key) throw new Error('Link not ready');
    return this._write(frame(seal(this.key, T_JSON, Buffer.from(JSON.stringify(obj)))));
  }

  sendBin(buf) {
    if (!this.key) throw new Error('Link not ready');
    return this._write(frame(seal(this.key, T_BIN, buf)));
  }

  close(err) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.socket.destroy();
    this.emit('close', err);
  }
}

// Connects to host:port and resolves once the encrypted handshake is done.
// setup(link) runs synchronously on handshake, before any later frame is
// dispatched, so listeners attached there never miss a message.
function connect(host, port, hello, { timeout = 5000, setup } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const link = new Link(socket, hello);
    const timer = setTimeout(() => link.close(new Error('Connection timeout')), timeout);
    const onClose = (err) => {
      clearTimeout(timer);
      reject(err || new Error('Connection closed'));
    };
    link.once('close', onClose);
    link.once('ready', () => {
      clearTimeout(timer);
      link.off('close', onClose);
      if (setup) {
        try {
          setup(link);
        } catch (err) {
          // E.g. a different PC now has this address: fail instead of hanging.
          link.close(err);
          return reject(err);
        }
      }
      resolve(link);
    });
  });
}

module.exports = {
  PROTOCOL,
  PROTOCOL_VERSION,
  FrameReader,
  Link,
  connect,
  frame,
  seal,
  open,
  makeKeyPair,
  deriveKey,
};
