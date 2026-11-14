'use strict';

const { claimTelegramNotifications, markTelegramNotificationDelivered, releaseTelegramNotificationForRetry } = require('./telegram-notification-outbox');
const { sendTelegramMessage, validateBotToken, validateChatId } = require('./telegram-bot');

function validateResolvedRecipient(job, recipient) {
  if (!recipient || typeof recipient !== 'object') return false;
  if (recipient.scope !== job.recipient_scope) return false;
  if (!validateBotToken(recipient.token) || !validateChatId(recipient.chatId)) return false;
  if (job.recipient_scope === 'system_admin') return recipient.merchantId == null && recipient.storeId == null;
  return Number(recipient.merchantId) === Number(job.merchant_id) && Number(recipient.storeId) === Number(job.store_id);
}

function classifyTelegramError(error) {
  const message = String(error && error.message || '');
  if (/无法连接 Telegram API/.test(message)) return 'network_error';
  const match = message.match(/HTTP (\d{3})/);
  if (!match) return 'unknown';
  const status = Number(match[1]);
  if (status === 400) return 'telegram_400';
  if (status === 401) return 'telegram_401';
  if (status === 403) return 'telegram_403';
  if (status === 429) return 'telegram_429';
  if (status >= 500) return 'telegram_5xx';
  return 'unknown';
}

async function processTelegramNotificationBatch({ resolveRecipient, workerId, limit = 10, leaseSeconds = 60, sendMessage = sendTelegramMessage } = {}) {
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
        merchantId: job.merchant_id, storeId: job.store_id
      });
      if (!validateResolvedRecipient(job, recipient)) {
        throw Object.assign(new Error('invalid recipient'), { safeCode: 'invalid_recipient' });
      }
      await sendMessage({ token: recipient.token, chatId: recipient.chatId, text: payload.text });
      const delivered = await markTelegramNotificationDelivered(job.id, job.locked_by);
      results.push({ id: Number(job.id), state: delivered ? 'delivered' : 'lease_lost' });
    } catch (error) {
      const code = error && error.safeCode || classifyTelegramError(error);
      const released = await releaseTelegramNotificationForRetry(job.id, job.locked_by, code, Number(job.attempts));
      results.push({ id: Number(job.id), state: released ? (Number(job.attempts) >= 8 ? 'dead' : 'retry') : 'lease_lost' });
    }
  }
  return results;
}

module.exports = { validateResolvedRecipient, classifyTelegramError, processTelegramNotificationBatch };
