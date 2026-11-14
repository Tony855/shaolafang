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
const { runAsync, getAsync, allAsync, withTransaction } = require('../server/db/helpers');
const { ensureTelegramNotificationOutboxSchema } = require('../server/db/migrations/telegram-notification-outbox');
const { ensureTelegramCustomerBindingSchema } = require('../server/db/migrations/telegram-customer-binding');
const { ensureTelegramStoreAdminRecipientSchema } = require('../server/db/migrations/telegram-store-admin-recipients');
const { enqueueTelegramNotification, claimTelegramNotifications, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry, cleanupTelegramNotificationHistory } = require('../server/services/telegram-notification-outbox');
const { processTelegramNotificationBatch } = require('../server/services/telegram-notification-worker');

test('MySQL integration: Telegram outbox migration, rollback, idempotency, leases and delivery', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const testPool = mysql.createPool(databaseUrl);
  const previousPool = poolModule.pool;
  poolModule.setPool(testPool);
  t.after(async () => {
    try {
      await runAsync('DROP TABLE IF EXISTS telegram_store_admin_recipients');
  await runAsync('DROP TABLE IF EXISTS telegram_webhook_updates');
      await runAsync('DROP TABLE IF EXISTS telegram_customer_bindings');
      await runAsync('DROP TABLE IF EXISTS telegram_customer_binding_challenges');
      await runAsync('DROP TABLE IF EXISTS telegram_notification_outbox');
    } finally { poolModule.setPool(previousPool); await testPool.end(); }
  });

  await runAsync('DROP TABLE IF EXISTS telegram_store_admin_recipients');
  await runAsync('DROP TABLE IF EXISTS telegram_webhook_updates');
  await runAsync('DROP TABLE IF EXISTS telegram_customer_bindings');
  await runAsync('DROP TABLE IF EXISTS telegram_customer_binding_challenges');
  await runAsync('DROP TABLE IF EXISTS telegram_notification_outbox');
  await ensureTelegramNotificationOutboxSchema({ runAsync });
  await ensureTelegramNotificationOutboxSchema({ runAsync });
  await ensureTelegramCustomerBindingSchema({ runAsync });
  await ensureTelegramCustomerBindingSchema({ runAsync });
  await ensureTelegramStoreAdminRecipientSchema({ runAsync });
  await ensureTelegramStoreAdminRecipientSchema({ runAsync });

  await runAsync('INSERT INTO telegram_store_admin_recipients (merchant_id,store_id,chat_id,is_enabled,notify_order_created,notify_settled,notify_refunded,created_at,updated_at) VALUES (7,9,\'-100123\',1,1,0,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))');
  await runAsync('INSERT INTO telegram_store_admin_recipients (merchant_id,store_id,chat_id,is_enabled,created_at,updated_at) VALUES (7,10,\'-100456\',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))');
  assert.equal((await allAsync('SELECT id FROM telegram_store_admin_recipients WHERE merchant_id=? ORDER BY store_id', [7])).length, 2);
  await assert.rejects(runAsync('INSERT INTO telegram_store_admin_recipients (merchant_id,store_id,chat_id,created_at,updated_at) VALUES (7,9,\'-100999\',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))'), error => error && error.code === 'ER_DUP_ENTRY');

  const customerHash = crypto.createHash('sha256').update('customer-token').digest('hex');
  const challengeHash = crypto.createHash('sha256').update('challenge').digest('hex');
  await runAsync('INSERT INTO telegram_customer_binding_challenges (challenge_hash,customer_token_hash,merchant_id,store_id,expires_at,created_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE),UTC_TIMESTAMP(3))', [challengeHash, customerHash, 7, 9]);
  const challenge = await getAsync('SELECT customer_token_hash,merchant_id,store_id,consumed_at FROM telegram_customer_binding_challenges WHERE challenge_hash=?', [challengeHash]);
  assert.equal(challenge.customer_token_hash, customerHash);
  assert.equal(Number(challenge.merchant_id), 7);
  assert.equal(Number(challenge.store_id), 9);
  assert.equal(challenge.consumed_at, null);
  await runAsync('INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [customerHash, 7, 9, '12345', '54321']);
  await assert.rejects(runAsync('INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [crypto.createHash('sha256').update('other-customer').digest('hex'), 7, 9, '67890', '54321']), error => error && error.code === 'ER_DUP_ENTRY');
  await assert.rejects(runAsync('INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [customerHash, 7, 9, '67891', '54322']), error => error && error.code === 'ER_DUP_ENTRY');
  await runAsync('INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [crypto.createHash('sha256').update('other-store-customer').digest('hex'), 8, 10, '67890', '54321']);
  await runAsync('INSERT INTO telegram_webhook_updates (update_id,received_at) VALUES (?,UTC_TIMESTAMP(3))', [123456]);
  await assert.rejects(runAsync('INSERT INTO telegram_webhook_updates (update_id,received_at) VALUES (?,UTC_TIMESTAMP(3))', [123456]), error => error && error.code === 'ER_DUP_ENTRY');

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
  assert.equal(first.id > 0, true);
  assert.equal(duplicate.id, first.id);
  assert.equal(Number((await getAsync('SELECT COUNT(*) AS total FROM telegram_notification_outbox WHERE event_key=?', [key])).total), 1);
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


  const suppressedKey = `${key}:event-disabled`;
  await enqueueTelegramNotification({
    eventKey: suppressedKey, recipientScope: 'merchant_store', recipientKey: 'store:9',
    merchantId: 7, storeId: 9,
    event: { type: 'order.settled', storeName: 'Integration Store', orderNo: 'IT-43', amount: 12.5, currency: 'USD' }
  });
  const suppressedResult = await processTelegramNotificationBatch({
    workerId: workerA, limit: 1,
    resolveRecipient: async () => ({ scope: 'merchant_store', merchantId: 7, storeId: 9, suppressed: true }),
    sendMessage: async () => { throw new Error('suppressed event must not be sent'); }
  });
  assert.deepEqual(suppressedResult[0], { id: Number((await getAsync('SELECT id FROM telegram_notification_outbox WHERE event_key=?', [suppressedKey])).id), state: 'suppressed' });
  const suppressedRow = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [suppressedKey]);
  assert.equal(suppressedRow.state, 'dead');
  assert.equal(suppressedRow.last_error_code, 'event_disabled');

  const oldDeliveredKey = `${key}:old-delivered`;
  const oldDeadKey = `${key}:old-dead`;
  const oldPayload = JSON.stringify({ text: 'old notification' });
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,delivered_at,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'delivered',1,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY))", [oldDeliveredKey, oldPayload]);
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'dead',8,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY))", [oldDeadKey, oldPayload]);
  const cleanup = await cleanupTelegramNotificationHistory();
  assert.equal(cleanup.deliveredDeleted, 1);
  assert.equal(cleanup.deadDeleted, 1);
  assert.equal((await allAsync('SELECT id FROM telegram_notification_outbox WHERE event_key IN (?, ?)', [oldDeliveredKey, oldDeadKey])).length, 0);
});
