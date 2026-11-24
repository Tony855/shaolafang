'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const customer = read('pages/customer.js');
const orderSource = read('pages/admin/order.js');
const adminBundle = read('assets/admin-bundle.js');
const adminCss = read('assets/admin.css');
const customerCss = read('assets/customer.css');

test('customer menu includes configured categories even when no active dish uses them', () => {
  assert.match(customer, /\[\.\.\.\(state\.categoryOrder \|\| \[\]\), \.\.\.state\.menu\.map\(i => i\.category\)/);
});

test('customer menu renders configured secondary currency and retries missing currency config safely', () => {
  const fallbackIndex = customer.indexOf('state.dualCurrency.currency =');
  const configureIndex = customer.indexOf('SLF.money.configure({');
  assert.ok(fallbackIndex >= 0 && configureIndex > fallbackIndex, 'secondary currency fallback must run before money formatter configuration');
  assert.match(customer, /secondaryCurrency: state\.dualCurrency\.enabled \? state\.dualCurrency\.currency : null/);
  assert.match(customer, /const prices = SLF\.money\.menuPrice\(item\)/);
  assert.match(customer, /prices\.secondary/);
});

test('customer menu supports absolute and uploaded image paths with a visible load-failure fallback', () => {
  assert.match(customer, /const imageSrc = \^https\?:/);
  assert.match(customer, /menuGrid\.querySelectorAll\('\.img-wrap img'\)/);
  assert.match(customer, /fallback\.textContent = '🍽️'/);
  assert.match(customerCss, /\.menu-image-fallback/);
});

test('admin source and generated bundle use the redesigned order-number component', () => {
  for (const source of [orderSource, adminBundle]) {
    assert.match(source, /class="order-number-label"/);
    assert.match(source, /class="order-number"/);
    assert.match(source, /class="order-context"/);
  }
  assert.match(adminCss, /\.order-item-admin \.top \.order-number/);
  assert.match(adminCss, /\.order-item-admin \.top \.order-context/);
});

test('secondary currency has a dedicated compact customer-menu style', () => {
  assert.match(customerCss, /\.menu-item \.info \.money-secondary/);
});
