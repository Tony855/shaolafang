'use strict';

const { randomUUID } = require('crypto');
const { runAsync, allAsync, withTransaction } = require('../db/helpers');
const { formatTelegramBusinessNotification } = require('./telegram-notification-format');

const ALLOWED_SCOPES = new Set(['system_admin', 'merchant_store', 'customer']);
const SAFE_ERROR_CODES = new Set(['network_error', 'telegram_400', 'telegram_401', 'telegram_403', 'telegram_429', 'telegram_5xx', 'invalid_recipient', 'unknown']);

function positiveId(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(label + ' 无效');
  return n;
}

function normalizeOutboxInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('通知任务无效');
  if (typeof input.eventKey !== 'string' || !/^[A-Za-z0-9:._-]{1,160}$/.test(input.eventKey)) throw new TypeError('通知幂等键无效');
  if (!ALLOWED_SCOPES.has(input.recipientScope)) throw new TypeError('通知接收范围无效');
  if (typeof input.recipientKey !== 'string' || !/^[A-Za-z0-9:._-]{1,96}$/.test(input.recipientKey)) throw new TypeError('通知接收目标无效');
  const event = input.event;
  const text = formatTelegramBusinessNotification(event);
  let merchantId = null;
  let storeId = null;
  if (input.recipientScope === 'system_admin') {
    if (input.merchantId != null || input.storeId != null) throw new TypeError('系统管理员通知不能携带商户门店范围');
  } else {
    merchantId = positiveId(input.merchantId, '商户编号');
    storeId = positiveId(input.storeId, '门店编号');
  }
  return { eventKey: input.eventKey, eventType: event.type, merchantId, storeId,
    recipientScope: input.recipientScope, recipientKey: input.recipientKey,
    payloadJson: JSON.stringify({ text }) };
}

async function enqueueTelegramNotification(input) {
  const row = normalizeOutboxInput(input);
  const now = new Date();
  const result = await runAsync(
    'INSERT INTO telegram_notification_outbox (event_key, event_type, merchant_id, store_id, recipient_scope, recipient_key, payload_json, state, attempts, available_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'pending\', 0, ?, ?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',
    [row.eventKey, row.eventType, row.merchantId, row.storeId, row.recipientScope, row.recipientKey, row.payloadJson, now, now, now]
  );
  return { inserted: Number(result.affectedRows) === 1, id: Number(result.insertId) || null };
}

async function claimTelegramNotifications({ workerId = randomUUID(), limit = 10, leaseSeconds = 60 } = {}) {
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(workerId)) throw new TypeError('Worker ID 无效');
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

async function markTelegramNotificationDelivered(id, workerId) {
  const result = await runAsync(
    'UPDATE telegram_notification_outbox SET state=\'delivered\', delivered_at=UTC_TIMESTAMP(3), locked_by=NULL, locked_until=NULL, last_error_code=NULL, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state=\'processing\' AND locked_by=?',
    [positiveId(id, '通知任务编号'), workerId]
  );
  return Number(result.affectedRows) === 1;
}

function retryDelaySeconds(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('重试次数无效');
  return Math.min(900, 15 * (2 ** Math.min(attempt - 1, 6)));
}

async function releaseTelegramNotificationForRetry(id, workerId, errorCode, attempt) {
  const safeCode = SAFE_ERROR_CODES.has(errorCode) ? errorCode : 'unknown';
  const taskId = positiveId(id, '通知任务编号');
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 8) throw new TypeError('重试次数无效');
  if (attempt >= 8) {
    const result = await runAsync(
      'UPDATE telegram_notification_outbox SET state=\'dead\', locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state=\'processing\' AND locked_by=?',
      [safeCode, taskId, workerId]
    );
    return Number(result.affectedRows) === 1;
  }
  const delay = retryDelaySeconds(attempt);
  const result = await runAsync(
    'UPDATE telegram_notification_outbox SET state=\'pending\', available_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND), locked_by=NULL, locked_until=NULL, last_error_code=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state=\'processing\' AND locked_by=?',
    [delay, safeCode, taskId, workerId]
  );
  return Number(result.affectedRows) === 1;
}

module.exports = { normalizeOutboxInput, enqueueTelegramNotification, claimTelegramNotifications, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry, retryDelaySeconds };
