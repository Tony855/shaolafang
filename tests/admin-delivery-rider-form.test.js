'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('rider form keeps a stable form reference across async submission', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin-delivery.html'), 'utf8');
  const handler = html.match(/\$\('riderForm'\)\.addEventListener\('submit',[\s\S]*?\n\s*\$\('orderSelect'\)/)?.[0] || '';

  assert.match(handler, /const form\s*=\s*e\.currentTarget/);
  assert.match(handler, /const data\s*=\s*new FormData\(form\)/);
  assert.match(handler, /await api\([\s\S]*?\);\s*form\.reset\(\)/);
  assert.doesNotMatch(handler, /e\.currentTarget\.reset\(\)/);
  assert.match(handler, /t\('riderAccountCreatedRefreshFailed'\)/);
  assert.match(html, /t\('orderFulfillmentDelivery'\)/);
  assert.doesNotMatch(html, /· 外卖配送 ·/);
});
