'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const buildScript = fs.readFileSync(path.join(root, 'scripts/build-admin-bundle.js'), 'utf8');
const modulePaths = [...buildScript.matchAll(/'(pages\/admin\/[^']+\.js)'/g)].map(match => match[1]);
const bundle = fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

test('committed admin bundle contains the current source of every admin module', () => {
  assert.ok(modulePaths.length > 0, 'admin bundle build script must declare source modules');
  for (const modulePath of modulePaths) {
    const source = fs.readFileSync(path.join(root, modulePath), 'utf8');
    assert.ok(bundle.includes(source), `admin bundle is stale for ${modulePath}; run npm run build:admin`);
  }
});

test('admin HTML references a versioned bundle URL', () => {
  assert.match(html, /assets\/admin-bundle\.js\?v=\d+/);
});
