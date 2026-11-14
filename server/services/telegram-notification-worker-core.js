'use strict';

const { validateBotToken, validateChatId } = require('./telegram-bot');

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
  // The Bot transport intentionally replaces Telegram's raw descriptions with
  // fixed safe messages. Classify those messages explicitly so 400/401/403
  // failures are not collapsed into the generic "unknown" diagnostic.
  if (/Bot Token 无效或已撤销/.test(message)) return 'telegram_401';
  if (/Bot 无权向该 Chat ID 发送消息/.test(message)) return 'telegram_403';
  if (/Chat ID 无效，或 Bot 尚未加入目标群组/.test(message)) return 'telegram_400';
  const match = message.match(/HTTP (\\d{3})/);
  if (!match) return 'unknown';
  const status = Number(match[1]);
  if (status === 400) return 'telegram_400';
  if (status === 401) return 'telegram_401';
  if (status === 403) return 'telegram_403';
  if (status === 429) return 'telegram_429';
  if (status >= 500) return 'telegram_5xx';
  return 'unknown';
}

module.exports = { validateResolvedRecipient, classifyTelegramError };
