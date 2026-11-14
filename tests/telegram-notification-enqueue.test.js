'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enqueueSystemAdminTelegramNotification,
  enqueueCustomerTelegramNotification,
  enqueueStoreAdminTelegramNotification
} = require('../server/services/telegram-notification-enqueue');

test('system admin Telegram notification enqueue is a no-op while the Bot is disabled', async () => {
  let enqueues = 0;
  const result = await enqueueSystemAdminTelegramNotification({
    getAsync: async () => ({ value: '0' }),
    enqueue: async () => { enqueues++; },
    eventKey: 'order:1:created',
    event: { type: 'order.created', storeName: 'A', orderNo: '1', amount: 1 }
  });
  assert.equal(result, false);
  assert.equal(enqueues, 0);
});

test('system admin Telegram notification enqueue locks Bot settings before writing', async () => {
  let received;
  const result = await enqueueSystemAdminTelegramNotification({
    getAsync: async (sql, params) => {
      assert.match(sql, /SELECT value FROM settings[\s\S]*FOR UPDATE/);
      assert.deepEqual(params, ['telegram_admin_bot_enabled']);
      return { value: '1' };
    },
    enqueue: async input => { received = input; },
    eventKey: 'order:1:created',
    event: { type: 'order.created', storeName: 'A', orderNo: '1', amount: 1 }
  });
  assert.equal(result, true);
  assert.deepEqual(received, {
    eventKey: 'order:1:created',
    recipientScope: 'system_admin',
    recipientKey: 'admin:primary',
    event: { type: 'order.created', storeName: 'A', orderNo: '1', amount: 1 }
  });
});

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
      if (sql.includes('FROM stores')) {
        assert.match(sql, /FOR UPDATE/);
        assert.deepEqual(params, [9, 7]);
        return [{ id: 9 }];
      }
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
