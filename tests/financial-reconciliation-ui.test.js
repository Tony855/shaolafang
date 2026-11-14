'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const adminCss = fs.readFileSync(path.join(root, 'assets/admin.css'), 'utf8');
const financeModule = fs.readFileSync(path.join(root, 'pages/admin/financial-reconciliation.js'), 'utf8');
const loginHtml = fs.readFileSync(path.join(root, 'super-login.html'), 'utf8');
const firstLoginHtml = fs.readFileSync(path.join(root, 'super-first-login.html'), 'utf8');
const loginScript = fs.readFileSync(path.join(root, 'pages/super-login.js'), 'utf8');

test('financial reconciliation styles are scoped and cache-busted in the admin shell', () => {
  assert.match(adminHtml, /assets\/admin\.css\?v=2026111401/);
  assert.match(adminHtml, /id="module-financial-reconciliation"/);
  assert.match(adminCss, /#module-financial-reconciliation/);
  assert.match(adminCss, /\.finance-batch-card/);
  assert.match(adminCss, /\.finance-review-row/);
  assert.match(adminCss, /#financeImportButton/);
  assert.match(adminCss, /@media \(max-width: 760px\)/);
  assert.match(adminCss, /@media \(max-width: 420px\)/);
  assert.match(adminCss, /:focus/);
});

test('financial review visual polish does not replace existing finance permission or money-safe rendering', () => {
  assert.match(financeModule, /ctx\.hasPermission\('can_manage_financial_reconciliation'\)/);
  assert.match(financeModule, /moneyMinor\(row\.amountMinor, row\.currencyCode\)/);
  assert.match(financeModule, /idempotencyKey/);
  assert.match(financeModule, /data-finance-action="confirm"/);
  assert.match(financeModule, /data-finance-action="reject"/);
});

test('super-admin authentication pages load assets from root paths', () => {
  for (const html of [loginHtml, firstLoginHtml]) {
    assert.match(html, /href="\/assets\/super-login\.css"/);
    assert.match(html, /src="\/assets\/core\.js"/);
    assert.match(html, /src="\/pages\/super-/);
  }
});

test('super-admin login form binds submit and calls the existing login API', () => {
  assert.match(loginHtml, /id="superLoginForm"/);
  assert.match(loginScript, /form\.addEventListener\('submit'/);
  assert.match(loginScript, /event\.preventDefault\(\)/);
  assert.match(loginScript, /SLF\.api\.post\('\/super\/login'/);
  assert.match(loginScript, /loginError/);
  assert.match(loginScript, /window\.location\.replace/);
});
