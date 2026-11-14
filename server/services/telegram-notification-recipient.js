'use strict';

const { validateBotToken, validateChatId } = require('./telegram-bot');

const SYSTEM_ADMIN_RECIPIENT_KEY = 'admin:primary';

function createTelegramNotificationRecipientResolver({ allAsync }) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');
  return async function resolveTelegramNotificationRecipient({ scope, key, merchantId, storeId } = {}) {
    if (scope === 'system_admin' && key === SYSTEM_ADMIN_RECIPIENT_KEY && merchantId == null && storeId == null) {
      const keys = ['telegram_admin_bot_enabled', 'telegram_admin_bot_token', 'telegram_admin_chat_id'];
      const rows = await allAsync('SELECT `key`, value FROM settings WHERE `key` IN (?, ?, ?)', keys);
      const stored = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
      const token = String(stored.telegram_admin_bot_token || '');
      const chatId = String(stored.telegram_admin_chat_id || '');
      if (stored.telegram_admin_bot_enabled !== '1' || !validateBotToken(token) || !validateChatId(chatId)) return null;
      return { scope: 'system_admin', merchantId: null, storeId: null, token, chatId };
    }
    if (scope !== 'customer' || typeof key !== 'string' || !/^binding:[1-9]\d{0,18}$/.test(key)) return null;
    const bindingId = Number(key.slice('binding:'.length));
    const tenantMerchantId = Number(merchantId);
    const tenantStoreId = Number(storeId);
    if (!Number.isSafeInteger(bindingId) || !Number.isSafeInteger(tenantMerchantId) || tenantMerchantId <= 0 ||
        !Number.isSafeInteger(tenantStoreId) || tenantStoreId <= 0) return null;
    const binding = await allAsync(
      'SELECT id, merchant_id, store_id, telegram_chat_id FROM telegram_customer_bindings WHERE id=? AND merchant_id=? AND store_id=? AND is_active=1 AND revoked_at IS NULL LIMIT 1',
      [bindingId, tenantMerchantId, tenantStoreId]
    );
    if (!Array.isArray(binding) || !binding.length) return null;
    const settings = await allAsync(
      'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
      ['telegram_client_bot_enabled', 'telegram_client_bot_token']
    );
    const stored = Object.fromEntries((Array.isArray(settings) ? settings : []).map(row => [row.key, row.value]));
    const token = String(stored.telegram_client_bot_token || '');
    const chatId = String(binding[0].telegram_chat_id || '');
    if (stored.telegram_client_bot_enabled !== '1' || !validateBotToken(token) || !validateChatId(chatId)) return null;
    return { scope: 'customer', merchantId: tenantMerchantId, storeId: tenantStoreId, token, chatId };
  };
}

module.exports = { SYSTEM_ADMIN_RECIPIENT_KEY, createTelegramNotificationRecipientResolver };
