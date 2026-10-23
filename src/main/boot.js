'use strict';
// Starts the newest verified version of the app: either the one that was
// installed, or a signed update received from another PC on the network.
// Updates that keep failing to start are skipped automatically.

const path = require('path');
const { app } = require('electron');
const { compareVersions, verifyMeta, sha256FileSync } = require('../core/update');
const PUBLIC_KEY = require('./update-key');
const INSTALLED_VERSION = require('../../package.json').version;

// Chats and settings stay in the original "LAN Messenger" folder, so they
// survive the rename to "LAN Messenger 2". Developers can run several copies
// on one PC with separate profile folders.
if (process.env.LANMSG_PROFILE) app.setPath('userData', path.resolve(process.env.LANMSG_PROFILE));
else app.setPath('userData', path.join(app.getPath('appData'), 'LAN Messenger'));

let target = path.join(__dirname, 'main.js');

function pickUpdate() {
  if (!app.isPackaged || process.env.LANMSG_NO_UPDATE) return;
  // original-fs reads .asar files as plain files instead of folders.
  const ofs = require('original-fs');
  const dir = path.join(app.getPath('userData'), 'updates');
  const stateFile = path.join(dir, 'state.json');
  let state;
  try {
    state = JSON.parse(ofs.readFileSync(stateFile, 'utf8'));
  } catch {
    return;
  }
  if (!state || compareVersions(state.version, INSTALLED_VERSION) <= 0) return;
  if ((state.attempts || 0) >= 3) return; // crashed on start three times: stay on the installed version
  const asar = path.join(dir, path.basename(String(state.file)));
  const meta = JSON.parse(ofs.readFileSync(`${asar}.sig`, 'utf8'));
  const em = process.versions.electron.split('.')[0];
  if (!verifyMeta(PUBLIC_KEY, meta) || meta.version !== state.version || meta.em !== em) return;
  if (sha256FileSync(asar, ofs) !== meta.sha256) return;
  state.attempts = (state.attempts || 0) + 1;
  ofs.writeFileSync(stateFile, JSON.stringify(state));
  global.lanmsgBoot = { asar, meta, version: meta.version, stateFile };
  target = path.join(asar, 'src', 'main', 'main.js');
}

try {
  pickUpdate();
} catch (err) {
  console.error('Update check failed, starting installed version:', err);
}

try {
  require(target);
} catch (err) {
  if (target === path.join(__dirname, 'main.js')) throw err;
  console.error('Update failed to load, starting installed version:', err);
  global.lanmsgBoot = null;
  require('./main.js');
}
