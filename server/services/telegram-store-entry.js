'use strict';

const crypto = require('node:crypto');

function safeId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function safeSecret(secret) {
  return typeof secret === 'string' && secret.length >= 32 && secret.length <= 256;
}

function createStoreEntrySignature({ storeId, chatId, secret }) {
  const id = safeId(storeId);
  const group = typeof chatId === 'string' ? chatId.trim() : '';
  if (!id || !group || !safeSecret(secret)) {
    throw new TypeError('A valid store, Chat ID, and webhook secret are required');
  }
  return crypto.createHmac('sha256', secret)
    .update('foodflow:telegram-store-entry:v1:' + id + ':' + group)
    .digest('base64url');
}

function verifyStoreEntrySignature({ storeId, chatId, secret, signature }) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  let expected;
  try { expected = createStoreEntrySignature({ storeId, chatId, secret }); } catch (_) { return false; }
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function createTenantStoreEntrySignature({ merchantId, storeId, secret }) {
  const tenant = safeId(merchantId);
  const store = safeId(storeId);
  if (!tenant || !store || !safeSecret(secret)) {
    throw new TypeError('A valid merchant, store, and webhook secret are required');
  }
  return crypto.createHmac('sha256', secret)
    .update('foodflow:telegram-tenant-store-entry:v1:' + tenant + ':' + store)
    .digest('base64url');
}

function verifyTenantStoreEntrySignature({ merchantId, storeId, secret, signature }) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  let expected;
  try { expected = createTenantStoreEntrySignature({ merchantId, storeId, secret }); } catch (_) { return false; }
  const actualBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = {
  createStoreEntrySignature,
  verifyStoreEntrySignature,
  createTenantStoreEntrySignature,
  verifyTenantStoreEntrySignature
};
