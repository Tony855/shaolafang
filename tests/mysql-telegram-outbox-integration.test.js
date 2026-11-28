'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const databaseUrl = process.env.MYSQL_INTEGRATION_URL;
const { assertSafeIntegrationDatabaseName } = require('./helpers/mysql-integration-db-guard');
if (databaseUrl) {
  const integrationUrl = new URL(databaseUrl);
  assertSafeIntegrationDatabaseName(decodeURIComponent(integrationUrl.pathname.slice(1)));
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
const { ensureTelegramMerchantBotSchema } = require('../server/db/migrations/telegram-merchant-bots');
const { enqueueTelegramNotification, claimTelegramNotifications, markTelegramNotificationSending, markTelegramNotificationUncertain, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry, cleanupTelegramNotificationHistory } = require('../server/services/telegram-notification-outbox');
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
      await runAsync('DROP TABLE IF EXISTS telegram_merchant_webhook_updates');
      await runAsync('DROP TABLE IF EXISTS telegram_merchant_bot_token_registry');
      await runAsync('DROP TABLE IF EXISTS telegram_merchant_bots');
      await runAsync('DROP TABLE IF EXISTS telegram_webhook_updates');
      await runAsync('DROP TABLE IF EXISTS telegram_customer_bindings');
      await runAsync('DROP TABLE IF EXISTS telegram_customer_binding_challenges');
      await runAsync('DROP TABLE IF EXISTS telegram_notification_outbox');
      await runAsync('DROP TABLE IF EXISTS settings');
      await runAsync('DROP TABLE IF EXISTS stores');
      await runAsync('DROP TABLE IF EXISTS merchants');
    } finally { poolModule.setPool(previousPool); await testPool.end(); }
  });

  await runAsync('DROP TABLE IF EXISTS telegram_store_admin_recipients');
  await runAsync('DROP TABLE IF EXISTS telegram_merchant_webhook_updates');
  await runAsync('DROP TABLE IF EXISTS telegram_merchant_bot_token_registry');
  await runAsync('DROP TABLE IF EXISTS telegram_merchant_bots');
  await runAsync('DROP TABLE IF EXISTS telegram_webhook_updates');
  await runAsync('DROP TABLE IF EXISTS telegram_customer_bindings');
  await runAsync('DROP TABLE IF EXISTS telegram_customer_binding_challenges');
  await runAsync('DROP TABLE IF EXISTS telegram_notification_outbox');
  await runAsync('DROP TABLE IF EXISTS settings');
  await runAsync('DROP TABLE IF EXISTS stores');
  await runAsync('DROP TABLE IF EXISTS merchants');
  await runAsync('CREATE TABLE merchants (id INT NOT NULL PRIMARY KEY, status TINYINT NOT NULL DEFAULT 1) ENGINE=InnoDB');
  await runAsync('CREATE TABLE stores (id INT NOT NULL PRIMARY KEY, merchant_id INT NOT NULL, active TINYINT NOT NULL DEFAULT 1) ENGINE=InnoDB');
  await runAsync('CREATE TABLE settings (`key` VARCHAR(191) NOT NULL PRIMARY KEY, value TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  await runAsync('INSERT INTO merchants (id,status) VALUES (7,1)');
  await runAsync('INSERT INTO stores (id,merchant_id,active) VALUES (9,7,1)');
  await runAsync("INSERT INTO settings (`key`,value) VALUES ('telegram_client_bot_enabled','1')");
  await ensureTelegramNotificationOutboxSchema({ runAsync, getAsync });
  await ensureTelegramNotificationOutboxSchema({ runAsync, getAsync });
  // Simulate the previous global event_key index and verify an in-place upgrade.
  await runAsync('ALTER TABLE telegram_notification_outbox DROP INDEX uq_telegram_outbox_scoped_event');
  await runAsync('ALTER TABLE telegram_notification_outbox ADD UNIQUE KEY uq_telegram_outbox_event (event_key)');
  await ensureTelegramNotificationOutboxSchema({ runAsync, getAsync });
  const scopedDedupeIndex = await getAsync(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?',
    ['telegram_notification_outbox', 'uq_telegram_outbox_scoped_event']
  );
  const legacyDedupeIndex = await getAsync(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?',
    ['telegram_notification_outbox', 'uq_telegram_outbox_event']
  );
  assert.ok(scopedDedupeIndex, 'migration must create the tenant-scoped unique index');
  assert.equal(legacyDedupeIndex, null, 'migration must remove the former global unique index');
  // Upgrade a pre-existing outbox table using the old state enum and no message receipt column.
  await runAsync("ALTER TABLE telegram_notification_outbox MODIFY COLUMN state ENUM('pending','processing','delivered','dead') NOT NULL DEFAULT 'pending'");
  await runAsync('ALTER TABLE telegram_notification_outbox DROP COLUMN telegram_message_id');
  await ensureTelegramNotificationOutboxSchema({ runAsync, getAsync });
  const upgradedMessageIdColumn = await getAsync('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', ['telegram_notification_outbox', 'telegram_message_id']);
  assert.ok(upgradedMessageIdColumn, 'migration must add the Telegram message receipt column');
  await ensureTelegramCustomerBindingSchema({ runAsync });
  await ensureTelegramCustomerBindingSchema({ runAsync });
  await ensureTelegramStoreAdminRecipientSchema({ runAsync });
  await ensureTelegramStoreAdminRecipientSchema({ runAsync });
  await ensureTelegramMerchantBotSchema({ runAsync });

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

  // A worker may have resolved an active recipient before /stop commits.
  // The irreversible sending transition must lock and recheck that binding.
  const sendBoundaryKey = `telegram-it:send-boundary:${crypto.randomUUID()}`;
  await enqueueTelegramNotification({
    eventKey: sendBoundaryKey, recipientScope: 'customer', recipientKey: `binding:${bindingOne.id}`,
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-STOP-RACE', amount: 1, currency: 'USD' }
  });
  await runAsync(
    'UPDATE telegram_customer_bindings SET is_active=0, revoked_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE id=?',
    [bindingOne.id]
  );
  let revokedBindingSendCalls = 0;
  const revokedBindingResult = await processTelegramNotificationBatch({
    workerId: crypto.randomUUID(), limit: 1,
    // Simulate a recipient lookup that completed just before the revocation.
    resolveRecipient: async () => ({ scope: 'customer', merchantId: 7, storeId: 9, token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '54321' }),
    sendMessage: async () => { revokedBindingSendCalls += 1; return { messageId: 99 }; }
  });
  const revokedBindingOutbox = await getAsync(
    'SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?',
    [sendBoundaryKey]
  );
  assert.equal(revokedBindingSendCalls, 0, 'revoked customer binding must not cross the sending boundary');
  assert.equal(revokedBindingResult[0].state, 'lease_lost');
  assert.equal(revokedBindingOutbox.state, 'dead');
  assert.equal(revokedBindingOutbox.last_error_code, 'binding_revoked');

  // Exercise the actual lock race with two independent database connections.
  // Revocation takes the binding lock first; the worker must wait, then observe
  // the committed revoke and refuse to enter the irreversible sending state.
  const raceCustomerHash = crypto.createHash('sha256').update('customer-token-revoke-race').digest('hex');
  await runAsync('INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [raceCustomerHash, 7, 9, '33333', '54333']);
  const raceBinding = await getAsync('SELECT id FROM telegram_customer_bindings WHERE customer_token_hash=? AND store_id=?', [raceCustomerHash, 9]);
  const lockRaceKey = `telegram-it:send-revoke-lock-race:${crypto.randomUUID()}`;
  await enqueueTelegramNotification({
    eventKey: lockRaceKey, recipientScope: 'customer', recipientKey: `binding:${raceBinding.id}`,
    merchantId: 7, storeId: 9,
    event: { type: 'order.created', storeName: 'Integration Store', orderNo: 'IT-STOP-LOCK-RACE', amount: 1, currency: 'USD' }
  });
  const raceWorkerId = crypto.randomUUID();
  const raceClaim = await claimTelegramNotifications({ workerId: raceWorkerId, limit: 1, leaseSeconds: 30 });
  assert.equal(raceClaim.length, 1);
  assert.equal(raceClaim[0].event_key, lockRaceKey);

  const revokeConnection = await testPool.getConnection();
  let sendingAttempt;
  const originalGetConnection = testPool.getConnection.bind(testPool);
  try {
    await revokeConnection.beginTransaction();
    await revokeConnection.execute(
      'SELECT id FROM telegram_customer_bindings WHERE id=? AND is_active=1 AND revoked_at IS NULL FOR UPDATE',
      [raceBinding.id]
    );

    let signalBindingLockWait;
    const bindingLockWaitStarted = new Promise(resolve => { signalBindingLockWait = resolve; });
    let signaled = false;
    testPool.getConnection = async (...args) => {
      const connection = await originalGetConnection(...args);
      const originalExecute = connection.execute.bind(connection);
      connection.execute = (sql, params) => {
        const result = originalExecute(sql, params);
        if (!signaled && String(sql).includes('FROM telegram_customer_bindings') && String(sql).includes('FOR UPDATE')) {
          signaled = true;
          signalBindingLockWait();
        }
        return result;
      };
      return connection;
    };

    sendingAttempt = markTelegramNotificationSending(raceClaim[0].id, raceWorkerId, 30, {
      scope: 'customer', key: `binding:${raceBinding.id}`, merchantId: 7, storeId: 9
    });
    // Wait until the worker has actually issued its locking read, not merely
    // started a promise. It is now blocked behind the revocation transaction.
    await bindingLockWaitStarted;
    const [deadLetter] = await revokeConnection.execute(
      "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='binding_revoked', updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state IN ('pending','processing')",
      [raceClaim[0].id]
    );
    assert.equal(Number(deadLetter.affectedRows), 1);
    await revokeConnection.execute(
      'UPDATE telegram_customer_bindings SET is_active=0, revoked_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE id=?',
      [raceBinding.id]
    );
    await revokeConnection.commit();

    const sendingAllowed = await sendingAttempt;
    const lockRaceOutbox = await getAsync(
      'SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?',
      [lockRaceKey]
    );
    assert.equal(sendingAllowed, false, 'worker must not cross the sending boundary after revoke wins the binding lock');
    assert.equal(lockRaceOutbox.state, 'dead');
    assert.equal(lockRaceOutbox.last_error_code, 'binding_revoked');
  } finally {
    testPool.getConnection = originalGetConnection;
    try { await revokeConnection.rollback(); } catch (_) {}
    revokeConnection.release();
  }

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
    eventKey: key, recipientScope: 'merchant_store', recipientKey: 'store:9', merchantId: 7, storeId: 9,
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

  // The same business event key may be reused safely across tenant stores,
  // notification types, and recipient scopes without cross-tenant suppression.
  const otherStore = await enqueueTelegramNotification({
    ...input, merchantId: 8, storeId: 10, recipientKey: 'store:10'
  });
  assert.notEqual(otherStore.id, first.id);
  const otherType = await enqueueTelegramNotification({
    ...input,
    event: { type: 'order.settled', storeName: 'Integration Store', orderNo: 'IT-42', amount: 12.5, currency: 'USD' }
  });
  assert.notEqual(otherType.id, first.id);
  const sameScopeDuplicate = await enqueueTelegramNotification(input);
  assert.equal(sameScopeDuplicate.id, first.id);
  // Keep the following lease/concurrency assertions isolated from these
  // additional dedupe fixtures.
  await runAsync("UPDATE telegram_notification_outbox SET state='dead', last_error_code='event_disabled', updated_at=UTC_TIMESTAMP(3) WHERE id IN (?, ?)", [otherStore.id, otherType.id]);
  const stored = await getAsync('SELECT payload_json,state,attempts FROM telegram_notification_outbox WHERE id=?', [first.id]);
  assert.equal(String(stored.payload_json).includes('must-not-persist'), false);

  const workerA = crypto.randomUUID();
  const workerB = crypto.randomUUID();
  const claimedA = await claimTelegramNotifications({ workerId: workerA, limit: 1, leaseSeconds: 30 });
  assert.equal(claimedA.length, 1);
  assert.equal(claimedA[0].id, first.id);
  assert.equal((await claimTelegramNotifications({ workerId: workerB, limit: 1, leaseSeconds: 30 })).length, 0);
  assert.equal(await markTelegramNotificationSending(first.id, workerB), false);
  assert.equal(await markTelegramNotificationSending(first.id, workerA), true);
  assert.equal(await markTelegramNotificationDelivered(first.id, workerA, 12345), true);
  assert.equal(Number((await getAsync('SELECT telegram_message_id FROM telegram_notification_outbox WHERE id=?', [first.id])).telegram_message_id), 12345);
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
  assert.equal(await markTelegramNotificationSending(leaseB[0].id, workerB), true);
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
    resolveRecipient: async () => ({ scope: 'merchant_store', merchantId: 7, storeId: 9, token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '-100123' }),
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
    resolveRecipient: async () => ({ scope: 'merchant_store', merchantId: 7, storeId: 9, token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '-100123' }),
    sendMessage: async ({ text }) => { assert.match(text, /IT-42/); return { messageId: 67890 }; }
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].state, 'delivered');
  assert.equal(Number((await getAsync('SELECT telegram_message_id FROM telegram_notification_outbox WHERE event_key=?', [workerKey])).telegram_message_id), 67890);

  const uncertainKey = `${key}:uncertain-send`;
  await enqueueTelegramNotification({ ...input, eventKey: uncertainKey });
  const uncertainResult = await processTelegramNotificationBatch({
    workerId: workerA, limit: 1,
    resolveRecipient: async () => ({ scope: 'merchant_store', merchantId: 7, storeId: 9, token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chatId: '-100123' }),
    sendMessage: async () => { throw Object.assign(new Error('network timeout'), { deliveryUncertain: true }); }
  });
  assert.equal(uncertainResult[0].state, 'uncertain');
  const uncertainRow = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [uncertainKey]);
  assert.equal(uncertainRow.state, 'uncertain');
  assert.equal(uncertainRow.last_error_code, 'delivery_uncertain');
  assert.equal((await claimTelegramNotifications({ workerId: workerB, limit: 1, leaseSeconds: 30 })).some(row => row.event_key === uncertainKey), false);

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

  // Per-store event toggles suppress only matching events for the exact
  // merchant/store; disabling the store later clears its remaining backlog.
  const storeCreatedKey = `${key}:store-toggle:created`;
  const storeSettledKey = `${key}:store-toggle:settled`;
  const otherStoreSettledKey = `${key}:store-toggle:other-store`;
  for (const item of [
    { eventKey: storeCreatedKey, storeId: 9, type: 'order.created', orderNo: 'IT-43G' },
    { eventKey: storeSettledKey, storeId: 9, type: 'order.settled', orderNo: 'IT-43H' },
    { eventKey: otherStoreSettledKey, storeId: 10, type: 'order.settled', orderNo: 'IT-43I' }
  ]) {
    await enqueueTelegramNotification({
      eventKey: item.eventKey, recipientScope: 'merchant_store', recipientKey: `store:${item.storeId}`,
      merchantId: 7, storeId: item.storeId,
      event: { type: item.type, storeName: 'Integration Store', orderNo: item.orderNo, amount: 12.5, currency: 'USD' }
    });
  }
  await runAsync(
    "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='event_disabled', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='merchant_store' AND merchant_id=? AND store_id=? AND event_type=? AND state IN ('pending','processing')",
    [7, 9, 'order.settled']
  );
  assert.equal((await getAsync('SELECT state FROM telegram_notification_outbox WHERE event_key=?', [storeSettledKey])).state, 'dead');
  assert.equal((await getAsync('SELECT state FROM telegram_notification_outbox WHERE event_key=?', [storeCreatedKey])).state, 'pending');
  assert.equal((await getAsync('SELECT state FROM telegram_notification_outbox WHERE event_key=?', [otherStoreSettledKey])).state, 'pending');

  await runAsync(
    "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='event_disabled', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='merchant_store' AND merchant_id=? AND store_id=? AND state IN ('pending','processing')",
    [7, 9]
  );
  assert.equal((await getAsync('SELECT state FROM telegram_notification_outbox WHERE event_key=?', [storeCreatedKey])).state, 'dead');
  assert.equal((await getAsync('SELECT state FROM telegram_notification_outbox WHERE event_key=?', [otherStoreSettledKey])).state, 'pending');
  await runAsync('DELETE FROM telegram_notification_outbox WHERE event_key=?', [otherStoreSettledKey]);

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
  const expiredSendingKey = `${key}:expired-sending`;
  const oldPayload = JSON.stringify({ text: 'old notification' });
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,locked_by,locked_until,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'processing',8,UTC_TIMESTAMP(3),?,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [exhaustedLeaseKey, oldPayload, crypto.randomUUID()]);
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,delivered_at,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'delivered',1,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 100 DAY))", [oldDeliveredKey, oldPayload]);
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,locked_by,locked_until,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'sending',1,UTC_TIMESTAMP(3),?,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [expiredSendingKey, oldPayload, crypto.randomUUID()]);
  await runAsync("INSERT INTO telegram_notification_outbox (event_key,event_type,recipient_scope,recipient_key,payload_json,state,attempts,available_at,created_at,updated_at) VALUES (?, 'order.created','system_admin','admin:primary',?,'dead',8,DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY),DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 200 DAY))", [oldDeadKey, oldPayload]);
  const cleanup = await cleanupTelegramNotificationHistory();
  assert.equal(cleanup.expiredSending, 1);
  assert.equal(cleanup.exhaustedDead, 1);
  const expiredSending = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE event_key=?', [expiredSendingKey]);
  assert.equal(expiredSending.state, 'uncertain');
  assert.equal(expiredSending.last_error_code, 'delivery_uncertain');
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
