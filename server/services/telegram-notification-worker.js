'use strict';

const { claimTelegramNotifications, markTelegramNotificationSending, markTelegramNotificationDelivered, markTelegramNotificationUncertain, releaseTelegramNotificationForRetry } = require('./telegram-notification-outbox');
const { sendTelegramMessage } = require('./telegram-bot');
const { validateResolvedRecipient, classifyTelegramError } = require('./telegram-notification-worker-core');

async function processTelegramNotificationBatch({ resolveRecipient, workerId, limit = 1, leaseSeconds = 60, sendMessage = sendTelegramMessage } = {}) {
  if (typeof resolveRecipient !== 'function') throw new TypeError('必须提供通知接收人解析器');
  if (typeof sendMessage !== 'function') throw new TypeError('必须提供 Telegram 发送器');
  const jobs = await claimTelegramNotifications({ workerId, limit, leaseSeconds });
  const results = [];
  for (const job of jobs) {
    let payload;
    let recipient;
    try {
      try { payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json; }
      catch (_) { throw Object.assign(new Error('invalid payload'), { safeCode: 'unknown' }); }
      if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4096) {
        throw Object.assign(new Error('invalid payload'), { safeCode: 'unknown' });
      }
      recipient = await resolveRecipient({
        scope: job.recipient_scope, key: job.recipient_key,
        merchantId: job.merchant_id, storeId: job.store_id, eventType: job.event_type
      });
      if (recipient?.suppressed === true) {
        const suppressionCode = recipient.suppressionCode === 'binding_revoked' && job.recipient_scope === 'customer'
          ? 'binding_revoked' : 'event_disabled';
        const suppressed = await releaseTelegramNotificationForRetry(job.id, job.locked_by, suppressionCode, Number(job.attempts));
        results.push({ id: Number(job.id), state: suppressed ? 'suppressed' : 'lease_lost' });
        continue;
      }
      if (!validateResolvedRecipient(job, recipient)) {
        throw Object.assign(new Error('invalid recipient'), { safeCode: 'invalid_recipient' });
      }
    } catch (error) {
      const code = error && error.safeCode || classifyTelegramError(error);
      const released = await releaseTelegramNotificationForRetry(job.id, job.locked_by, code, Number(job.attempts), Number(error?.retryAfterSeconds) || 0);
      results.push({ id: Number(job.id), state: released ? (Number(job.attempts) >= 8 ? 'dead' : 'retry') : 'lease_lost' });
      continue;
    }

    // Persist the irreversible-send boundary before calling Telegram. An expired
    // sending lease is quarantined as uncertain, never blindly re-delivered.
    const sending = await markTelegramNotificationSending(job.id, job.locked_by, leaseSeconds, {
      scope: job.recipient_scope,
      key: job.recipient_key,
      merchantId: job.merchant_id,
      storeId: job.store_id,
      eventType: job.event_type,
      expectedChatId: recipient.chatId
    });
    if (!sending) {
      results.push({ id: Number(job.id), state: 'lease_lost' });
      continue;
    }

    let receipt;
    try {
      receipt = await sendMessage({ token: recipient.token, chatId: recipient.chatId, text: payload.text });
    } catch (error) {
      if (error?.deliveryUncertain === true) {
        const quarantined = await markTelegramNotificationUncertain(job.id, job.locked_by, 'delivery_uncertain');
        results.push({ id: Number(job.id), state: quarantined ? 'uncertain' : 'lease_lost' });
      } else {
        const code = error && error.safeCode || classifyTelegramError(error);
        const released = await releaseTelegramNotificationForRetry(job.id, job.locked_by, code, Number(job.attempts), Number(error?.retryAfterSeconds) || 0);
        results.push({ id: Number(job.id), state: released ? (Number(job.attempts) >= 8 ? 'dead' : 'retry') : 'lease_lost' });
      }
      continue;
    }

    // Deliberately outside the send catch: a database failure after Telegram
    // accepted the message must leave the row in 'sending' for quarantine.
    const delivered = await markTelegramNotificationDelivered(job.id, job.locked_by, receipt?.messageId || null);
    results.push({ id: Number(job.id), state: delivered ? 'delivered' : 'lease_lost' });
  }
  return results;
}

module.exports = { processTelegramNotificationBatch };
