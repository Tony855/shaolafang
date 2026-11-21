'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const keys = ["superFirstLoginMismatch","superFirstLoginWeak","superFirstLoginSaving","superFirstLoginUpdateFailed","superFirstLoginSuccess","superFirstLoginCleanupFailed","superFirstLoginSave","superFirstLoginError","superFirstLoginLogout"];
const locales = ['zh', 'en', 'vi', 'th', 'km'];
test('super admin first-login messages are translated in every locale', () => {
  const source = fs.readFileSync(path.join(root, 'pages/super-first-login.js'), 'utf8');
  for (const key of keys) assert.ok(source.includes(key), 'missing translation call: ' + key);
  for (const locale of locales) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
    for (const key of keys) assert.equal(typeof dictionary[key], 'string', locale + ' missing ' + key);
  }
});
