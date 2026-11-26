'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

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

test('delivery storefront converts item prices and displays only the primary currency', () => {
  assert.match(page, /base_price|toBaseAmount/);
  assert.match(page, /price\/rate/);
  assert.match(page, /formatCurrency\(base,primaryCurrency\)/);
  assert.doesNotMatch(page, /dualEnabled&&secondaryCurrency/);
  assert.doesNotMatch(page, /formatCurrency\(totalBase,secondaryCurrency\)/);
  assert.match(page, /currencyHint/);
  assert.ok(page.includes("$('currencyHint').textContent=primaryCurrency.code"));
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
  assert.ok(page.includes("body>header{display:flex;width:100%;max-width:none;min-width:0;margin:0;"));
  assert.match(page, /header h1\{[^}]*flex-wrap:wrap/);
  assert.match(page, /header h1\{[^}]*overflow-wrap:anywhere/);
  assert.match(page, /header p\{[^}]*overflow-wrap:anywhere/);
  assert.ok(page.includes("@media(max-width:720px){\n body>header{padding:calc(16px + env(safe-area-inset-top,0px))"));
  assert.doesNotMatch(page, /header\s*\{[^}]*height\s*:/);
});

test('delivery storefront cart lines show quantity-extended subtotals only in the primary currency', () => {
  assert.match(page, /const lineBase=base\*qty/);
  assert.match(page, /formatCurrency\(lineBase,primaryCurrency\)/);
  assert.doesNotMatch(page, /formatCurrency\(lineBase,secondaryCurrency\)/);
  assert.ok(page.includes('right.textContent=linePrimary;'));
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
  assert.match(page, /sessionStorage\.getItem\(checkoutKeyName\)/);
  assert.match(page, /sessionStorage\.setItem\(checkoutKeyName,key\)/);
  assert.match(page, /'Idempotency-Key':checkoutKey/);
  assert.match(page, /function rotateCheckoutKey\(\)/);
  assert.match(page, /rotateCheckoutKey\(\);/);
  assert.match(page, /\|\|!checkoutKey/);
});

test('checkout keys survive reload in one tab but remain isolated across tabs', () => {
  const start = page.indexOf(' function createCheckoutKey(){');
  const end = page.indexOf(' let telegramBound=', start);
  assert.ok(start >= 0 && end > start, 'checkout key functions must remain a contiguous testable block');
  const source = page.slice(start, end) + '\n({ get key(){ return checkoutKey; }, name: checkoutKeyName, rotateCheckoutKey })';
  const makeStorage = () => {
    const values = new Map();
    return {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); }
    };
  };
  const makeTab = storage => vm.runInNewContext(source, {
    storeId: '9',
    sessionStorage: storage,
    window: { crypto: { getRandomValues(bytes) { return crypto.randomFillSync(bytes); } } },
    Uint8Array, Array, Math, String
  });
  const firstTabStorage = makeStorage();
  const firstTab = makeTab(firstTabStorage);
  assert.match(firstTab.key, /^[a-f0-9]{64}$/);
  const sameTabAfterReload = makeTab(firstTabStorage);
  assert.equal(sameTabAfterReload.key, firstTab.key, 'same-tab reload must reuse the pending checkout key');

  const secondTab = makeTab(makeStorage());
  assert.match(secondTab.key, /^[a-f0-9]{64}$/);
  assert.notEqual(secondTab.key, firstTab.key, 'independent tabs must not share checkout keys');

  const oldKey = firstTab.key;
  firstTab.rotateCheckoutKey();
  assert.notEqual(firstTab.key, oldKey);
  assert.equal(makeTab(firstTabStorage).key, firstTab.key, 'rotated key must persist for retries in the same tab');
});

test('customer identity remains browser-wide while checkout idempotency is tab-scoped', () => {
  assert.match(page, /localStorage\.getItem\(key\)/);
  assert.match(page, /localStorage\.setItem\(key,token\)/);
  assert.match(page, /sessionStorage\.getItem\(checkoutKeyName\)/);
  assert.match(page, /sessionStorage\.setItem\(checkoutKeyName,key\)/);
});


test("delivery storefront header is anchored to the full mobile viewport width", () => {
  assert.ok(page.includes("html{width:100%;min-width:0;max-width:100%;margin:0;overflow-x:clip}"));
  assert.ok(page.includes("body>header{display:flex;width:100%;max-width:none;min-width:0;margin:0;"));
});


test("delivery storefront preserves native vertical page scrolling on iPhone Safari", () => {
  assert.ok(page.includes("html{width:100%;min-width:0;max-width:100%;margin:0;overflow-x:clip}"));
  assert.ok(page.includes("touch-action:pan-y;-webkit-overflow-scrolling:touch"));
  assert.ok(!page.includes("html,body{width:100%;min-width:0;max-width:100%;margin:0;overflow-x:hidden}"));
});

test("delivery category navigation scrolls horizontally without capturing vertical page gestures", () => {
  assert.ok(page.includes("overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;touch-action:pan-x"));
});


test("delivery storefront uses fluid viewport width and responsive breakpoints", () => {
  assert.ok(page.includes("body>header{display:flex;width:100%;max-width:none;min-width:0;margin:0;"), "header must follow the containing viewport width without 100vw margin offsets");
  assert.ok(page.includes("@media(max-width:1024px){main{width:100%;max-width:760px}.layout{grid-template-columns:minmax(0,1fr);gap:0}}"));
  assert.ok(page.includes("@media(max-width:720px){\n body>header{padding:calc(16px + env(safe-area-inset-top,0px)) 14px 17px}"));
  assert.ok(page.includes("@media(max-width:480px){\n .menu{grid-template-columns:minmax(0,1fr)}"));
  assert.ok(page.includes("@media(max-width:360px){\n main{padding:0 8px}"));
});


test('Telegram Mini App store loading has bounded network waits and a visible retry path', () => {
  assert.match(page, /async function fetchWithTimeout\(url,options=\{\}\)/);
  assert.match(page, /setTimeout\(\(\)=>controller\.abort\(\),12000\)/);
  assert.match(page, /fetchWithTimeout\('\/api\/public\/delivery\/telegram-miniapp-stores/);
  assert.match(page, /endpoints\.map\(url=>fetchWithTimeout\(url/);
  assert.match(page, /responses\[3\]\.networkError\?\[\]/);
  assert.match(page, /id="retryStoreLoad"/);
  assert.match(page, /async function loadStorefront\(\)/);
  assert.match(page, /\$\('storeName'\)\.textContent='门店加载失败'/);
  assert.match(page, /retry\.hidden=false/);
  assert.match(page, /addEventListener\('click',loadStorefront\)/);
});
