'use strict';

const crypto = require('node:crypto');

function createStoreEntrySignature({ storeId, chatId, secret }) {
  const id = Number(storeId);
  const group = typeof chatId === 'string' ? chatId.trim() : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !group || typeof secret !== 'string' || secret.length < 32 || secret.length > 256) {
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

module.exports = { createStoreEntrySignature, verifyStoreEntrySignature };
