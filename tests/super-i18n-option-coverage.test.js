'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'super.html'), 'utf8');
const localeCodes = ['zh', 'en', 'vi', 'th', 'km'];
const localeDictionaries = Object.fromEntries(localeCodes.map(locale => [
  locale,
  JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'))
]));

function getSelectOptions(id) {
  const match = html.match(new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>', 'i'));
  assert.ok(match, id + ' select should exist');
  return [...match[1].matchAll(/<option([^>]*)>([\\s\\S]*?)<\\/option>/gi)];
}

test('super admin log-cleanup options are translated in every supported locale', () => {
  for (const id of ['cleanLoginLog', 'cleanAuditLog']) {
    const options = getSelectOptions(id);
    assert.equal(options.length, 2, id + ' should contain yes/no options');

    for (const option of options) {
      const key = option[1].match(/data-i18n="([^"]+)"/);
      assert.ok(key, id + ' option must declare data-i18n: ' + option[2].trim());
      for (const locale of localeCodes) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(localeDictionaries[locale], key[1]),
          locale + ' is missing translation key ' + key[1]
        );
      }
    }
  }
});
