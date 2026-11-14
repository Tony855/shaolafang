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
  const bindingOne = await getAsync('SELECT id FROM telegram_customer_bindings WHERE customer_token_hash=? AND store_id=?', [customerHash, 9]);
  const stopNoticeKey = `telegram-it:stop:${crypto.randomUUID()}`;
  await enqueueTelegramNotification({
    eventKey: stopNoticeKey, recipientScope: 'customer', recipientKey: `binding:${bindingOne.id}`,
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-STOP', amount: 1, currency: 'USD' }
  });
  await runAsync(
    "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='binding_revoked', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='customer' AND state IN ('pending','processing') AND recipient_key IN (SELECT CONCAT('binding:', id) FROM telegram_customer_bindings WHERE telegram_chat_id=? AND telegram_user_id=? AND is_active=1)",
    ['54321', '12345']
  );
  const stopNotice = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [stopNoticeKey]);
  assert.equal(stopNotice.state, 'dead');
  assert.equal(stopNotice.last_error_code, 'binding_revoked');

  const customerHashTwo = crypto.createHash('sha256').update('customer-token-two').digest('hex');
  await runAsync('INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [customerHashTwo, 7, 9, '22222', '54322']);
  const bindingTwo = await getAsync('SELECT id FROM telegram_customer_bindings WHERE customer_token_hash=? AND store_id=?', [customerHashTwo, 9]);
  const pageRevokeKey = `telegram-it:page-revoke:${crypto.randomUUID()}`;
  await enqueueTelegramNotification({
    eventKey: pageRevokeKey, recipientScope: 'customer', recipientKey: `binding:${bindingTwo.id}`,
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-REVOKE', amount: 1, currency: 'USD' }
  });
  await runAsync(
    "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='binding_revoked', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='customer' AND state IN ('pending','processing') AND recipient_key IN (SELECT CONCAT('binding:', id) FROM telegram_customer_bindings WHERE customer_token_hash=? AND merchant_id=? AND store_id=? AND is_active=1)",
    [customerHashTwo, 7, 9]
  );
  const pageRevokeNotice = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [pageRevokeKey]);
  assert.equal(pageRevokeNotice.state, 'dead');
  assert.equal(pageRevokeNotice.last_error_code, 'binding_revoked');

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

  // Exercise two independent worker transactions concurrently: SKIP LOCKED
  // must allocate distinct ready rows rather than double-claiming one event.
  const concurrentKeys = [`${key}:concurrent-a`, `${key}:concurrent-b`];
  for (const eventKey of concurrentKeys) await enqueueTelegramNotification({ ...input, eventKey });
  const [concurrentA, concurrentB] = await Promise.all([
    claimTelegramNotifications({ workerId: workerA, limit: 1, leaseSeconds: 30 }),
    claimTelegramNotifications({ workerId: workerB, limit: 1, leaseSeconds: 30 })
  ]);
  assert.equal(concurrentA.length, 1);
  assert.equal(concurrentB.length, 1);
  assert.notEqual(Number(concurrentA[0].id), Number(concurrentB[0].id));

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

  const floodKey = `${key}:flood-control`;
  await enqueueTelegramNotification({ ...input, eventKey: floodKey });
  const floodResult = await processTelegramNotificationBatch({
    workerId: workerB, limit: 1,
    resolveRecipient: async () => ({ scope: 'system_admin', merchantId: null, storeId: null, token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '-100123' }),
    sendMessage: async () => { throw Object.assign(new Error('Telegram 消息发送失败（HTTP 429）'), { retryAfterSeconds: 120 }); }
  });
  assert.equal(floodResult[0].state, 'retry');
  const floodRow = await getAsync('SELECT state,last_error_code,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),available_at) AS wait_seconds FROM telegram_notification_outbox WHERE event_key=?', [floodKey]);
  assert.equal(floodRow.state, 'pending');
  assert.equal(floodRow.last_error_code, 'telegram_429');
  assert.ok(Number(floodRow.wait_seconds) >= 119, 'Telegram retry_after must be respected');

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

  const disabledAdminKey = `${key}:admin-bot-disabled`;
  await enqueueTelegramNotification({
    eventKey: disabledAdminKey, recipientScope: 'system_admin', recipientKey: 'admin:primary',
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-43A', amount: 12.5, currency: 'USD' }
  });
  const disabledAdminResult = await processTelegramNotificationBatch({
    workerId: workerB, limit: 1,
    resolveRecipient: async () => ({ scope: 'system_admin', merchantId: null, storeId: null, suppressed: true }),
    sendMessage: async () => { throw new Error('disabled admin Bot must not send queued notices'); }
  });
  assert.equal(disabledAdminResult[0].state, 'suppressed');
  const disabledAdminRow = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [disabledAdminKey]);
  assert.equal(disabledAdminRow.state, 'dead');
  assert.equal(disabledAdminRow.last_error_code, 'event_disabled');

  // Disabling the Client Bot must permanently clear only customer backlog,
  // even when the worker is stopped and no recipient-resolution pass runs.
  const disableClientCustomerKey = `${key}:disable-client:customer`;
  const disableClientAdminKey = `${key}:disable-client:admin`;
  await enqueueTelegramNotification({
    eventKey: disableClientCustomerKey, recipientScope: 'customer', recipientKey: 'binding:disable-client',
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-43B', amount: 12.5, currency: 'USD' }
  });
  await enqueueTelegramNotification({
    eventKey: disableClientAdminKey, recipientScope: 'system_admin', recipientKey: 'admin:primary',
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-43C', amount: 12.5, currency: 'USD' }
  });
  await runAsync("UPDATE telegram_notification_outbox SET state='processing', locked_by=?, locked_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE event_key=?", [workerA, disableClientCustomerKey]);
  await runAsync(
    "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='event_disabled', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='customer' AND state IN ('pending','processing')"
  );
  const disabledCustomerBacklog = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [disableClientCustomerKey]);
  const retainedAdminBacklog = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [disableClientAdminKey]);
  assert.equal(disabledCustomerBacklog.state, 'dead');
  assert.equal(disabledCustomerBacklog.last_error_code, 'event_disabled');
  assert.equal(retainedAdminBacklog.state, 'pending');

  // Disabling the Admin Bot clears both global and store-admin queues, but not
  // customer jobs that belong to the separately configured Client Bot.
  const disableAdminGlobalKey = `${key}:disable-admin:global`;
  const disableAdminStoreKey = `${key}:disable-admin:store`;
  const retainedCustomerKey = `${key}:disable-admin:customer`;
  await enqueueTelegramNotification({
    eventKey: disableAdminGlobalKey, recipientScope: 'system_admin', recipientKey: 'admin:primary',
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-43D', amount: 12.5, currency: 'USD' }
  });
  await enqueueTelegramNotification({
    eventKey: disableAdminStoreKey, recipientScope: 'merchant_store', recipientKey: 'store:9',
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-43E', amount: 12.5, currency: 'USD' }
  });
  await enqueueTelegramNotification({
    eventKey: retainedCustomerKey, recipientScope: 'customer', recipientKey: 'binding:other',
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-43F', amount: 12.5, currency: 'USD' }
  });
  await runAsync("UPDATE telegram_notification_outbox SET state='processing', locked_by=?, locked_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE event_key=?", [workerB, disableAdminStoreKey]);
  await runAsync(
    "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='event_disabled', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope IN ('system_admin','merchant_store') AND state IN ('pending','processing')"
  );
  const disabledGlobalBacklog = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [disableAdminGlobalKey]);
  const disabledStoreBacklog = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [disableAdminStoreKey]);
  const retainedCustomerBacklog = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [retainedCustomerKey]);
  assert.equal(disabledGlobalBacklog.state, 'dead');
  assert.equal(disabledGlobalBacklog.last_error_code, 'event_disabled');
  assert.equal(disabledStoreBacklog.state, 'dead');
  assert.equal(disabledStoreBacklog.last_error_code, 'event_disabled');
  assert.equal(retainedCustomerBacklog.state, 'pending');
  // Remove deliberately retained rows so the following limit=1 worker claim
  // exercises the revoked-binding job rather than an earlier test fixture.
  await runAsync('DELETE FROM telegram_notification_outbox WHERE event_key IN (?, ?, ?)', [
    disableClientAdminKey, retainedCustomerKey, `${key}:disable-client:admin`
  ]);

  const revokedCustomerKey = `${key}:binding-revoked`;
  await enqueueTelegramNotification({
    eventKey: revokedCustomerKey, recipientScope: 'customer', recipientKey: 'binding:42',
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-44', amount: 12.5, currency: 'USD' }
  });
  const revokedResult = await processTelegramNotificationBatch({
    workerId: workerB, limit: 1,
    resolveRecipient: async () => ({
      scope: 'customer', merchantId: 7, storeId: 9,
      suppressed: true, suppressionCode: 'binding_revoked'
    }),
    sendMessage: async () => { throw new Error('revoked customer binding must not be sent'); }
  });
  assert.equal(revokedResult[0].state, 'suppressed');
  const revokedRow = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [revokedCustomerKey]);
  assert.equal(revokedRow.state, 'dead');
  assert.equal(revokedRow.last_error_code, 'binding_revoked');

  const oldDeliveredKey = `${key}:old-delivered`;
  const oldDeadKey = `${key}:old-dead`;
  const exhaustedLeaseKey = `${key}:exhausted-lease`;
  const oldPayload = JSON.stringify({ text: 'old notification' });
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,locked_by,locked_until,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'processing',8,UTC_TIMESTAMP(3),?,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [exhaustedLeaseKey, oldPayload, crypto.randomUUID()]);
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,delivered_at,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'delivered',1,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY))", [oldDeliveredKey, oldPayload]);
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'dead',8,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY))", [oldDeadKey, oldPayload]);
  const cleanup = await cleanupTelegramNotificationHistory();
  assert.equal(cleanup.exhaustedDead, 1);
  assert.equal(cleanup.deliveredDeleted, 1);
  assert.equal(cleanup.deadDeleted, 1);
  assert.equal((await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [exhaustedLeaseKey])).state, 'dead');
  assert.equal((await allAsync('SELECT id FROM telegram_notification_outbox WHERE event_key IN (?, ?)', [oldDeliveredKey, oldDeadKey])).length, 0);

  // Exercise the exact tenant-cleanup SQL used by merchant deletion/reset.
  // Temporary source tables keep this test isolated from any other integration
  // schema while the outbox tables remain the real migrated InnoDB tables.
  await withTransaction(async () => {
    await runAsync('CREATE TEMPORARY TABLE stores (id BIGINT UNSIGNED PRIMARY KEY, merchant_id BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB');
    await runAsync('CREATE TEMPORARY TABLE orders (id BIGINT UNSIGNED PRIMARY KEY, store_id BIGINT UNSIGNED NOT NULL, merchant_id BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB');
    const sourceOrderA = 800000000 + crypto.randomInt(10000000);
    const sourceOrderB = sourceOrderA + 1;
    const sourceOrderC = sourceOrderA + 2;
    await runAsync('INSERT INTO stores (id, merchant_id) VALUES (9001, 7), (9002, 8)');
    await runAsync('INSERT INTO orders (id, store_id, merchant_id) VALUES (?, 9001, 7), (?, 9002, 8), (?, 9002, 8)', [sourceOrderA, sourceOrderB, sourceOrderC]);
    const payload = JSON.stringify({ text: 'cleanup integration fixture' });
    const addOutbox = async (eventKey, merchantId, storeId, scope, recipientKey) => runAsync(
      "INSERT INTO telegram_notification_outbox (event_key,event_type,merchant_id,store_id,recipient_scope,recipient_key,payload_json,state,attempts,available_at,created_at,updated_at) VALUES (?, 'order.created', ?, ?, ?, ?, ?, 'pending', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [eventKey, merchantId, storeId, scope, recipientKey, payload]
    );
    await addOutbox(`order:${sourceOrderA}:created`, null, null, 'system_admin', 'admin:primary');
    await addOutbox(`order:${sourceOrderA}:created:store`, 7, 9001, 'merchant_store', 'store:9001');
    await addOutbox(`order:${sourceOrderA}:created:customer`, 7, 9001, 'customer', 'binding:9001');
    await addOutbox(`order:${sourceOrderB}:created`, null, null, 'system_admin', 'admin:primary');
    await addOutbox(`order:${sourceOrderB}:created:store`, 8, 9002, 'merchant_store', 'store:9002');
    await addOutbox(`order:${sourceOrderC}:created`, null, null, 'system_admin', 'admin:primary');

    await runAsync(
      "DELETE n FROM telegram_notification_outbox n INNER JOIN orders o ON n.event_key LIKE CONCAT('order:', o.id, ':%') WHERE o.merchant_id=?",
      [7]
    );
    await runAsync(
      'DELETE FROM telegram_notification_outbox WHERE merchant_id=? OR store_id IN (SELECT id FROM stores WHERE merchant_id=?)',
      [7, 7]
    );
    const remaining = await allAsync('SELECT event_key FROM telegram_notification_outbox WHERE event_key LIKE ?', [`order:${sourceOrderA}:%`]);
    assert.equal(remaining.length, 0, 'merchant system-admin and tenant-scoped events must all be removed');
    assert.equal((await getAsync('SELECT id FROM telegram_notification_outbox WHERE event_key=?', [`order:${sourceOrderB}:created`])) !== null, true, 'other merchant system-admin event must remain');

    await runAsync(
      'INSERT INTO telegram_customer_binding_challenges (challenge_hash,customer_token_hash,merchant_id,store_id,expires_at,created_at) VALUES (?, ?, 7, 9001, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE), UTC_TIMESTAMP(3)), (?, ?, 8, 9002, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE), UTC_TIMESTAMP(3))',
      [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')]
    );
    await runAsync(
      'INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?, 7, 9001, 7001, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)), (?, 8, 9002, 8001, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
      [crypto.randomBytes(32).toString('hex'), '-1009001', crypto.randomBytes(32).toString('hex'), '-1009002']
    );
    await runAsync(
      'INSERT INTO telegram_store_admin_recipients (merchant_id,store_id,chat_id,is_enabled,created_at,updated_at) VALUES (7,9001,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)), (8,9002,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
      ['-1009001', '-1009002']
    );
    await runAsync('DELETE FROM telegram_customer_binding_challenges WHERE merchant_id=? OR store_id IN (SELECT id FROM stores WHERE merchant_id=?)', [7, 7]);
    await runAsync('DELETE FROM telegram_customer_bindings WHERE merchant_id=? OR store_id IN (SELECT id FROM stores WHERE merchant_id=?)', [7, 7]);
    await runAsync('DELETE FROM telegram_store_admin_recipients WHERE merchant_id=? OR store_id IN (SELECT id FROM stores WHERE merchant_id=?)', [7, 7]);
    assert.equal(Number((await getAsync('SELECT COUNT(*) AS count FROM telegram_customer_binding_challenges WHERE store_id IN (9001,9002)')).count), 1);
    assert.equal(Number((await getAsync('SELECT COUNT(*) AS count FROM telegram_customer_bindings WHERE store_id IN (9001,9002)')).count), 1);
    assert.equal(Number((await getAsync('SELECT COUNT(*) AS count FROM telegram_store_admin_recipients WHERE store_id IN (9001,9002)')).count), 1);

    await runAsync('DELETE FROM telegram_notification_outbox WHERE event_key LIKE CONCAT(\'order:\', ?, \':%\')', [sourceOrderC]);
    assert.equal(await getAsync('SELECT id FROM telegram_notification_outbox WHERE event_key=?', [`order:${sourceOrderC}:created`]), null);
    await runAsync('DELETE FROM telegram_notification_outbox');
    await runAsync('DELETE FROM telegram_customer_binding_challenges');
    await runAsync('DELETE FROM telegram_customer_bindings');
    await runAsync('DROP TEMPORARY TABLE orders');
    await runAsync('DROP TEMPORARY TABLE stores');
  });

});
