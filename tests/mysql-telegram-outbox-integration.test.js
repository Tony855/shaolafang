'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const databaseUrl = process.env.MYSQL_INTEGRATION_URL;
if (databaseUrl) {
  const integrationUrl = new URL(databaseUrl);
  process.env.DB_HOST = integrationUrl.hostname;
  process.env.DB_PORT = integrationUrl.port || '3306';
  process.env.DB_USER = decodeURIComponent(integrationUrl.username);
  process.env.DB_PASSWORD = decodeURIComponent(integrationUrl.password);
  process.env.DB_DATABASE = decodeURIComponent(integrationUrl.pathname.slice(1));
} else if (!process.env.DB_DATABASE) {
  process.env.DB_DATABASE = 'telegram_outbox_test';
}
const poolModule = require('../server/db/pool');
const { runAsync, getAsync, withTransaction } = require('../server/db/helpers');
const { ensureTelegramNotificationOutboxSchema } = require('../server/db/migrations/telegram-notification-outbox');
const { enqueueTelegramNotification, claimTelegramNotifications, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry } = require('../server/services/telegram-notification-outbox');
const { processTelegramNotificationBatch } = require('../server/services/telegram-notification-worker');

test('MySQL integration: Telegram outbox migration, rollback, idempotency, leases and delivery', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const testPool = mysql.createPool(databaseUrl);
  const previousPool = poolModule.pool;
  poolModule.setPool(testPool);
  t.after(async () => {
    try { await runAsync('DROP TABLE IF EXISTS telegram_notification_outbox'); }
    finally { poolModule.setPool(previousPool); await testPool.end(); }
  });

  await runAsync('DROP TABLE IF EXISTS telegram_notification_outbox');
  await ensureTelegramNotificationOutboxSchema({ runAsync });
  await ensureTelegramNotificationOutboxSchema({ runAsync });

  const key = `telegram-it:${crypto.randomUUID()}`;
  const input = {
    eventKey: key, recipientScope: 'system_admin', recipientKey: 'admin:primary',
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-42', amount: 12.5, currency: 'USD', customerToken: 'must-not-persist' }
  };

  await assert.rejects(withTransaction(async () => {
    await enqueueTelegramNotification({ ...input, eventKey: `${key}:rollback` });
    throw new Error('rollback test');
  }), /rollback test/);
  assert.equal(await getAsync('SELECT id FROM telegram_notification_outbox WHERE event_key=?', [`${key}:rollback`]), null);

  const first = await enqueueTelegramNotification(input);
  const duplicate = await enqueueTelegramNotification(input);
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.id, first.id);
  const stored = await getAsync('SELECT payload_json,state,attempts FROM telegram_notification_outbox WHERE id=?', [first.id]);
  assert.equal(String(stored.payload_json).includes('must-not-persist'), false);

  const workerA = crypto.randomUUID();
  const workerB = crypto.randomUUID();
  const claimedA = await claimTelegramNotifications({ workerId: workerA, limit: 1, leaseSeconds: 30 });
  assert.equal(claimedA.length, 1);
  assert.equal(claimedA[0].id, first.id);
  assert.equal((await claimTelegramNotifications({ workerId: workerB, limit: 1, leaseSeconds: 30 })).length, 0);
  assert.equal(await markTelegramNotificationDelivered(first.id, workerB), false);
  assert.equal(await markTelegramNotificationDelivered(first.id, workerA), true);
  assert.equal(await markTelegramNotificationDelivered(first.id, workerA), false);

  const leaseKey = `${key}:lease-recovery`;
  await enqueueTelegramNotification({ ...input, eventKey: leaseKey });
  const leaseA = await claimTelegramNotifications({ workerId: workerA, limit: 1, leaseSeconds: 30 });
  assert.equal(leaseA.length, 1);
  await runAsync('UPDATE telegram_notification_outbox SET locked_until=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=?', [leaseA[0].id]);
  assert.equal(await markTelegramNotificationDelivered(leaseA[0].id, workerA), false);
  const leaseB = await claimTelegramNotifications({ workerId: workerB, limit: 1, leaseSeconds: 30 });
  assert.equal(leaseB.length, 1);
  assert.equal(leaseB[0].id, leaseA[0].id);
  assert.equal(await markTelegramNotificationDelivered(leaseA[0].id, workerA), false);
  assert.equal(await markTelegramNotificationDelivered(leaseB[0].id, workerB), true);

  const retryKey = `${key}:retry`;
  await enqueueTelegramNotification({ ...input, eventKey: retryKey });
  const retryClaim = await claimTelegramNotifications({ workerId: workerA, limit: 1, leaseSeconds: 30 });
  assert.equal(retryClaim.length, 1);
  assert.equal(await releaseTelegramNotificationForRetry(retryClaim[0].id, workerA, 'telegram_429', retryClaim[0].attempts), true);
  const retryRow = await getAsync('SELECT state,attempts,last_error_code FROM telegram_notification_outbox WHERE id=?', [retryClaim[0].id]);
  assert.equal(retryRow.state, 'pending');
  assert.equal(Number(retryRow.attempts), 1);
  assert.equal(retryRow.last_error_code, 'telegram_429');

  const workerKey = `${key}:worker`;
  await enqueueTelegramNotification({ ...input, eventKey: workerKey });
  const result = await processTelegramNotificationBatch({
    workerId: workerB, limit: 1,
    resolveRecipient: async () => ({ scope: 'system_admin', merchantId: null, storeId: null, token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '-100123' }),
    sendMessage: async ({ text }) => { assert.match(text, /IT-42/); }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].state, 'delivered');
});
