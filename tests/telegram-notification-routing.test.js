'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTelegramGroupSubscriptionsRoutingEnabled,
  buildTelegramDestinationRecipientKey,
  parseTelegramDestinationRecipientKey,
  buildTelegramDestinationEventKey
} = require('../server/services/telegram-notification-routing');
const { enqueueStoreAdminTelegramNotification } = require('../server/services/telegram-notification-enqueue');
const { createTelegramNotificationRecipientResolver } = require('../server/services/telegram-notification-recipient');
const { validateResolvedRecipient } = require('../server/services/telegram-notification-worker-core');

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

test('group subscription routing flag is explicit and disabled by default', () => {
  assert.equal(isTelegramGroupSubscriptionsRoutingEnabled(undefined), false);
  assert.equal(isTelegramGroupSubscriptionsRoutingEnabled('false'), false);
  assert.equal(isTelegramGroupSubscriptionsRoutingEnabled('TRUE'), true);
  assert.equal(isTelegramGroupSubscriptionsRoutingEnabled(' true '), true);
  assert.equal(buildTelegramDestinationRecipientKey(21, 9), 'destination:21:store:9');
  assert.deepEqual(parseTelegramDestinationRecipientKey('destination:21:store:9'), { destinationId: 21, storeId: 9 });
  assert.equal(parseTelegramDestinationRecipientKey('destination:21:store:0'), null);
  assert.equal(parseTelegramDestinationRecipientKey('store:9'), null);
  assert.equal(buildTelegramDestinationEventKey('order:7:created:store', 21), 'order:7:created:store:destination:21');
  assert.throws(() => buildTelegramDestinationRecipientKey(0, 9), /编号无效/);
});

test('staging routing enqueues one idempotent outbox row per active subscribed destination', async () => {
  const calls = [];
  const enqueued = [];
  const result = await enqueueStoreAdminTelegramNotification({
    merchantId: 7,
    storeId: 9,
    eventKey: 'order:7:created:store',
    event: { type: 'order.created', storeName: 'Store A', orderNo: '7', amount: 5, currency: 'USD' },
    routingEnabled: true,
    allAsync: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM settings')) return [
        { key: 'telegram_admin_bot_enabled', value: '1' },
        { key: 'telegram_client_bot_enabled', value: '1' }
      ];
      if (sql.includes('FROM merchants')) return [{ id: 7 }];
      if (sql.includes('FROM telegram_merchant_bots')) return [];
      if (sql.includes('FROM stores')) return [{ id: 9 }];
      if (sql.includes('SELECT destination_id FROM telegram_store_subscriptions')) return [{ destination_id: 21 }, { destination_id: 22 }, { destination_id: 21 }];
      if (sql.includes('FROM telegram_chat_destinations')) return [{ id: 21 }, { id: 22 }];
      if (sql.includes('SELECT id, destination_id FROM telegram_store_subscriptions')) return [{ id: 1, destination_id: 21 }, { id: 2, destination_id: 22 }];
      throw new Error('unexpected query');
    },
    enqueue: async row => { enqueued.push(row); }
  });
  assert.equal(result, true);
  assert.deepEqual(enqueued.map(row => row.recipientKey), ['destination:21:store:9', 'destination:22:store:9']);
  assert.deepEqual(enqueued.map(row => row.eventKey), [
    'order:7:created:store:destination:21',
    'order:7:created:store:destination:22'
  ]);
  assert.ok(calls.some(call => call.sql.includes('ORDER BY id FOR UPDATE')));
  assert.ok(calls.some(call => call.sql.includes('ORDER BY destination_id FOR UPDATE')));
  assert.equal(calls.some(call => call.sql.includes('telegram_store_admin_recipients')), false);
});

test('staging routing never falls back to legacy recipients when no group subscription exists', async () => {
  const calls = [];
  const result = await enqueueStoreAdminTelegramNotification({
    merchantId: 7, storeId: 9, eventKey: 'order:7:created:store',
    event: { type: 'order.created', storeName: 'A', orderNo: '7', amount: 1, currency: 'USD' },
    routingEnabled: true,
    allAsync: async sql => {
      calls.push(sql);
      if (sql.includes('FROM settings')) return [{ key: 'telegram_admin_bot_enabled', value: '1' }];
      if (sql.includes('FROM merchants')) return [{ id: 7 }];
      if (sql.includes('FROM telegram_merchant_bots')) return [];
      if (sql.includes('FROM stores')) return [{ id: 9 }];
      if (sql.includes('telegram_store_subscriptions')) return [];
      throw new Error('unexpected query');
    },
    enqueue: async () => { throw new Error('must not enqueue'); }
  });
  assert.equal(result, false);
  assert.equal(calls.some(sql => sql.includes('telegram_store_admin_recipients')), false);
});

