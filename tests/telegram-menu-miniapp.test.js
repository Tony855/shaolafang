'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const miniApp = fs.readFileSync(path.join(__dirname, '..', 'telegram-delivery.html'), 'utf8');
const pageRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pages.js'), 'utf8');
const startup = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Telegram Mini App supports global binding resolution and preserves signed store-specific entries', () => {
  assert.ok(miniApp.includes("params.get('entry')"));
  assert.ok(miniApp.includes("params.get('store_id')"));
  assert.ok(miniApp.includes("'/api/public/delivery/telegram-miniapp-stores'+(query.toString()?"));
  assert.ok(miniApp.includes("params.get('bot')"));
  assert.ok(miniApp.includes("button.className='store'"));
  assert.ok(miniApp.includes("&entry='+encodeURIComponent(signature)+'&telegram=1"));
  assert.equal(miniApp.includes('请选择门店'), false);
});

test('the Telegram menu and store-specific link use registered FoodFlow page routes', () => {
  assert.ok(pageRoutes.includes("app.get('/telegram/delivery'"));
  assert.ok(miniApp.includes("location.href='/delivery/order?store_id='"));
  assert.ok(startup.includes("webAppUrl = origin + '/telegram/delivery'"));
  assert.ok(startup.includes("/api/telegram/client/webhook"));
});

test('Mini App rejects missing or malformed store entry parameters', () => {
  assert.ok(miniApp.includes("43}$/.test(entry)"));
  assert.ok(miniApp.includes("d+$/.test(storeId)"));
  assert.ok(miniApp.includes('Number(stores[0].id)!==Number(storeId)'));
  assert.ok(miniApp.includes('const hasStoreId=!!storeId,hasEntry=!!entry'));
  assert.ok(miniApp.includes("query.set('bot',botPath)"));
  assert.ok(miniApp.includes("query.set('entry',entry)"));
});
