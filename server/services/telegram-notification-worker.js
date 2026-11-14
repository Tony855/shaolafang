'use strict';

const { claimTelegramNotifications, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry } = require('./telegram-notification-outbox');
const { sendTelegramMessage } = require('./telegram-bot');
const { validateResolvedRecipient, classifyTelegramError } = require('./telegram-notification-worker-core');

async function processTelegramNotificationBatch({ resolveRecipient, workerId, limit = 1, leaseSeconds = 60, sendMessage = sendTelegramMessage } = {}) {
  if (typeof resolveRecipient !== 'function') throw new TypeError('必须提供通知接收人解析器');
  if (typeof sendMessage !== 'function') throw new TypeError('必须提供 Telegram 发送器');
  const jobs = await claimTelegramNotifications({ workerId, limit, leaseSeconds });
  const results = [];
  for (const job of jobs) {
    try {
      let payload;
      try { payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json; }
      catch (_) { throw Object.assign(new Error('invalid payload'), { safeCode: 'unknown' }); }
      if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4096) {
        throw Object.assign(new Error('invalid payload'), { safeCode: 'unknown' });
      }
      const recipient = await resolveRecipient({
        scope: job.recipient_scope, key: job.recipient_key,
        merchantId: job.merchant_id, storeId: job.store_id, eventType: job.event_type
      });
      if (recipient?.suppressed === true &&
          (job.recipient_scope === 'merchant_store' || job.recipient_scope === 'customer')) {
        const suppressionCode = recipient.suppressionCode === 'binding_revoked' && job.recipient_scope === 'customer'
          ? 'binding_revoked'
          : 'event_disabled';
        const suppressed = await releaseTelegramNotificationForRetry(
          job.id, job.locked_by, suppressionCode, Number(job.attempts)
        );
        results.push({ id: Number(job.id), state: suppressed ? 'suppressed' : 'lease_lost' });
        continue;
      }
      if (!validateResolvedRecipient(job, recipient)) {
        throw Object.assign(new Error('invalid recipient'), { safeCode: 'invalid_recipient' });
      }
      await sendMessage({ token: recipient.token, chatId: recipient.chatId, text: payload.text });
      const delivered = await markTelegramNotificationDelivered(job.id, job.locked_by);
      results.push({ id: Number(job.id), state: delivered ? 'delivered' : 'lease_lost' });
    } catch (error) {
      const code = error && error.safeCode || classifyTelegramError(error);
      const released = await releaseTelegramNotificationForRetry(job.id, job.locked_by, code, Number(job.attempts), Number(error?.retryAfterSeconds) || 0);
      results.push({ id: Number(job.id), state: released ? (Number(job.attempts) >= 8 ? 'dead' : 'retry') : 'lease_lost' });
    }
  }
  return results;
}

module.exports = { processTelegramNotificationBatch };
