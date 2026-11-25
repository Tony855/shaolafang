'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const miniApp = fs.readFileSync(path.join(__dirname, '..', 'telegram-delivery.html'), 'utf8');
const pageRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pages.js'), 'utf8');
const startup = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Telegram Mini App requires a store-specific signed entry and no longer offers a store selector', () => {
  assert.ok(miniApp.includes("params.get('entry')"));
  assert.ok(miniApp.includes("params.get('store_id')"));
  assert.ok(miniApp.includes('/api/public/delivery/telegram-miniapp-stores?store_id='));
  assert.ok(miniApp.includes('stores.length!==1'));
  assert.ok(miniApp.includes("&entry='+encodeURIComponent(entry)+'&telegram=1"));
  assert.equal(miniApp.includes('请选择门店'), false);
});

test('the Telegram menu and store-specific link use registered FoodFlow page routes', () => {
  assert.match(pageRoutes, /app\\.get\\('\\/telegram\\/delivery',[\\s\\S]*telegram-delivery\\.html/);
  assert.ok(miniApp.includes("location.href='/delivery/order?store_id='"));
  assert.ok(startup.includes("webAppUrl = origin + '/telegram/delivery'"));
});

test('Mini App rejects missing or malformed store entry parameters', () => {
  assert.ok(miniApp.includes("!/^\\\\d+$/.test(storeId)"));
  assert.ok(miniApp.includes("!/^[A-Za-z0-9_-]{43}$/.test(entry)"));
  assert.ok(miniApp.includes('Number(stores[0].id)!==Number(storeId)'));
});
