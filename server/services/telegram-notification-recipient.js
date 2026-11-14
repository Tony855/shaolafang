'use strict';

const { validateBotToken, validateChatId } = require('./telegram-bot');

const SYSTEM_ADMIN_RECIPIENT_KEY = 'admin:primary';

function createTelegramNotificationRecipientResolver({ allAsync }) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');
  return async function resolveTelegramNotificationRecipient({ scope, key, merchantId, storeId } = {}) {
    if (scope !== 'system_admin' || key !== SYSTEM_ADMIN_RECIPIENT_KEY) return null;
    if (merchantId != null || storeId != null) return null;
    const keys = ['telegram_admin_bot_enabled', 'telegram_admin_bot_token', 'telegram_admin_chat_id'];
    const rows = await allAsync(
      'SELECT `key`, value FROM settings WHERE `key` IN (?, ?, ?)', keys
    );
    const stored = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
    const token = String(stored.telegram_admin_bot_token || '');
    const chatId = String(stored.telegram_admin_chat_id || '');
    if (stored.telegram_admin_bot_enabled !== '1' || !validateBotToken(token) || !validateChatId(chatId)) return null;
    return { scope: 'system_admin', merchantId: null, storeId: null, token, chatId };
  };
}

module.exports = { SYSTEM_ADMIN_RECIPIENT_KEY, createTelegramNotificationRecipientResolver };
