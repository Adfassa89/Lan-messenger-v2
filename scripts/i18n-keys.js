'use strict';
// Lists every interface text passed to t(...) or marked with data-i18n*,
// so translations can be checked for completeness (see test/i18n.test.js).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const FILES = [
  'renderer/app.js', 'renderer/editor.js', 'renderer/voice.js', 'renderer/share.js',
  'renderer/viewer.js', 'renderer/alert.js', 'renderer/call.js', 'renderer/ring.js', 'renderer/game.js', 'renderer/files-panel.js', 'renderer/voice-rooms.js', 'renderer/tetris-game.js', 'renderer/tetris-controls.js', 'renderer/warlock.js', 'renderer/warlock.html', 'renderer/pudge.js', 'renderer/pudge.html', 'renderer/thirteen.js', 'renderer/thirteen.html', 'renderer/tanks.js', 'renderer/tanks.html', 'renderer/accounts.js', 'renderer/index.html', 'main/main.js',
];
// Texts translated through a variable, e.g. t(label).
const EXTRA = ['Smileys', 'Gestures', 'Work', 'Things', 'Indigo', 'Office', 'Ocean', 'Minimal', 'Mine Site', 'Emerald', 'Chess', 'Tic-tac-toe', 'Connect Four',
  'Pick your side and a time control, like on chess.com', 'Bullet', 'Blitz', 'Rapid', 'Three in a row wins', 'Four in a row wins',
  '{n} kill', '{n} death', '{n} point', '{n} member', '{n} member, {on} online', '{n} file · {size}',
  'Small', 'Normal', 'Large', 'Larger', 'Largest',
  'Checkers', 'Tetris Battle', 'HOLD', 'NEXT', 'Move left', 'Move right', 'Soft drop', 'Hard drop', 'Rotate right', 'Rotate left', 'Rotate 180°', 'Hold',
  'Delay before sliding', 'Sliding speed', 'Soft drop speed', '(DAS – how long you hold before the piece starts sliding)',
  '(ARR – time between steps, 0 = instant)', '(time per row while holding soft drop)', 'Captures are compulsory, kings move both ways; clocks optional', 'Classical', 'Real-time battle: clear lines to send garbage',
  // Pudge Wars item and rune names (pudge.js translates them through a variable).
  "Tiny's Arm", 'Grappling Hook', "Lycan's Paw", "Naix's Jaw", "Barathrum's Lantern", 'Techies Explosive Barrel', "Strygwyr's Claw",
  'Ricochet Turbine', 'Earthshaker Totem', 'Tome of Wisdom', 'Tome of Damage', 'Tome of Health', 'Instant Greater Salve',
  'Haste', 'Gold', 'Shield', 'Fire', 'Dynamite', 'Lightning',
  // 13: combination names (translated through a variable).
  'Single', 'Pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush',
  // Tank: looks, arenas, power-ups and enemy kinds (translated through a variable).
  'Classic', 'Mine site', 'Toy tanks', 'Crossroads', 'Islands', 'Fortress',
  'Power shell', 'Rapid fire', 'Ricochet', 'Freeze', 'Fortify', 'Airstrike', 'Extra life',
  'Scout', 'Trooper', 'Heavy', 'Rocket', 'Drone',
  // Connection quality (calls and voice rooms).
  'Good', 'Fair', 'Poor',
  // Accounts: errors from the main process, shown through a variable.
  'Wrong PIN', 'Too many wrong PINs. Try again later.', 'This PC already has 4 accounts', 'The PIN must be 4 to 6 digits', 'Account not found',
  'This account is signed in on this PC right now', 'This account is already signed in on another Windows user of this PC', 'This is not a LAN Messenger backup', 'Something went wrong',
  'Message not found', 'Download the file first', 'This message cannot be forwarded'];

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function keys() {
  const out = new Set(EXTRA);
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const re = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
    let m;
    while ((m = re.exec(src))) out.add((m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"'));
    const re2 = /data-(?:i18n(?:-title|-ph)?|t)="([^"]*)"/g;
    while ((m = re2.exec(src))) out.add(decode(m[1]));
  }
  return [...out];
}

module.exports = { keys };
if (require.main === module) for (const k of keys()) console.log(JSON.stringify(k));
