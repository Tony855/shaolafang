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

test('customer pages suppress secondary-currency display while retaining primary currency formatting', () => {
  assert.match(customer, /state\.dualCurrency = \{ enabled: false, currency: null \}/);
  assert.match(customer, /SLF\.money\.primary\(totalBase\)/);
  const money = read('assets/modules/money.js');
  assert.match(money, /return \{ primary: primary\(base\), secondary: '' \}/);
  assert.ok(money.includes("return '<span class=\"money-primary\">' + primary(base) + '</span>';"));

test('delivery storefront shows only the primary currency in cart totals and currency hint', () => {
  const delivery = read('delivery-order.html');
  assert.match(delivery, /right\.textContent=linePrimary;/);
  assert.match(delivery, /\$\('total'\)\.textContent=validTotal\?primaryTotal/);
  assert.match(delivery, /\$\('currencyHint'\)\.textContent=primaryCurrency\.code/);
  assert.doesNotMatch(delivery, /primaryCurrency\.code\s*\+\s*['"]\s*\+\s*['"]/);
});

test('KHQR payment pages show only the selected payment currency amount', () => {
  for (const file of ['pages/cashier.js', 'pages/waiter-payment.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /secHtml|altStr/);
    assert.match(source, /khqrAmount/);
  }
});

test('administrator page amounts do not append a secondary-currency suffix', () => {
  for (const file of ['pages/admin/shared.js', 'assets/admin-bundle.js']) {
    assert.match(read(file), /function dualAmountSuffix\(\) \{ return ''; \}/);
  }
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


test('customer order submission releases its in-flight lock on preflight validation exits', () => {
  const submitStart = customer.indexOf('async function submitOrder()');
  const submitEnd = customer.indexOf('// ============================================================', submitStart + 40);
  const submit = customer.slice(submitStart, submitEnd);
  assert.match(submit, /if \(!isScanSessionValid\(\)\)[^\n]*_submittingOrder = false; return;/);
  assert.match(submit, /if \(!isBackendOnline\)[^\n]*_submittingOrder = false; return;/);
  assert.match(submit, /if \(!check\.ok\)[^\n]*_submittingOrder = false; return;/);
});


test('administrator order settlement requires an explicit method and sends cash received amount', () => {
  for (const source of [orderSource, adminBundle]) {
    assert.match(source, /settle-payment-method/);
    assert.match(source, /value="cash"/);
    assert.match(source, /value="aba"/);
    assert.match(source, /if \(!method\)/);
    assert.match(source, /pay_method: method/);
    assert.match(source, /payload\.cash_received = received/);
    assert.match(source, /statusOrder\(id, 'done', payload\)/);
  }
});
