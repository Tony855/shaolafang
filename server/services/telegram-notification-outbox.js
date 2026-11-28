'use strict';

const { randomUUID } = require('crypto');
const { runAsync, allAsync, withTransaction } = require('../db/helpers');
const { normalizeOutboxInput, positiveId, retryDelaySeconds, SAFE_ERROR_CODES } = require('./telegram-notification-outbox-core');
const { parseTelegramDestinationRecipientKey } = require('./telegram-notification-routing');

async function enqueueTelegramNotification(input) {
  const row = normalizeOutboxInput(input);
  const result = await runAsync(
    'INSERT INTO telegram_notification_outbox (event_key, event_type, merchant_id, store_id, recipient_scope, recipient_key, payload_json, state, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'pending\', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',
    [row.eventKey, row.eventType, row.merchantId, row.storeId, row.recipientScope, row.recipientKey, row.payloadJson]
  );
  return { id: Number(result.insertId) || null };
}

async function claimTelegramNotifications({ workerId = randomUUID(), limit = 10, leaseSeconds = 60 } = {}) {
  if (typeof workerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workerId)) throw new TypeError('Worker ID 无效');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('领取数量无效');
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 600) throw new TypeError('租约时长无效');
  return withTransaction(async () => {
    const rows = await allAsync(
      'SELECT id, event_key, event_type, merchant_id, store_id, recipient_scope, recipient_key, payload_json, attempts FROM telegram_notification_outbox WHERE attempts < 8 AND available_at <= UTC_TIMESTAMP(3) AND (state=\'pending\' OR (state=\'processing\' AND locked_until < UTC_TIMESTAMP(3))) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED',
      [limit]
    );
    if (!rows.length) return [];
    const ids = rows.map(row => Number(row.id));
    const placeholders = ids.map(() => '?').join(',');
    await runAsync(
      'UPDATE telegram_notification_outbox SET state=\'processing\', locked_by=?, locked_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), attempts=attempts+1, updated_at=UTC_TIMESTAMP(3) WHERE id IN (' + placeholders + ')',
      [workerId, leaseSeconds, ...ids]
    );
    return rows.map(row => ({ ...row, attempts: Number(row.attempts) + 1, locked_by: workerId }));
  });
}

