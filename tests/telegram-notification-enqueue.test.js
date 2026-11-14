'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueSystemAdminTelegramNotification, enqueueCustomerTelegramNotification } = require('../server/services/telegram-notification-enqueue');

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

test('system admin Telegram notification enqueue writes an allowlisted recipient inside caller transaction', async () => {
  let received;
  const result = await enqueueSystemAdminTelegramNotification({
    getAsync: async (sql, params) => {
      assert.match(sql, /SELECT value FROM settings/);
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


test('customer Telegram enqueue requires enabled Bot and an active binding owned by the exact store', async () => {
  let received;
  const customerTokenHash = 'a'.repeat(64);
  const result = await enqueueCustomerTelegramNotification({
    allAsync: async (sql, params) => {
      if (sql.includes('settings')) return [{ key: 'telegram_client_bot_enabled', value: '1' }];
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
  const disabled = await enqueueCustomerTelegramNotification({ allAsync: async () => [{ key: 'telegram_client_bot_enabled', value: '0' }], customerTokenHash, merchantId: 7, storeId: 9, eventKey: 'x', event: {} });
  const noBinding = await enqueueCustomerTelegramNotification({ allAsync: async sql => sql.includes('settings') ? [{ value: '1' }] : [], customerTokenHash, merchantId: 7, storeId: 9, eventKey: 'x', event: {} });
  assert.equal(disabled, false);
  assert.equal(noBinding, false);
});
