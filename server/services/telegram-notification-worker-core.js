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

module.exports = { validateResolvedRecipient, classifyTelegramError };