test('new recipient resolver validates destination ownership, store and independent event flags', async () => {
  const calls = [];
  const resolve = createTelegramNotificationRecipientResolver({
    routingEnabled: true,
    allAsync: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('telegram_chat_destinations')) return [{
        chat_id: '-1007654321', destination_enabled: 1, subscription_enabled: 1, event_enabled: 1
      }];
      return [
        { key: 'telegram_admin_bot_enabled', value: '1' },
        { key: 'telegram_admin_bot_token', value: token }
      ];
    }
  });
  const recipient = await resolve({
    scope: 'merchant_store', key: 'destination:21:store:9',
    merchantId: 7, storeId: 9, eventType: 'order.created'
  });
  assert.deepEqual(recipient, {
    scope: 'merchant_store', merchantId: 7, storeId: 9,
    destinationId: 21, token, chatId: '-1007654321'
  });
  assert.deepEqual(calls[0].params, [21, 7, 9]);
  assert.match(calls[0].sql, /sub\.notify_order_created AS event_enabled/);
});

test('resolver suppresses legacy jobs after staging cutover and new jobs when flag is off', async () => {
  let calls = 0;
  const resolveNew = createTelegramNotificationRecipientResolver({
    routingEnabled: true, allAsync: async () => { calls++; return []; }
  });
  const resolveLegacy = createTelegramNotificationRecipientResolver({
    routingEnabled: false, allAsync: async () => { calls++; return []; }
  });
  assert.deepEqual(
    await resolveNew({ scope: 'merchant_store', key: 'store:9', merchantId: 7, storeId: 9, eventType: 'order.created' }),
    { scope: 'merchant_store', merchantId: 7, storeId: 9, suppressed: true }
  );
  assert.deepEqual(
    await resolveLegacy({ scope: 'merchant_store', key: 'destination:21:store:9', merchantId: 7, storeId: 9, eventType: 'order.created' }),
    { scope: 'merchant_store', merchantId: 7, storeId: 9, suppressed: true }
  );
  assert.equal(calls, 0);
});

test('new recipient resolver suppresses disabled destination, subscription or event toggle', async () => {
  const resolve = createTelegramNotificationRecipientResolver({
    routingEnabled: true,
    allAsync: async () => [{ chat_id: '-1007654321', destination_enabled: 1, subscription_enabled: 1, event_enabled: 0 }]
  });
  assert.deepEqual(
    await resolve({ scope: 'merchant_store', key: 'destination:21:store:9', merchantId: 7, storeId: 9, eventType: 'order.refunded' }),
    { scope: 'merchant_store', merchantId: 7, storeId: 9, suppressed: true }
  );
  assert.equal(await resolve({ scope: 'merchant_store', key: 'destination:21:store:10', merchantId: 7, storeId: 9, eventType: 'order.created' }), null);
});

test('customer private-chat resolution is unchanged when group routing is enabled', async () => {
  const resolve = createTelegramNotificationRecipientResolver({
    routingEnabled: true,
    allAsync: async sql => sql.includes('telegram_customer_bindings')
      ? [{ id: 42, merchant_id: 7, store_id: 9, telegram_chat_id: '7654321' }]
      : [{ key: 'telegram_client_bot_enabled', value: '1' }, { key: 'telegram_client_bot_token', value: token }]
  });
  const recipient = await resolve({ scope: 'customer', key: 'binding:42', merchantId: 7, storeId: 9 });
  assert.deepEqual(recipient, { scope: 'customer', merchantId: 7, storeId: 9, token, chatId: '7654321' });
});

test('worker recipient validation binds destination identity to the queued recipient key', () => {
  const job = { recipient_scope: 'merchant_store', recipient_key: 'destination:21:store:9', merchant_id: 7, store_id: 9 };
  const valid = { scope: 'merchant_store', merchantId: 7, storeId: 9, destinationId: 21, token, chatId: '-1007654321' };
  assert.equal(validateResolvedRecipient(job, valid), true);
  assert.equal(validateResolvedRecipient(job, { ...valid, destinationId: 22 }), false);
  assert.equal(validateResolvedRecipient(job, { ...valid, storeId: 10 }), false);
});


test('malformed destination keys are terminally suppressed and never accepted by the worker', async () => {
  let calls = 0;
  const resolve = createTelegramNotificationRecipientResolver({
    routingEnabled: true,
    allAsync: async () => { calls++; return []; }
  });
  const suppressed = await resolve({
    scope: 'merchant_store', key: 'destination:not-an-id', merchantId: 7, storeId: 9, eventType: 'order.created'
  });
  assert.equal(suppressed.suppressed, true);
  assert.equal(calls, 0);
  assert.equal(validateResolvedRecipient(
    { recipient_scope: 'merchant_store', recipient_key: 'destination:not-an-id', merchant_id: 7, store_id: 9 },
    { scope: 'merchant_store', merchantId: 7, storeId: 9, destinationId: 21, token, chatId: '-1007654321' }
  ), false);
});
