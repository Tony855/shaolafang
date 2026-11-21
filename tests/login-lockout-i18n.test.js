'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const loginSource = fs.readFileSync(path.join(root, 'pages/login.js'), 'utf8');
const locales = ['zh', 'en', 'vi', 'th', 'km'];

test('login lockout errors are localized and preserve the remaining wait time', () => {
  assert.match(loginSource, /loginTooManyAttempts/);
  assert.match(loginSource, /登录失败次数过多/);
  for (const locale of locales) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
    assert.equal(typeof dictionary.loginTooManyAttempts, 'string', locale + ' must translate login lockout');
    assert.ok(dictionary.loginTooManyAttempts.includes('{minutes}'), locale + ' must retain the minutes placeholder');
  }
});
