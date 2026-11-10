'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const waiterSource = fs.readFileSync(path.join(root, 'pages/waiter.js'), 'utf8');
const superSource = fs.readFileSync(path.join(root, 'pages/super.js'), 'utf8');

test('waiter table names are passed through data attributes, not inline JavaScript', () => {
  assert.match(waiterSource, /data-open-table="\$\{esc\(table\.name\)\}"/);
  assert.doesNotMatch(waiterSource, /onclick="openModal\('\$\{esc\(table\.name\)\}'\)"/);
  assert.match(waiterSource, /card\.addEventListener\('click'/);
  assert.match(waiterSource, /tableLabel = .*\\+ esc\\(table\\);/);
  assert.doesNotMatch(waiterSource, /tableLabel = .*\\+ table;/);
});

test('super-admin store names are passed through data attributes, not inline JavaScript', () => {
  assert.match(superSource, /class="show-store-sessions-btn" data-store-id=/);
  assert.match(superSource, /data-store-name="' \+ esc\(s\.store_name \|\| ''\) \+ '"/);
  assert.doesNotMatch(superSource, /onclick="showStoreSessions\(/);
  assert.doesNotMatch(superSource, /esc\(s\.store_name\|\|''\)\.replace\(\/['"]\/g/);
  assert.match(superSource, /button\.addEventListener\('click'/);
});
