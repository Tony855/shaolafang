'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const miniApp = fs.readFileSync(path.join(__dirname, '..', 'telegram-delivery.html'), 'utf8');

test('Telegram delivery Mini App is a Telegram Web App store selector, not a website launch CTA', () => {
  assert.match(miniApp, /telegram\.org\/js\/telegram-web-app\.js/);
  assert.match(miniApp, /window\.Telegram&&window\.Telegram\.WebApp/);
  assert.match(miniApp, /app\.ready\(\);app\.expand\(\)/);
  assert.match(miniApp, /api\/public\/delivery\/telegram-miniapp-stores/);
  assert.match(miniApp, /if\(stores\.length===1\)/);
  assert.match(miniApp, /delivery\/order\?store_id=/);
  assert.doesNotMatch(miniApp, /t\.me\//);
  assert.doesNotMatch(miniApp, /start=delivery_/);
});

test('Telegram Mini App renders store names as text and only opens validated numeric store IDs', () => {
  assert.match(miniApp, /name\.textContent=store\.name/);
  assert.match(miniApp, /Number\.isSafeInteger\(Number\(x\.id\)\)/);
  assert.match(miniApp, /Number\(x\.id\)>0/);
});
