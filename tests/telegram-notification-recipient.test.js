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
  const resolve = createTelegramNotificationRecipientResolver({ allAsync: async () => settings() });
  const recipient = await resolve({ scope: 'system_admin', key: 'admin:primary', merchantId: null, storeId: null });
  assert.deepEqual(recipient, { scope: 'system_admin', merchantId: null, storeId: null, token, chatId: '-100123' });
});

test('system admin recipient resolver fails closed for disabled or malformed configuration', async () => {
  const disabled = createTelegramNotificationRecipientResolver({ allAsync: async () => settings('0') });
  const malformed = createTelegramNotificationRecipientResolver({ allAsync: async () => settings('1', 'not-a-token') });
  assert.equal(await disabled({ scope: 'system_admin', key: 'admin:primary' }), null);
  assert.equal(await malformed({ scope: 'system_admin', key: 'admin:primary' }), null);
});

test('system admin recipient resolver refuses customer and tenant-scoped destinations', async () => {
  let calls = 0;
  const resolve = createTelegramNotificationRecipientResolver({ allAsync: async () => { calls++; return settings(); } });
  assert.equal(await resolve({ scope: 'customer', key: 'binding:1' }), null);
  assert.equal(await resolve({ scope: 'merchant_store', key: 'store:1', merchantId: 1, storeId: 1 }), null);
  assert.equal(await resolve({ scope: 'system_admin', key: 'admin:primary', merchantId: 1, storeId: null }), null);
  assert.equal(calls, 0);
});


test('customer recipient resolver requires an active binding owned by the queued merchant and store', async () => {
  const calls = [];
  const resolve = createTelegramNotificationRecipientResolver({ allAsync: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('telegram_customer_bindings')) return [{ id: 42, merchant_id: 7, store_id: 9, telegram_chat_id: '7654321' }];
    return [{ key: 'telegram_client_bot_enabled', value: '1' }, { key: 'telegram_client_bot_token', value: token }];
  } });
  const recipient = await resolve({ scope: 'customer', key: 'binding:42', merchantId: 7, storeId: 9 });
  assert.deepEqual(recipient, { scope: 'customer', merchantId: 7, storeId: 9, token, chatId: '7654321' });
  assert.deepEqual(calls[0].params, [42, 7, 9]);
});

test('customer recipient resolver fails closed when binding or client Bot is unavailable', async () => {
  const noBinding = createTelegramNotificationRecipientResolver({ allAsync: async () => [] });
  const disabledBot = createTelegramNotificationRecipientResolver({ allAsync: async sql => sql.includes('telegram_customer_bindings')
    ? [{ id: 42, merchant_id: 7, store_id: 9, telegram_chat_id: '7654321' }]
    : [{ key: 'telegram_client_bot_enabled', value: '0' }, { key: 'telegram_client_bot_token', value: token }] });
  assert.equal(await noBinding({ scope: 'customer', key: 'binding:42', merchantId: 7, storeId: 9 }), null);
  assert.equal(await disabledBot({ scope: 'customer', key: 'binding:42', merchantId: 7, storeId: 9 }), null);
  assert.equal(await disabledBot({ scope: 'customer', key: 'binding:42', merchantId: 8, storeId: 9 }), null);
});
