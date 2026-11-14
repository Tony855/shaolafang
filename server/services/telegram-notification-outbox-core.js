'use strict';

const { formatTelegramBusinessNotification } = require('./telegram-notification-format');

const ALLOWED_SCOPES = new Set(['system_admin', 'merchant_store', 'customer']);
const SAFE_ERROR_CODES = new Set([
  'network_error', 'telegram_400', 'telegram_401', 'telegram_403',
  'telegram_429', 'telegram_5xx', 'invalid_recipient', 'event_disabled', 'unknown'
]);

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

function retryDelaySeconds(attempt, retryAfterSeconds = 0) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('重试次数无效');
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 0) throw new TypeError('Telegram 重试等待时间无效');
  const exponentialDelay = Math.min(900, 15 * (2 ** Math.min(attempt - 1, 6)));
  return Math.max(exponentialDelay, Math.min(retryAfterSeconds, 3600));
}

module.exports = { ALLOWED_SCOPES, SAFE_ERROR_CODES, positiveId, normalizeOutboxInput, retryDelaySeconds };
