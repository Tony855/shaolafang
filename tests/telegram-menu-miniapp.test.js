'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const miniApp = fs.readFileSync(path.join(__dirname, '..', 'telegram-delivery.html'), 'utf8');
const pageRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'pages.js'), 'utf8');
const startup = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Telegram Mini App requires a store-specific signed entry and no longer offers a store selector', () => {
  assert.match(miniApp, /telegram\\.org\\/js\\/telegram-web-app\\.js/);
  assert.match(miniApp, /window\\.Telegram&&window\\.Telegram\\.WebApp/);
  assert.match(miniApp, /app\\.ready\\(\\);app\\.expand\\(\\)/);
  assert.match(miniApp, /params\\.get\\('entry'\\)/);
  assert.match(miniApp, /api\\/public\\/delivery\\/telegram-miniapp-stores\\?store_id=/);
  assert.match(miniApp, /stores\\.length!==1/);
  assert.match(miniApp, /delivery\\/order\\?store_id=/);
  assert.doesNotMatch(miniApp, /请选择门店/);
});

test('the Telegram menu and store-specific link use registered FoodFlow page routes', () => {
  assert.match(pageRoutes, /app\\.get\\('\\/telegram\\/delivery',[\\s\\S]*telegram-delivery\\.html/);
  assert.match(miniApp, /location\\.href='\\/delivery\\/order\\?store_id='/);
  assert.match(startup, /webAppUrl = origin \\+ '\\/telegram\\/delivery'/);
});

test('Mini App only accepts a numeric store ID with a signed entry token', () => {
  assert.match(miniApp, /!\\/\\^\\\\d\\+\\$\\\\/\\.test\\(storeId\\)/);
  assert.match(miniApp, /!\\/\\^\\[A-Za-z0-9_-\\]\\{43\\}\\$\\\\/\\.test\\(entry\\)/);
  assert.match(miniApp, /Number\\(stores\\[0\\]\\.id\\)!==Number\\(storeId\\)/);
});
