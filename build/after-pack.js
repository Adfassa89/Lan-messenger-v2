'use strict';
// electron-builder hook: signs the packed app so other PCs can safely take
// it as an update. Needs the UPDATE_SIGNING_KEY secret; without it the build
// still works but cannot share itself as an update.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { signMeta, sha256FileSync } = require('../src/core/update');
const PUBLIC_KEY = require('../src/main/update-key');

// Accepts the key as pasted: with or without the BEGIN/END lines, with
// Windows line endings, or with literal "\n" sequences.
function normalizeKey(raw) {
  let s = String(raw).replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  if (!s.includes('-----BEGIN')) {
    const body = s.replace(/\s+/g, '');
    s = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----`;
  }
  return s;
}

function loadKey(raw) {
  let key;
  try {
    key = crypto.createPrivateKey(normalizeKey(raw));
  } catch (err) {
    throw new Error(`UPDATE_SIGNING_KEY is set (${String(raw).length} characters) but is not a valid private key: ${err.message}. Copy the whole content of UPDATE_SIGNING_KEY.txt again.`);
  }
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  if (pub.trim() !== PUBLIC_KEY.trim()) {
    throw new Error('UPDATE_SIGNING_KEY does not match the public key in src/main/update-key.js. Use the UPDATE_SIGNING_KEY.txt that belongs to this app.');
  }
  return key;
}

exports.default = async function afterPack(context) {
  const raw = process.env.UPDATE_SIGNING_KEY;
  const asar = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!raw || !raw.trim()) {
    console.log('  • UPDATE_SIGNING_KEY not set: this build will not share updates over the network');
    return;
  }
  const key = loadKey(raw);
  if (!fs.existsSync(asar)) throw new Error(`app.asar not found at ${asar}`);
  const version = context.packager.appInfo.version;
  const em = require('electron/package.json').version.split('.')[0];
  const meta = signMeta(key, { version, em, sha256: sha256FileSync(asar, fs), size: fs.statSync(asar).size });
  fs.writeFileSync(`${asar}.sig`, JSON.stringify(meta));
  console.log(`  • signed update package ${version}`);
};

module.exports.normalizeKey = normalizeKey;
module.exports.loadKey = loadKey;
