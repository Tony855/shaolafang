'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('invalid order payloads cannot consume a customer QR cooldown', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/orders.js'), 'utf8');
  const validation = source.indexOf('const items = await normalizeOrderItems(rawItems, finalStoreId)');
  const cooldown = source.indexOf('const canSubmit = await checkAndSetCooldown(cooldownKey, cooldownMs)');
  const transaction = source.indexOf('createdOrder = await withTransaction(async () =>');
  assert.notEqual(validation, -1, 'order item validation must exist');
  assert.notEqual(cooldown, -1, 'atomic cooldown acquisition must exist');
  assert.notEqual(transaction, -1, 'order transaction must exist');
  assert.ok(validation < cooldown, 'validate order items before acquiring cooldown');
  assert.ok(cooldown < transaction, 'acquire cooldown before committing the order');
});
