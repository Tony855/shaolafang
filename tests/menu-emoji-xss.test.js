'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sources = [
  fs.readFileSync(path.join(root, 'pages/admin.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'pages/admin/report.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8')
];

test('user-controlled menu emoji is escaped in every administrator ranking view', () => {
  assert.match(sources[0], /hot-dish-emoji">\$\{esc\(d\.emoji \|\| '🍽️'\)\}/);
  assert.match(sources[1], /\$\{esc\(d\.emoji \|\| ''\)\}/);
  assert.match(sources[2], /\$\{esc\(d\.emoji \|\| ''\)\}/);
  for (const source of sources) {
    assert.doesNotMatch(source, /\$\{d\.emoji \|\|/);
  }
});
