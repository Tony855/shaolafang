'use strict';

const { randomUUID } = require('crypto');
const { runAsync, allAsync, withTransaction } = require('../db/helpers');
const { normalizeOutboxInput, positiveId, retryDelaySeconds, SAFE_ERROR_CODES } = require('./telegram-notification-outbox-core');

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
    await runAsync("UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='unknown', updated_at=UTC_TIMESTAMP(3) WHERE state='processing' AND attempts >= 8 AND locked_until < UTC_TIMESTAMP(3)");
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

async function markTelegramNotificationDelivered(id, workerId) {
  const result = await runAsync(
    'UPDATE telegram_notification_outbox SET state=\'delivered\', delivered_at=UTC_TIMESTAMP(3), locked_by=NULL, locked_until=NULL, last_error_code=NULL, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state=\'processing\' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)',
    [positiveId(id, '通知任务编号'), workerId]
  );
  return Number(result.affectedRows) === 1;
}

async function releaseTelegramNotificationForRetry(id, workerId, errorCode, attempt, retryAfterSeconds = 0) {
  const safeCode = SAFE_ERROR_CODES.has(errorCode) ? errorCode : 'unknown';
  const taskId = positiveId(id, '通知任务编号');
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 8) throw new TypeError('重试次数无效');
  if (safeCode === 'event_disabled') {
    const result = await runAsync(
      "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='processing' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)",
      [safeCode, taskId, workerId]
    );
    return Number(result.affectedRows) === 1;
  }
  if (attempt >= 8) {
    const result = await runAsync(
      'UPDATE telegram_notification_outbox SET state=\'dead\', locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state=\'processing\' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)',
      [safeCode, taskId, workerId]
    );
    return Number(result.affectedRows) === 1;
  }
  const delay = retryDelaySeconds(attempt, Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, 3600) : 0);
  const result = await runAsync(
    'UPDATE telegram_notification_outbox SET state=\'pending\', available_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state=\'processing\' AND locked_by=? AND locked_until >= UTC_TIMESTAMP(3)',
    [delay, safeCode, taskId, workerId]
  );
  return Number(result.affectedRows) === 1;
}

async function cleanupTelegramNotificationHistory({ deliveredRetentionDays = 90, deadRetentionDays = 180, batchSize = 1000 } = {}) {
  if (!Number.isInteger(deliveredRetentionDays) || deliveredRetentionDays < 30 || deliveredRetentionDays > 3650) throw new TypeError('Delivered retention is invalid');
  if (!Number.isInteger(deadRetentionDays) || deadRetentionDays < 30 || deadRetentionDays > 3650) throw new TypeError('Dead-letter retention is invalid');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new TypeError('Cleanup batch size is invalid');
  const delivered = await runAsync(
    "DELETE FROM telegram_notification_outbox WHERE state='delivered' AND delivered_at IS NOT NULL AND delivered_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) LIMIT ?",
    [deliveredRetentionDays, batchSize]
  );
  const dead = await runAsync(
    "DELETE FROM telegram_notification_outbox WHERE state='dead' AND updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY) LIMIT ?",
    [deadRetentionDays, batchSize]
  );
  return { deliveredDeleted: Number(delivered.affectedRows) || 0, deadDeleted: Number(dead.affectedRows) || 0 };
}

module.exports = { enqueueTelegramNotification, claimTelegramNotifications, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry, cleanupTelegramNotificationHistory };
