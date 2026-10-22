'use strict';
// Signed app updates. The official build signs the app package with a
// private key that only the build server has; every PC checks that
// signature with the matching public key before installing anything it
// received from another PC.

const crypto = require('crypto');

function compareVersions(a, b) {
  const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function payload({ version, em, sha256, size }) {
  return Buffer.from(`lan-messenger-update|${version}|${em}|${sha256}|${size}`);
}

function signMeta(privateKeyPem, { version, em, sha256, size }) {
  const sig = crypto.sign(null, payload({ version, em, sha256, size }), privateKeyPem).toString('base64');
  return { version, em: String(em), sha256, size, sig };
}

function verifyMeta(publicKeyPem, meta) {
  try {
    if (!meta || typeof meta.sig !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) return false;
    return crypto.verify(null, payload(meta), publicKeyPem, Buffer.from(meta.sig, 'base64'));
  } catch {
    return false;
  }
}

function sha256File(file, fsMod) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fsMod.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function sha256FileSync(file, fsMod) {
  return crypto.createHash('sha256').update(fsMod.readFileSync(file)).digest('hex');
}

module.exports = { compareVersions, signMeta, verifyMeta, sha256File, sha256FileSync };
