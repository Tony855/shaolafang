'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramNotificationRecipientResolver } = require('../server/services/telegram-notification-recipient');

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

function settings(enabled = '1', botToken = token, chatId = '-100123') {
  return [
    { key: 'telegram_admin_bot_enabled', value: enabled },
    { key: 'telegram_admin_bot_token', value: botToken },
    { key: 'telegram_admin_chat_id', value: chatId }
  ];
}

test('system admin recipient resolver returns only the explicitly enabled global admin Bot', async () => {
  const resolve = createTelegramNotificationRecipientResolver({ getAsync: async () => settings() });
  const recipient = await resolve({ scope: 'system_admin', key: 'admin:primary', merchantId: null, storeId: null });
  assert.deepEqual(recipient, { scope: 'system_admin', merchantId: null, storeId: null, token, chatId: '-100123' });
});

test('system admin recipient resolver fails closed for disabled or malformed configuration', async () => {
  const disabled = createTelegramNotificationRecipientResolver({ getAsync: async () => settings('0') });
  const malformed = createTelegramNotificationRecipientResolver({ getAsync: async () => settings('1', 'not-a-token') });
  assert.equal(await disabled({ scope: 'system_admin', key: 'admin:primary' }), null);
  assert.equal(await malformed({ scope: 'system_admin', key: 'admin:primary' }), null);
});

test('system admin recipient resolver refuses customer and tenant-scoped destinations', async () => {
  let calls = 0;
  const resolve = createTelegramNotificationRecipientResolver({ getAsync: async () => { calls++; return settings(); } });
  assert.equal(await resolve({ scope: 'customer', key: 'binding:1' }), null);
  assert.equal(await resolve({ scope: 'merchant_store', key: 'store:1', merchantId: 1, storeId: 1 }), null);
  assert.equal(await resolve({ scope: 'system_admin', key: 'admin:primary', merchantId: 1, storeId: null }), null);
  assert.equal(calls, 0);
});
