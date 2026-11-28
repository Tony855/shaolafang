'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enqueueCustomerTelegramNotification,
  enqueueStoreAdminTelegramNotification
} = require('../server/services/telegram-notification-enqueue');

test('customer Telegram enqueue locks settings, tenant, and exact binding before writing', async () => {
  let received;
  const customerTokenHash = 'a'.repeat(64);
  const result = await enqueueCustomerTelegramNotification({
    allAsync: async (sql, params) => {
      if (sql.includes('settings')) {
        assert.match(sql, /ORDER BY `key` FOR UPDATE/);
        assert.deepEqual(params, ['telegram_admin_bot_enabled', 'telegram_client_bot_enabled']);
        return [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_client_bot_enabled', value: '1' }];
      }
      if (sql.includes('FROM merchants')) {
        assert.match(sql, /FOR UPDATE/);
        assert.deepEqual(params, [7]);
        return [{ id: 7 }];
      }
      if (sql.includes('FROM telegram_merchant_bots')) return [];
      if (sql.includes('FROM stores')) {
        assert.match(sql, /FOR UPDATE/);
        assert.deepEqual(params, [9, 7]);
        return [{ id: 9 }];
      }
      assert.match(sql, /FROM telegram_customer_bindings[\s\S]*FOR UPDATE/);
      assert.deepEqual(params, [customerTokenHash, 7, 9]);
      return [{ id: 42 }];
    },
    enqueue: async input => { received = input; },
    customerTokenHash, merchantId: 7, storeId: 9,
    eventKey: 'order:1:created',
    event: { type: 'order.created', storeName: 'Store A', orderNo: '1', amount: 5, currency: 'USD' }
  });
  assert.equal(result, true);
  assert.equal(received.recipientScope, 'customer');
  assert.equal(received.recipientKey, 'binding:42');
  assert.equal(received.merchantId, 7);
  assert.equal(received.storeId, 9);
});

test('customer Telegram enqueue fails closed without enabled Bot or matching binding', async () => {
  const customerTokenHash = 'b'.repeat(64);
  const disabled = await enqueueCustomerTelegramNotification({
    allAsync: async () => [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_client_bot_enabled', value: '0' }],
    customerTokenHash, merchantId: 7, storeId: 9, eventKey: 'x', event: {}
  });
  const noBinding = await enqueueCustomerTelegramNotification({
    allAsync: async sql => {
      if (sql.includes('settings')) return [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_client_bot_enabled', value: '1' }];
      if (sql.includes('FROM merchants')) return [{ id: 7 }];
      if (sql.includes('FROM telegram_merchant_bots')) return [];
      if (sql.includes('FROM stores')) return [{ id: 9 }];
      return [];
    },
    customerTokenHash, merchantId: 7, storeId: 9, eventKey: 'x', event: {}
  });
  assert.equal(disabled, false);
  assert.equal(noBinding, false);
});

test('store admin enqueue locks Bot, tenant, and recipient rows before writing', async () => {
  let received;
  const result = await enqueueStoreAdminTelegramNotification({
    allAsync: async (sql, params) => {
      if (sql.includes('settings')) {
        assert.match(sql, /ORDER BY `key` FOR UPDATE/);
        assert.deepEqual(params, ['telegram_admin_bot_enabled', 'telegram_client_bot_enabled']);
        return [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_client_bot_enabled', value: '1' }];
      }
      if (sql.includes('FROM merchants')) {
        assert.match(sql, /FOR UPDATE/);
        assert.deepEqual(params, [7]);
        return [{ id: 7 }];
      }
      if (sql.includes('FROM telegram_merchant_bots')) return [];
      if (sql.includes('FROM stores')) {
        assert.match(sql, /FOR UPDATE/);
        assert.deepEqual(params, [9, 7]);
        return [{ id: 9 }];
      }
      assert.match(sql, /chat_id<>''/);
      assert.match(sql, /notify_order_created=1/);
      assert.match(sql, /FOR UPDATE/);
      assert.deepEqual(params, [7, 9]);
      return [{ id: 2 }];
    },
    enqueue: async input => { received = input; },
    merchantId: 7, storeId: 9, eventKey: 'order:1:created:store',
    event: { type: 'order.created', storeName: 'A', orderNo: '1', amount: 3, currency: 'USD' }
  });
  assert.equal(result, true);
  assert.equal(received.recipientScope, 'merchant_store');
  assert.equal(received.recipientKey, 'store:9');
  assert.equal(received.merchantId, 7);
  assert.equal(received.storeId, 9);
});

test('store admin enqueue fails closed when recipient or event toggle is disabled', async () => {
  const noRecipient = await enqueueStoreAdminTelegramNotification({
    allAsync: async sql => {
      if (sql.includes('settings')) return [{ key: 'telegram_admin_bot_enabled', value: '1' }, { key: 'telegram_client_bot_enabled', value: '1' }];
      if (sql.includes('FROM merchants')) return [{ id: 7 }];
      if (sql.includes('FROM stores')) return [{ id: 9 }];
      return [];
    },
    merchantId: 7, storeId: 9, eventKey: 'x', event: { type: 'order.created' }
  });
  const unknownEvent = await enqueueStoreAdminTelegramNotification({
    allAsync: async () => [{ value: '1' }],
    merchantId: 7, storeId: 9, eventKey: 'x', event: { type: 'unknown' }
  });
  assert.equal(noRecipient, false);
  assert.equal(unknownEvent, false);
});

test('tenant Client Bot enablement overrides the platform shared Bot setting', async () => {
  let queued = false;
  const result = await enqueueCustomerTelegramNotification({
    allAsync: async (sql, params) => {
      if (sql.includes('FROM settings')) return [{ key: 'telegram_client_bot_enabled', value: '0' }];
      if (sql.includes('FROM merchants')) return [{ id: 7 }];
      if (sql.includes('FROM telegram_merchant_bots')) return [{ id: 4, client_bot_enabled: 1 }];
      if (sql.includes('FROM stores')) return [{ id: 9 }];
      if (sql.includes('telegram_customer_bindings')) return [{ id: 42, bot_config_id: 4 }];
      return [];
    },
    enqueue: async () => { queued = true; },
    customerTokenHash: 'c'.repeat(64), merchantId: 7, storeId: 9,
    eventKey: 'tenant:order:created',
    event: { type: 'order.created', storeName: 'Store A', orderNo: '1', amount: 1, currency: 'USD' }
  });
  assert.equal(result, true);
  assert.equal(queued, true);
});

test('tenant Admin Bot enablement overrides the platform shared Bot setting for group notices', async () => {
  let queued = false;
  const result = await enqueueStoreAdminTelegramNotification({
    allAsync: async (sql, params) => {
      if (sql.includes('FROM settings')) return [{ key: 'telegram_admin_bot_enabled', value: '0' }];
      if (sql.includes('FROM merchants')) return [{ id: 7 }];
      if (sql.includes('FROM telegram_merchant_bots')) return [{ admin_bot_enabled: 1 }];
      if (sql.includes('FROM stores')) return [{ id: 9 }];
      if (sql.includes('telegram_store_admin_recipients')) return [{ id: 2 }];
      return [];
    },
    enqueue: async () => { queued = true; },
    merchantId: 7, storeId: 9, eventKey: 'tenant:order:created:admin',
    event: { type: 'order.created', storeName: 'Store A', orderNo: '1', amount: 1, currency: 'USD' }
  });
  assert.equal(result, true);
  assert.equal(queued, true);
});