async function markTelegramNotificationSending(id, workerId, leaseSeconds = 60, recipientContext = null) {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 600) throw new TypeError('租约时长无效');
  const taskId = positiveId(id, '通知任务编号');
  return withTransaction(async () => {
    if (recipientContext?.scope === 'customer') {
      const key = typeof recipientContext.key === 'string' ? recipientContext.key : '';
      const bindingMatch = key.match(/^binding:([1-9]\d{0,18})$/);
      const merchantId = Number(recipientContext.merchantId);
      const storeId = Number(recipientContext.storeId);
      const bindingId = bindingMatch ? Number(bindingMatch[1]) : 0;
      if (!Number.isSafeInteger(bindingId) || bindingId <= 0 ||
          !Number.isSafeInteger(merchantId) || merchantId <= 0 ||
          !Number.isSafeInteger(storeId) || storeId <= 0) {
        return false;
      }

      // Match /stop and page revoke: binding first, then outbox.
      const bindings = await allAsync(
        'SELECT id FROM telegram_customer_bindings WHERE id=? AND merchant_id=? AND store_id=? AND is_active=1 AND revoked_at IS NULL FOR UPDATE',
        [bindingId, merchantId, storeId]
      );
      if (!Array.isArray(bindings) || !bindings.length) {
        await runAsync(
          "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='binding_revoked', updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='processing' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)",
          [taskId, workerId]
        );
        return false;
      }
    } else if (recipientContext?.scope === 'merchant_store' &&
               typeof recipientContext.key === 'string' &&
               recipientContext.key.startsWith('destination:')) {
      const target = parseTelegramDestinationRecipientKey(recipientContext.key);
      const merchantId = Number(recipientContext.merchantId);
      const storeId = Number(recipientContext.storeId);
      const eventToggle = {
        'order.created': 'notify_order_created',
        'order.settled': 'notify_settled',
        'order.refunded': 'notify_refunded'
      }[recipientContext.eventType];

      const markDead = async code => {
        await runAsync(
          "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='processing' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)",
          [code, taskId, workerId]
        );
        return false;
      };

      if (!target || !eventToggle || target.storeId !== storeId ||
          !Number.isSafeInteger(merchantId) || merchantId <= 0 ||
          !Number.isSafeInteger(storeId) || storeId <= 0) {
        return markDead('invalid_recipient');
      }

      const merchants = await allAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
      if (!Array.isArray(merchants) || !merchants.length) return markDead('event_disabled');
      const tenantBots = await allAsync(
        'SELECT admin_bot_enabled FROM telegram_merchant_bots WHERE merchant_id=? FOR UPDATE',
        [merchantId]
      );
      if (Array.isArray(tenantBots) && tenantBots.length) {
        if (Number(tenantBots[0].admin_bot_enabled) !== 1) return markDead('event_disabled');
      } else {
        const botSettings = await allAsync(
          "SELECT value FROM settings WHERE `key`='telegram_admin_bot_enabled' FOR UPDATE"
        );
        if (!Array.isArray(botSettings) || !botSettings.length || botSettings[0].value !== '1') {
          return markDead('event_disabled');
        }
      }

      // Group send boundary lock order matches enqueue and subscription writes:
      // store -> destination -> subscription -> outbox. If an admin disables
      // or removes a subscription first, this worker observes it and cannot
      // cross the irreversible Telegram send boundary.
      const stores = await allAsync(
        'SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE',
        [storeId, merchantId]
      );
      if (!Array.isArray(stores) || !stores.length) return markDead('event_disabled');

      const destinations = await allAsync(
        `SELECT id, chat_id FROM telegram_chat_destinations WHERE id=? AND merchant_id=? AND bot_profile='admin' AND chat_type IN ('group','supergroup') AND is_enabled=1 FOR UPDATE`,
        [target.destinationId, merchantId]
      );
      if (!Array.isArray(destinations) || !destinations.length ||
          String(destinations[0].chat_id || '') !== String(recipientContext.expectedChatId || '')) {
        return markDead('event_disabled');
      }

      const subscriptions = await allAsync(
        `SELECT id FROM telegram_store_subscriptions
         WHERE merchant_id=? AND destination_id=? AND store_id=?
           AND is_enabled=1 AND ${eventToggle}=1
         FOR UPDATE`,
        [merchantId, target.destinationId, storeId]
      );
      if (!Array.isArray(subscriptions) || !subscriptions.length) return markDead('event_disabled');
    }

    const result = await runAsync(
      "UPDATE telegram_notification_outbox SET state='sending', locked_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='processing' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)",
      [leaseSeconds, taskId, workerId]
    );
    return Number(result.affectedRows) === 1;
  });
}
async function markTelegramNotificationUncertain(id, workerId, errorCode = 'delivery_uncertain') {
  const result = await runAsync(
    "UPDATE telegram_notification_outbox SET state='uncertain', locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='sending' AND locked_by=?",
    [errorCode, positiveId(id, '通知任务编号'), workerId]
  );
  return Number(result.affectedRows) === 1;
}

async function markTelegramNotificationDelivered(id, workerId, messageId = null) {
  const safeMessageId = messageId && Number.isSafeInteger(Number(messageId)) && Number(messageId) > 0 ? Number(messageId) : null;
  const result = await runAsync(
    "UPDATE telegram_notification_outbox SET state='delivered', delivered_at=UTC_TIMESTAMP(3), telegram_message_id=?, locked_by=NULL, locked_until=NULL, last_error_code=NULL, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='sending' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)",
    [safeMessageId, positiveId(id, '通知任务编号'), workerId]
  );
  return Number(result.affectedRows) === 1;
}

