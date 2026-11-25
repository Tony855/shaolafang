'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'delivery-order.html'), 'utf8');

test('delivery storefront keeps an explicit tracking entry and recent order links after checkout', () => {
  assert.match(html, /id="trackingEntryPanel"/);
  assert.match(html, /id="openTrackingEntry"/);
  assert.match(html, /id="recentDeliveryOrders"/);
  assert.match(html, /foodflow_delivery_recent_orders_v1:'\+storeId/);
  assert.match(html, /rememberTrackingOrder\(data\.orderId,data\.customerToken,data\.orderNo\)/);
  assert.match(html, /#token=\'\+encodeURIComponent\(x\.token\)/);
  assert.match(html, /showTrackingEntry\(data\.trackingUrl/);
  assert.doesNotMatch(html, /}\s*else location\.href=data\.trackingUrl/);
});

test('delivery profile can be saved, prefilled, edited and cleared per store in the browser', () => {
  assert.match(html, /foodflow_delivery_profile_v1:'\+storeId/);
  assert.match(html, /id="saveDeliveryProfile"/);
  assert.match(html, /id="clearDeliveryProfile"/);
  assert.match(html, /function saveDeliveryProfile\(\)/);
  assert.match(html, /function loadDeliveryProfile\(\)/);
  assert.match(html, /localStorage\.setItem\(profileKey/);
  assert.match(html, /localStorage\.removeItem\(profileKey\)/);
  assert.match(html, /loadDeliveryProfile\(\);renderRecentTrackingOrders\(\)/);
  assert.match(html, /saveDeliveryProfile\(\);\s*showTrackingEntry/);
});

test('tracking history only renders numeric order IDs with a 64-character customer bearer token', () => {
  assert.match(html, /Number\.isSafeInteger\(Number\(x\.orderId\)\)/);
  assert.match(html, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(html, /records\.slice\(0,10\)/);
  assert.match(html, /link\.rel='noopener'/);
});
