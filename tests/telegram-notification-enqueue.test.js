'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueSystemAdminTelegramNotification } = require('../server/services/telegram-notification-enqueue');

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
      assert.match(sql, /telegram_admin_bot_enabled/);
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
