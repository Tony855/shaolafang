'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'super.html'), 'utf8');
const localeCodes = ['zh', 'en', 'vi', 'th', 'km'];
const selectIds = ['cleanLoginLog', 'cleanAuditLog'];

function selectMarkup(id) {
  const escaped = id.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp('<select[^>]*\\bid="' + escaped + '"[^>]*>([\\s\\S]*?)<\\/select>', 'i'));
  assert.ok(match, id + ' select should exist');
  return match[1];
}

test('log-cleanup select options have translation keys in every locale', () => {
  for (const id of selectIds) {
    const options = [...selectMarkup(id).matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    assert.equal(options.length, 2, id + ' should have yes/no options');
    for (const option of options) {
      const attrs = option[1];
      const key = attrs.match(/\bdata-i18n="([^"]+)"/);
      assert.ok(key, id + ' option needs a data-i18n key: ' + option[2].trim());
      for (const locale of localeCodes) {
        const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
        assert.ok(key[1] in dictionary, locale + ' missing option key ' + key[1]);
      }
    }
  }
});
