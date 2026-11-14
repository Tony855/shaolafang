'use strict';

const { validateBotToken, validateChatId } = require('./telegram-bot');

const SYSTEM_ADMIN_RECIPIENT_KEY = 'admin:primary';

function createTelegramNotificationRecipientResolver({ allAsync }) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');
  return async function resolveTelegramNotificationRecipient({ scope, key, merchantId, storeId, eventType } = {}) {
    if (scope === 'system_admin' && key === SYSTEM_ADMIN_RECIPIENT_KEY && merchantId == null && storeId == null) {
      const keys = ['telegram_admin_bot_enabled', 'telegram_admin_bot_token', 'telegram_admin_chat_id'];
      const rows = await allAsync('SELECT `key`, value FROM settings WHERE `key` IN (?, ?, ?)', keys);
      const stored = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
      const token = String(stored.telegram_admin_bot_token || '');
      const chatId = String(stored.telegram_admin_chat_id || '');
      if (stored.telegram_admin_bot_enabled !== '1' || !validateBotToken(token) || !validateChatId(chatId)) return null;
      return { scope: 'system_admin', merchantId: null, storeId: null, token, chatId };
    }
    if (scope === 'merchant_store' && typeof key === 'string' && /^store:[1-9]\d{0,18}$/.test(key)) {
      const tenantMerchantId = Number(merchantId);
      const tenantStoreId = Number(storeId);
      if (!Number.isSafeInteger(tenantMerchantId) || tenantMerchantId <= 0 || !Number.isSafeInteger(tenantStoreId) || tenantStoreId <= 0 || Number(key.slice(6)) !== tenantStoreId) return null;
      const eventToggle = { 'order.created': 'notify_order_created', 'order.settled': 'notify_settled', 'order.refunded': 'notify_refunded' }[eventType];
      if (!eventToggle) return null;
      const recipients = await allAsync(
        `SELECT r.chat_id, r.is_enabled, r.${eventToggle} AS event_enabled FROM telegram_store_admin_recipients r JOIN stores s ON s.id=r.store_id AND s.merchant_id=r.merchant_id JOIN merchants m ON m.id=r.merchant_id WHERE r.merchant_id=? AND r.store_id=? AND s.active=1 AND m.status=1 LIMIT 1`,
        [tenantMerchantId, tenantStoreId]
      );
      if (!Array.isArray(recipients) || !recipients.length) return null;
      if (Number(recipients[0].is_enabled) !== 1 || Number(recipients[0].event_enabled) !== 1) {
        return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
      }
      const settings = await allAsync('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)', ['telegram_admin_bot_enabled', 'telegram_admin_bot_token']);
      const stored = Object.fromEntries((Array.isArray(settings) ? settings : []).map(row => [row.key, row.value]));
      const token = String(stored.telegram_admin_bot_token || '');
      const chatId = String(recipients[0].chat_id || '');
      if (stored.telegram_admin_bot_enabled !== '1' || !validateBotToken(token) || !validateChatId(chatId)) return null;
      return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, token, chatId };
    }
    if (scope !== 'customer' || typeof key !== 'string' || !/^binding:[1-9]\d{0,18}$/.test(key)) return null;
    const bindingId = Number(key.slice('binding:'.length));
    const tenantMerchantId = Number(merchantId);
    const tenantStoreId = Number(storeId);
    if (!Number.isSafeInteger(bindingId) || !Number.isSafeInteger(tenantMerchantId) || tenantMerchantId <= 0 ||
        !Number.isSafeInteger(tenantStoreId) || tenantStoreId <= 0) return null;
    const binding = await allAsync(
      'SELECT b.id, b.merchant_id, b.store_id, b.telegram_chat_id FROM telegram_customer_bindings b JOIN stores s ON s.id=b.store_id AND s.merchant_id=b.merchant_id JOIN merchants m ON m.id=b.merchant_id WHERE b.id=? AND b.merchant_id=? AND b.store_id=? AND b.is_active=1 AND b.revoked_at IS NULL AND s.active=1 AND m.status=1 LIMIT 1',
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
