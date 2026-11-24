'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cashier = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');

test('cashier ready-to-settle state has one active sky-blue visual definition', () => {
  assert.doesNotMatch(cashier, /#2ecc71|pos-ready-pulse\s/);
  assert.match(cashier, /\.pos-order-card\.status-pending\.ready-to-settle\s*\{[^}]*#0ea5e9/s);
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
