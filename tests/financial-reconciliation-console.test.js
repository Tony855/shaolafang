'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const moduleSource = fs.readFileSync(path.join(root, 'pages/admin/financial-reconciliation.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'pages/admin/shared.js'), 'utf8');
const builder = fs.readFileSync(path.join(root, 'scripts/build-admin-bundle.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8');

test('financial review console is registered in the admin navigation with finance permission', () => {
  assert.match(html, /data-module="financial-reconciliation" data-perm="can_manage_financial_reconciliation"/);
  assert.match(html, /id="module-financial-reconciliation"/);
  assert.match(shared, /'financial-reconciliation': 'can_manage_financial_reconciliation'/);
  assert.match(shared, /loadFinancialReconciliation/);
});

test('financial review console uses only the tenant-scoped APIs and supported review actions', () => {
  for (const endpoint of [
    '/admin/financial-reconciliation/batches?',
    '/admin/financial-reconciliation/batches/import',
    '/admin/financial-reconciliation/batches/',
    '/admin/financial-reconciliation/items/'
  ]) assert.ok(moduleSource.includes(endpoint), 'missing API path ' + endpoint);
  for (const action of ['confirm', 'reject', 'release', 'reassign', 'classify_exception']) {
    assert.ok(moduleSource.includes(action), 'missing review action ' + action);
  }
  assert.match(moduleSource, /ctx\.hasPermission\('can_manage_financial_reconciliation'\)/);
  assert.match(moduleSource, /esc\(row\.description/);
  assert.match(moduleSource, /suggestion\.status === 'suggested'/);
});

test('financial review module is included in the reproducible admin bundle', () => {
  assert.match(builder, /pages\/admin\/financial-reconciliation\.js/);
  assert.ok(bundle.includes(moduleSource), 'admin bundle is stale for financial reconciliation module');
  assert.match(html, /assets\/admin-bundle\.js\?v=\d+/);
});
