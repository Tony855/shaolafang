'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cashier = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');

test('cashier ready-to-settle state has one active sky-blue visual definition', () => {
  const readyState = cashier.match(/\.pos-order-card\.status-pending\.ready-to-settle\s*\{[^}]*\}/s)?.[0] || '';
  assert.match(readyState, /#0ea5e9/);
  assert.doesNotMatch(readyState, /#2ecc71/);
  assert.doesNotMatch(cashier, /@keyframes\s+pos-ready-pulse\s*\{/);
  assert.match(cashier, /\.pos-order-card\.ready-to-settle\s*\{[^}]*pos-ready-pulse-sky/s);
  assert.equal((cashier.match(/\.pos-card-ready-tip\s*\{/g) || []).length, 1);
});
test('cashier refund button and focus styles do not retain obsolete overrides', () => {
  assert.equal((cashier.match(/\.pos-detail-btns \.btn-refund\s*\{/g) || []).length, 1);
  assert.match(cashier, /\.pos-detail-btns \.btn-refund\s*\{[^}]*max-width:\s*110px;/s);
  assert.equal((cashier.match(/\.refund-input:focus\s*\{/g) || []).length, 1);
  assert.match(cashier, /\.refund-input:focus\s*\{[^}]*border-color:\s*#ff7a3d;/s);
});


test('customer and waiter pages load shared styles before page-specific overrides', () => {
  const customerHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const waiterHtml = fs.readFileSync(path.join(__dirname, '..', 'waiter.html'), 'utf8');
  assert.ok(customerHtml.indexOf('assets/common.css') < customerHtml.indexOf('assets/customer.css'));
  assert.ok(waiterHtml.indexOf('assets/common.css') < waiterHtml.indexOf('assets/khqr-shared.css'));
  assert.ok(waiterHtml.indexOf('assets/khqr-shared.css') < waiterHtml.indexOf('assets/waiter.css'));
});


test('admin sidebar has no stale mobile widths', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  assert.doesNotMatch(admin, /\.admin-sidebar\s*\{[^}]*width:\s*(?:150|160)px/s);
  assert.match(admin, /width:\s*180px\s*!important/);
  assert.match(admin, /width:\s*170px\s*!important/);
});

test('cashier and waiter payment overlays preserve KHQR stacking order', () => {
  for (const pageCss of ['cashier.css', 'waiter.css']) {
    const css = fs.readFileSync(path.join(__dirname, '..', 'assets', pageCss), 'utf8');
    assert.match(css, /\.modal-overlay\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*300;/s);
    assert.match(css, /#khqrModal\.modal-overlay\s*\{\s*z-index:\s*999\s*!important;\s*\}/);
    assert.match(css, /#paymentModal\.modal-overlay\s*\{\s*z-index:\s*300;\s*\}/);
  }
});


test('super admin modal overlays stay above mobile navigation controls', () => {
  const superCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'super.css'), 'utf8');
  const modalBlock = superCss.match(/\.modal\s*\{([^}]*)\}/)?.[1] || '';
  const menuButtonBlock = superCss.match(/\.mobile-menu-btn\s*\{([^}]*)\}/)?.[1] || '';
  const topBarBlock = superCss.match(/\.super-top\s*\{([^}]*)\}/)?.[1] || '';
  const readZIndex = (block) => Number(block.match(/z-index:\s*(\d+)/)?.[1] || 0);

  assert.ok(readZIndex(modalBlock) > readZIndex(menuButtonBlock));
  assert.ok(readZIndex(modalBlock) > readZIndex(topBarBlock));
  assert.equal(readZIndex(modalBlock), 400);
});
