'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'customer.css'), 'utf8');

test('customer modal has one visual surface, not a nested bordered card', () => {
  assert.match(css, /\.ff-customer \.order-modal-card\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(css, /\.ff-customer \.cart-drawer,\s*\.ff-customer \.order-modal-card/);
});

test('customer modal remains scrollable and constrained on mobile viewports', () => {
  assert.match(css, /\.ff-customer \.order-modal\s*\{[^}]*max-height:\s*min\(82vh,\s*760px\);[^}]*max-height:\s*min\(82dvh,\s*760px\);[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /@media \(max-width:\s*420px\)[\s\S]*?\.ff-customer #confirmOrderModal \.form-actions button\s*\{[^}]*min-height|@media \(max-width:\s*420px\)[\s\S]*?\.ff-customer \.order-modal \.form-actions button/);
});

test('customer order item price rule is not duplicated', () => {
  const selector = css.match(/\.order-card \.order-item \.item-price\s*\{/g) || [];
  assert.equal(selector.length, 1);
});
