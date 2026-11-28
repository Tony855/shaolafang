'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStoreEntrySignature, verifyStoreEntrySignature, createTenantStoreEntrySignature, verifyTenantStoreEntrySignature } = require('../server/services/telegram-store-entry');

const secret = 's'.repeat(40);

test('store entry signature is stable for the same store and bound Chat ID', () => {
  const signature = createStoreEntrySignature({ storeId: 42, chatId: '-100123456789', secret });
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyStoreEntrySignature({ storeId: 42, chatId: '-100123456789', secret, signature }), true);
});

test('store entry signature is invalidated when Chat ID or store changes', () => {
  const signature = createStoreEntrySignature({ storeId: 42, chatId: '-100123456789', secret });
  assert.equal(verifyStoreEntrySignature({ storeId: 42, chatId: '-100987654321', secret, signature }), false);
  assert.equal(verifyStoreEntrySignature({ storeId: 43, chatId: '-100123456789', secret, signature }), false);
});

test('store entry signature fails closed for malformed or missing secrets', () => {
  assert.equal(verifyStoreEntrySignature({ storeId: 42, chatId: '-100123456789', secret: '', signature: 'A'.repeat(43) }), false);
  assert.equal(verifyStoreEntrySignature({ storeId: 42, chatId: '-100123456789', secret, signature: 'short' }), false);
});

test('tenant store entry signature binds both merchant and store without a notification group', () => {
  const signature = createTenantStoreEntrySignature({ merchantId: 7, storeId: 42, secret });
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyTenantStoreEntrySignature({ merchantId: 7, storeId: 42, secret, signature }), true);
  assert.equal(verifyTenantStoreEntrySignature({ merchantId: 8, storeId: 42, secret, signature }), false);
  assert.equal(verifyTenantStoreEntrySignature({ merchantId: 7, storeId: 43, secret, signature }), false);
});