async function releaseTelegramNotificationForRetry(id, workerId, errorCode, attempt, retryAfterSeconds = 0) {
  const safeCode = SAFE_ERROR_CODES.has(errorCode) ? errorCode : 'unknown';
  const taskId = positiveId(id, '通知任务编号');
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 8) throw new TypeError('重试次数无效');
  const ownedStates = "state IN ('processing','sending')";
  if (safeCode === 'event_disabled' || safeCode === 'binding_revoked' || attempt >= 8) {
    const result = await runAsync(
      "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND " + ownedStates + " AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)",
      [safeCode, taskId, workerId]
    );
    return Number(result.affectedRows) === 1;
  }
  const delay = retryDelaySeconds(attempt, Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, 3600) : 0);
  const result = await runAsync(
    "UPDATE telegram_notification_outbox SET state='pending', available_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND " + ownedStates + " AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)",
    [delay, safeCode, taskId, workerId]
  );
  return Number(result.affectedRows) === 1;
}

async function cleanupTelegramNotificationHistory({ deliveredRetentionDays = 90, deadRetentionDays = 180, batchSize = 1000 } = {}) {
  if (!Number.isInteger(deliveredRetentionDays) || deliveredRetentionDays < 30 || deliveredRetentionDays > 3650) throw new TypeError('Delivered retention is invalid');
  if (!Number.isInteger(deadRetentionDays) || deadRetentionDays < 30 || deadRetentionDays > 3650) throw new TypeError('Dead retention is invalid');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new TypeError('Cleanup batch size is invalid');
  const expiredSending = await withTransaction(async () => {
    const rows = await allAsync(
      "SELECT id FROM telegram_notification_outbox WHERE state='sending' AND locked_until < UTC_TIMESTAMP(3) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
      [batchSize]
    );
    if (!rows.length) return 0;
    const ids = rows.map(row => positiveId(row.id, '通知任务编号'));
    const placeholders = ids.map(() => '?').join(',');
    const result = await runAsync(
      "UPDATE telegram_notification_outbox SET state='uncertain', locked_by=NULL, locked_until=NULL, last_error_code='delivery_uncertain', updated_at=UTC_TIMESTAMP(3) WHERE state='sending' AND id IN (" + placeholders + ")",
      ids
    );
    return Number(result.affectedRows) || 0;
  });
  const exhaustedDead = await withTransaction(async () => {
    const rows = await allAsync(
      "SELECT id FROM telegram_notification_outbox WHERE state='processing' AND attempts >= 8 AND locked_until < UTC_TIMESTAMP(3) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",
      [batchSize]
    );
    if (!rows.length) return 0;
    const ids = rows.map(row => positiveId(row.id, '通知任务编号'));
    const placeholders = ids.map(() => '?').join(',');
    const result = await runAsync(
      "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code=COALESCE(last_error_code, 'unknown'), updated_at=UTC_TIMESTAMP(3) WHERE state='processing' AND attempts >= 8 AND id IN (" + placeholders + ")",
      ids
    );
    return Number(result.affectedRows) || 0;
  });
  const delivered = await runAsync(
    "DELETE FROM telegram_notification_outbox WHERE state='delivered' AND delivered_at IS NOT NULL AND delivered_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) LIMIT ?",
    [deliveredRetentionDays, batchSize]
  );
  const dead = await runAsync(
    "DELETE FROM telegram_notification_outbox WHERE state='dead' AND updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) LIMIT ?",
    [deadRetentionDays, batchSize]
  );
  return { expiredSending, exhaustedDead, deliveredDeleted: Number(delivered.affectedRows) || 0, deadDeleted: Number(dead.affectedRows) || 0 };
}

module.exports = { enqueueTelegramNotification, claimTelegramNotifications, markTelegramNotificationSending, markTelegramNotificationUncertain, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry, cleanupTelegramNotificationHistory };
