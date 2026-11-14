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
  assert.deepEqual(await disabled({ scope: 'system_admin', key: 'admin:primary' }), { scope: 'system_admin', merchantId: null, storeId: null, suppressed: true });
  assert.equal(await malformed({ scope: 'system_admin', key: 'admin:primary' }), null);
});

test('system admin recipient resolver refuses customer scope and mismatched tenant metadata', async () => {
  let calls = 0;
  const resolve = createTelegramNotificationRecipientResolver({ allAsync: async () => { calls++; return settings(); } });
  assert.equal(await resolve({ scope: 'customer', key: 'binding:1' }), null);
  assert.equal(await resolve({ scope: 'merchant_store', key: 'store:1', merchantId: 1, storeId: 2 }), null);
  assert.equal(await resolve({ scope: 'system_admin', key: 'admin:primary', merchantId: 1, storeId: null }), null);
  assert.equal(calls, 0);
});

test('merchant store recipient resolver requires exact active tenant, configured global Bot and store chat', async () => {
  const calls = [];
  const resolve = createTelegramNotificationRecipientResolver({ allAsync: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('telegram_store_admin_recipients')) return [{ chat_id: '-1007654321', is_enabled: 1, event_enabled: 1 }];
    return [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_admin_bot_token', value: token }];
  } });
  const recipient = await resolve({ scope: 'merchant_store', key: 'store:9', merchantId: 7, storeId: 9, eventType: 'order.created' });
  assert.deepEqual(recipient, { scope: 'merchant_store', merchantId: 7, storeId: 9, token, chatId: '-1007654321' });
  assert.match(calls[0].sql, /r\.notify_order_created AS event_enabled/);
  assert.deepEqual(calls[0].params, [7, 9]);
  assert.deepEqual(calls[1].params, ['telegram_admin_bot_enabled', 'telegram_admin_bot_token']);
});

test('merchant store recipient resolver fails closed for disabled Bot or missing recipient', async () => {
  const missing = createTelegramNotificationRecipientResolver({ allAsync: async () => [] });
  const disabled = createTelegramNotificationRecipientResolver({ allAsync: async sql => sql.includes('telegram_store_admin_recipients')
    ? [{ chat_id: '-1007654321', is_enabled: 1, event_enabled: 1 }]
    : [{ key: 'telegram_admin_bot_enabled', value: '0' }, { key: 'telegram_admin_bot_token', value: token }] });
  assert.equal(await missing({ scope: 'merchant_store', key: 'store:9', merchantId: 7, storeId: 9, eventType: 'order.created' }), null);
  assert.deepEqual(await disabled({ scope: 'merchant_store', key: 'store:9', merchantId: 7, storeId: 9, eventType: 'order.created' }), { scope: 'merchant_store', merchantId: 7, storeId: 9, suppressed: true });
});


test('merchant store recipient resolver rechecks the queued event toggle at delivery time', async () => {
  let query = '';
  const resolve = createTelegramNotificationRecipientResolver({ allAsync: async sql => {
    if (sql.includes('telegram_store_admin_recipients')) {
      query = sql;
      return [];
    }
    return [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_admin_bot_token', value: token }];
  } });
  const disabled = await resolve({ scope: 'merchant_store', key: 'store:9', merchantId: 7, storeId: 9, eventType: 'order.refunded' });
  assert.equal(disabled, null);
  assert.match(query, /r\.notify_refunded AS event_enabled/);
  assert.equal(await resolve({ scope: 'merchant_store', key: 'store:9', merchantId: 7, storeId: 9, eventType: 'unknown.event' }), null);
});


test('merchant store recipient resolver marks an already queued event as suppressed when its toggle is off', async () => {
  const resolve = createTelegramNotificationRecipientResolver({ allAsync: async sql => {
    if (sql.includes('telegram_store_admin_recipients')) return [{ chat_id: '-1007654321', is_enabled: 1, event_enabled: 0 }];
    return [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_admin_bot_token', value: token }];
  } });
  assert.deepEqual(
    await resolve({ scope: 'merchant_store', key: 'store:9', merchantId: 7, storeId: 9, eventType: 'order.settled' }),
    { scope: 'merchant_store', merchantId: 7, storeId: 9, suppressed: true }
  );
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
  const disabledBot = createTelegramNotificationRecipientResolver({ allAsync: async (sql, params) => sql.includes('telegram_customer_bindings')
    ? (Number(params[1]) === 7 && Number(params[2]) === 9 ? [{ id: 42, merchant_id: 7, store_id: 9, telegram_chat_id: '7654321' }] : [])
    : [{ key: 'telegram_client_bot_enabled', value: '0' }, { key: 'telegram_client_bot_token', value: token }] });
  assert.deepEqual(
    await noBinding({ scope: 'customer', key: 'binding:42', merchantId: 7, storeId: 9 }),
    { scope: 'customer', merchantId: 7, storeId: 9, suppressed: true, suppressionCode: 'binding_revoked' }
  );
  assert.deepEqual(await disabledBot({ scope: 'customer', key: 'binding:42', merchantId: 7, storeId: 9 }), { scope: 'customer', merchantId: 7, storeId: 9, suppressed: true, suppressionCode: 'event_disabled' });
  assert.equal(await disabledBot({ scope: 'customer', key: 'binding:42', merchantId: 8, storeId: 9 }), null);
});
