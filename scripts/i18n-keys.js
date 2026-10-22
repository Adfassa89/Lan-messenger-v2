'use strict';
// Lists every interface text passed to t(...) or marked with data-i18n*,
// so translations can be checked for completeness (see test/i18n.test.js).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const FILES = [
  'renderer/app.js', 'renderer/editor.js', 'renderer/voice.js', 'renderer/share.js',
  'renderer/viewer.js', 'renderer/alert.js', 'renderer/index.html', 'main/main.js',
];
const EXTRA = ['Smileys', 'Gestures', 'Work', 'Things'];

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
    const re2 = /data-i18n(?:-title|-ph)?="([^"]*)"/g;
    while ((m = re2.exec(src))) out.add(decode(m[1]));
  }
  return [...out];
}

module.exports = { keys };
if (require.main === module) for (const k of keys()) console.log(JSON.stringify(k));
