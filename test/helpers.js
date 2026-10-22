'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Messenger } = require('../src/core/messenger');

// Stay below the port ranges Windows reserves for Hyper-V and dynamic use.
let portBase = 21000 + Math.floor(Math.random() * 2000) * 4;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lanmsg-${label}-`));
}

// Two "PCs" on one machine: different ports, each told where the other is.
function makePair() {
  const a = { udp: portBase++, tcp: portBase++ };
  const b = { udp: portBase++, tcp: portBase++ };
  const mk = (me, other, name) => {
    const dir = tmpDir(name);
    const m = new Messenger({
      dataDir: dir,
      downloadDir: path.join(dir, 'downloads'),
      tcpPort: me.tcp,
      udpPort: me.udp,
      broadcast: false,
      defaultName: name,
    });
    m.config.manualPeers = [`127.0.0.1:${other.udp}`];
    m.dir = dir;
    m.ports = me;
    return m;
  };
  return [mk(a, b, 'Alice'), mk(b, a, 'Bob')];
}

function waitFor(fn, timeout = 8000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function nextPort() {
  return portBase++;
}

module.exports = { makePair, waitFor, tmpDir, nextPort };
