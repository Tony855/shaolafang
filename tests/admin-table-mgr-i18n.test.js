'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LANGS = ['zh', 'en', 'vi', 'th', 'km'];
const KEYS = [
  'tableQrPopupBlocked',
  'tableAdminSessionExpired',
  'tableQrPageLoadFailed',
  'adminNoActiveStores',
  'adminStoreAccessRequired'
];

test('table and admin store-access translation keys exist and are non-empty in all locales', () => {
  for (const lang of LANGS) {
    const locale = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang + '.json'), 'utf8'));
    for (const key of KEYS) assert.ok(typeof locale[key] === 'string' && locale[key].trim(), lang + '.' + key);
  }
});

test('table QR and admin store-access user messages use translation keys', () => {
  const table = fs.readFileSync(path.join(ROOT, 'pages/admin/table.js'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'pages/admin/admin-mgr.js'), 'utf8');
  for (const key of KEYS.slice(0, 3)) assert.ok(table.includes("tAdmin('" + key + "')"), 'table.js must use ' + key);
  for (const key of KEYS.slice(3)) assert.ok(admin.includes("tAdmin('" + key + "')"), 'admin-mgr.js must use ' + key);
});
