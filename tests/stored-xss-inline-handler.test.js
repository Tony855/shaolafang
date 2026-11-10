'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const waiterSource = fs.readFileSync(path.join(root, 'pages/waiter.js'), 'utf8');
const superSource = fs.readFileSync(path.join(root, 'pages/super.js'), 'utf8');
const kitchenSource = fs.readFileSync(path.join(root, 'pages/kitchen.js'), 'utf8');
const adminContextSource = fs.readFileSync(path.join(root, 'pages/admin/context.js'), 'utf8');
const adminBundleSource = fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8');

test('waiter table names are passed through data attributes, not inline JavaScript', () => {
  assert.match(waiterSource, /data-open-table="\$\{esc\(table\.name\)\}"/);
  assert.doesNotMatch(waiterSource, /onclick="openModal\('\$\{esc\(table\.name\)\}'\)"/);
  assert.match(waiterSource, /card\.addEventListener\('click'/);
  assert.match(waiterSource, /tableLabel = .*\+ esc\(table\);/);
  assert.doesNotMatch(waiterSource, /tableLabel = .*\+ table;/);
  assert.match(waiterSource, /orderHistoryList'\)\.innerHTML = .*\+ esc\(e\.message\)/);
});

test('super-admin store names are passed through data attributes, not inline JavaScript', () => {
  assert.match(superSource, /class="show-store-sessions-btn" data-store-id=/);
  assert.match(superSource, /data-store-name="' \+ esc\(s\.store_name \|\| ''\) \+ '"/);
  assert.doesNotMatch(superSource, /onclick="showStoreSessions\(/);
  assert.doesNotMatch(superSource, /esc\(s\.store_name\|\|''\)\.replace\(\/['"]\/g/);
  assert.match(superSource, /button\.addEventListener\('click'/);
});


test('HTML escaping fallbacks remain safe when shared core utilities are unavailable', () => {
  assert.ok(kitchenSource.includes("esc: s => String(s ?? '').replace(/[&<>"));
  assert.ok(adminContextSource.includes("esc: (s) => String(s ?? '').replace(/[&<>"));
  assert.ok(adminBundleSource.includes("esc: (s) => String(s ?? '').replace(/[&<>"));
  assert.equal(adminContextSource.includes('window.esc || String'), false);
  assert.equal(adminBundleSource.includes('window.esc || String'), false);
});