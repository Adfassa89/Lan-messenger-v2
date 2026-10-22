'use strict';
// electron-builder hook: signs the packed app so other PCs can safely take
// it as an update. Needs the UPDATE_SIGNING_KEY secret; without it the build
// still works but cannot share itself as an update.
const fs = require('fs');
const path = require('path');
const { signMeta, sha256FileSync } = require('../src/core/update');

exports.default = async function afterPack(context) {
  const key = process.env.UPDATE_SIGNING_KEY;
  const asar = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!key || !key.includes('PRIVATE KEY')) {
    console.log('  • UPDATE_SIGNING_KEY not set: this build will not share updates over the network');
    return;
  }
  if (!fs.existsSync(asar)) throw new Error(`app.asar not found at ${asar}`);
  const version = context.packager.appInfo.version;
  const em = require('electron/package.json').version.split('.')[0];
  const meta = signMeta(key, { version, em, sha256: sha256FileSync(asar, fs), size: fs.statSync(asar).size });
  fs.writeFileSync(`${asar}.sig`, JSON.stringify(meta));
  console.log(`  • signed update package ${version}`);
};
