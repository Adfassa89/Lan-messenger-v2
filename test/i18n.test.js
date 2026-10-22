'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { keys } = require('../scripts/i18n-keys');
const I18N = require('../src/shared/i18n');

test('every interface text has a Mongolian translation', () => {
  const missing = keys().filter((k) => !I18N.DICTS.mn[k]);
  assert.deepStrictEqual(missing, []);
});

test('translations keep the same {placeholders}', () => {
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const [k, v] of Object.entries(I18N.DICTS.mn)) assert.strictEqual(ph(v), ph(k), k);
});

test('placeholders are filled in', () => {
  assert.strictEqual(I18N.translate('mn', 'Online now: {n}', { n: 4 }), 'Онлайн: 4');
  assert.strictEqual(I18N.translate('en', 'Online now: {n}', { n: 4 }), 'Online now: 4');
});
