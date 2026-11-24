'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'delivery-order.html'), 'utf8');

test('delivery storefront loads the complete store-scoped category and active menu datasets', () => {
  assert.match(page, /\/api\/public\/categories\?store_id=/);
  assert.match(page, /\/api\/menu\?store_id=/);
  assert.match(page, /categories=Array\.isArray\(payloads\[3\]\)\?payloads\[3\]:\[\]/);
  assert.match(page, /for\(const item of menu\).*categories\.push/s);
  assert.match(page, /currentCategory==='__ALL__'/);
  assert.match(page, /显示 '\+filtered\.length\+' \/ '\+menu\.length\+' 道菜品/);
});

test('delivery storefront renders menu photos and a visible fallback for missing or broken images', () => {
  assert.match(page, /item\.image\|\|item\.image_url/);
  assert.match(page, /\/uploads\//);
  assert.match(page, /loading='lazy'/);
  assert.match(page, /addEventListener\('error'/);
  assert.match(page, /item-photo-fallback/);
  assert.match(page, /aria-label','菜品图片加载失败'/);
});

test('delivery storefront converts item prices to store primary and secondary currencies', () => {
  assert.match(page, /base_price|toBaseAmount/);
  assert.match(page, /price\/rate/);
  assert.match(page, /formatCurrency\(base,primaryCurrency\)/);
  assert.match(page, /dualEnabled&&secondaryCurrency/);
  assert.match(page, /formatCurrency\(totalBase,secondaryCurrency\)/);
  assert.match(page, /currencyHint/);
});

test('delivery storefront provides category filtering and live dish search', () => {
  assert.match(page, /id="categoryNav"/);
  assert.match(page, /className='category-tab'/);
  assert.match(page, /id="menuSearch"/);
  assert.match(page, /addEventListener\('input'/);
  assert.match(page, /categoryMatch&&\(!searchTerm/);
});

test('delivery storefront menu and cart adapt to narrow mobile screens', () => {
  assert.match(page, /@media\(max-width:720px\)/);
  assert.match(page, /@media\(max-width:390px\)/);
  assert.match(page, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(page, /item-photo-fallback/);
});

test('delivery storefront remains a tableless delivery checkout and retains KHQR tracking flow', () => {
  assert.match(page, /\/api\/public\/delivery\/orders/);
  assert.match(page, /recipient_name/);
  assert.match(page, /delivery_address/);
  assert.match(page, /payment_method/);
  assert.match(page, /X-Customer-Token/);
  assert.ok(page.includes('data.trackingUrl'));
  assert.doesNotMatch(page, /scanSessionToken|X-Scan-Session|请先扫码/);
});

test('delivery storefront title header remains fully visible on narrow screens', () => {
  assert.match(page, /<header><h1>🛵 FoodFlow 外卖点餐<\/h1><p id="storeName">/);
  assert.match(page, /header\{width:100%;min-width:0;/);
  assert.match(page, /header h1\{[^}]*flex-wrap:wrap/);
  assert.match(page, /header h1\{[^}]*overflow-wrap:anywhere/);
  assert.match(page, /header p\{[^}]*overflow-wrap:anywhere/);
  assert.match(page, /@media\(max-width:720px\)\{header\{padding:calc\(16px \+ env\(safe-area-inset-top,0px\)\)/);
  assert.doesNotMatch(page, /header\s*\{[^}]*height\s*:/);
});

test('delivery storefront cart lines show quantity-extended subtotals in both currencies', () => {
  assert.match(page, /const lineBase=base\*qty/);
  assert.match(page, /formatCurrency\(lineBase,primaryCurrency\)/);
  assert.match(page, /formatCurrency\(lineBase,secondaryCurrency\)/);
  assert.doesNotMatch(page, /right\.textContent=prices\.primary/);
});

test('delivery storefront quantity controls enforce configured bounds', () => {
  assert.match(page, /Math\.max\(1,Math\.min\(1000,Math\.floor\(configuredMax\)\)\)/);
  assert.match(page, /plus\.disabled=Number\(cart\.get\(String\(item\.id\)\)\|\|0\)>=maxQty/);
  assert.match(page, /minus\.disabled=Number\(cart\.get\(String\(item\.id\)\)\|\|0\)===0/);
});


test('delivery checkout requires a persistent customer identity token before enabling submission', () => {
  assert.match(page, /getCustomerIdentityToken\(\)/);
  assert.match(page, /customer_token:customerToken/);
  assert.match(page, /\$\('submit'\)\.disabled=count===0\|\|!validTotal\|\|!customerToken\|\|!checkoutKey/);
});


test('delivery checkout labels are associated with their fields and quantity controls identify each dish', () => {
  for (const id of ['recipientName', 'recipientPhone', 'paymentMethod', 'deliveryAddress', 'orderNote']) {
    assert.match(page, new RegExp('<label for="' + id + '">'));
    assert.match(page, new RegExp('<(?:input|select|textarea) id="' + id + '"'));
  }
  assert.match(page, /minus\.setAttribute\('aria-label','减少 '\+escText\(item\.name\)\+' 数量'\)/);
  assert.match(page, /plus\.setAttribute\('aria-label','增加 '\+escText\(item\.name\)\+' 数量'\)/);
});

test('delivery checkout persists one idempotency key across reloads and sends it with each submit', () => {
  assert.match(page, /foodflow_delivery_checkout_key_v1:/);
  assert.match(page, /localStorage\.getItem\(checkoutKeyName\)/);
  assert.match(page, /localStorage\.setItem\(checkoutKeyName,key\)/);
  assert.match(page, /'Idempotency-Key':checkoutKey/);
  assert.match(page, /function rotateCheckoutKey\(\)/);
  assert.match(page, /rotateCheckoutKey\(\);/);
  assert.match(page, /\|\|!checkoutKey/);
});
