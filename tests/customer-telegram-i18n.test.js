'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const keys = ["customerTelegramUnbindTitle","customerTelegramBindTitle","customerTelegramUnavailable","customerTelegramScanFirst","customerTelegramUnbound","customerTelegramDeepLinkError","customerTelegramStartHint","customerTelegramOperationFailed"];
test('customer Telegram binding messages are translated in all locales', () => {
  const source = fs.readFileSync(path.join(root, 'pages/customer.js'), 'utf8');
  for (const key of keys) assert.ok(source.includes(key), 'missing translation key: ' + key);
  for (const locale of ['zh', 'en', 'vi', 'th', 'km']) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
    for (const key of keys) assert.equal(typeof dictionary[key], 'string', locale + ' missing ' + key);
  }
});
