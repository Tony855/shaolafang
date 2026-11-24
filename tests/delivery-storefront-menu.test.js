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
