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
const publicRoutes = read('routes/public.js');

test('customer menu includes configured categories even when no active dish uses them', () => {
  assert.match(customer, /\[\.\.\.\(state\.categoryOrder \|\| \[\]\), \.\.\.state\.menu\.map\(i => i\.category\)/);
});

test('public customer categories use stable ordering for equal sort positions', () => {
  assert.match(publicRoutes, /SELECT id, name, sort FROM menu_categories WHERE store_id=\? ORDER BY sort, id/);
});

test('switching QR store context clears previous store menu, categories, cart, and cached store info', () => {
  assert.match(customer, /function setActiveStoreId\(value\)/);
  assert.match(customer, /state\.menu = \[\]/);
  assert.match(customer, /state\.categoryOrder = \[\]/);
  assert.match(customer, /state\.cart = \{\}/);
  assert.match(customer, /state\.currentStore = null/);
  assert.match(customer, /_storeInfoFetchedForStoreId = null/);
  assert.match(customer, /setActiveStoreId\(info\.storeId\)/);
  assert.match(customer, /setActiveStoreId\(session\.storeId\)/);
});

test('customer QR session resolves store before loading store-scoped currency, categories, and menu', () => {
  const initStart = customer.indexOf('async function init()');
  const init = customer.slice(initStart);
  const sessionResolveIndex = init.indexOf('await fetchTables();');
  const currencyIndex = init.indexOf('await fetchStoreConfig();');
  const categoryIndex = init.indexOf('await fetchCategoryOrder();');
  const storeInfoIndex = init.indexOf('await fetchStoreInfo();');
  const menuIndex = init.indexOf('await fetchMenu();');
  assert.ok(sessionResolveIndex >= 0 && sessionResolveIndex < currencyIndex);
  assert.ok(currencyIndex < categoryIndex && categoryIndex < storeInfoIndex && storeInfoIndex < menuIndex);
  const fetchTablesStart = customer.indexOf('async function fetchTables()');
  const fetchTablesEnd = customer.indexOf('// ============================================================', fetchTablesStart + 50);
  const fetchTablesBody = customer.slice(fetchTablesStart, fetchTablesEnd);
  assert.doesNotMatch(fetchTablesBody, /await fetch(?:StoreConfig|CategoryOrder|StoreInfo|Menu)\(\)/);
});

test('customer menu normalizes both uploads/foo and legacy relative image paths', () => {
  assert.ok(customer.includes('const normalizedImagePath = imageValue.replace('));
  assert.match(customer, /normalizedImagePath\.startsWith\('uploads\/'\)/);
});

test('customer menu renders configured secondary currency and retries missing currency config safely', () => {
  const fallbackIndex = customer.indexOf('state.dualCurrency.currency =');
  const configureIndex = customer.indexOf('SLF.money.configure({');
  assert.ok(fallbackIndex >= 0 && configureIndex > fallbackIndex, 'secondary currency fallback must run before money formatter configuration');
  assert.match(customer, /secondaryCurrency: state\.dualCurrency\.enabled \? state\.dualCurrency\.currency : null/);
  assert.match(customer, /const prices = SLF\.money\.menuPrice\(item\)/);
  assert.match(customer, /prices\.secondary/);
});


test('public store config honors the dual-currency toggle and resolves USD/KHR fallback', () => {
  assert.ok(publicRoutes.includes('store_${storeId}_dual_currency_enabled'));
  assert.match(publicRoutes, /const dualCurrencyEnabled = dualEnabledRow/);
  assert.match(publicRoutes, /const fallbackSecondaryCode = primaryCode === 'USD' \? 'KHR' : 'USD'/);
  assert.match(publicRoutes, /const secondaryCurrency = secondaryCode \? \(currencies\.find\(c => c\.code === secondaryCode\) \|\| null\) : null/);
});

test('customer menu supports absolute and uploaded image paths with a visible load-failure fallback', () => {
  assert.ok(customer.includes('const imageSrc = /^https?:\\/\\//i.test(imageValue)'));
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
