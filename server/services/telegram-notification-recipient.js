'use strict';

const { validateBotToken, validateChatId } = require('./telegram-bot');
const {
  isTelegramGroupSubscriptionsRoutingEnabled,
  parseTelegramDestinationRecipientKey
} = require('./telegram-notification-routing');

function createTelegramNotificationRecipientResolver({
  allAsync,
  routingEnabled = isTelegramGroupSubscriptionsRoutingEnabled()
} = {}) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');

  async function getAdminBotCredentials(scope, merchantId, storeId) {
    const settings = await allAsync(
      'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
      ['telegram_admin_bot_enabled', 'telegram_admin_bot_token']
    );
    const stored = Object.fromEntries((Array.isArray(settings) ? settings : []).map(row => [row.key, row.value]));
    const token = String(stored.telegram_admin_bot_token || '');
    if (stored.telegram_admin_bot_enabled !== '1') {
      return { scope, merchantId, storeId, suppressed: true };
    }
    if (!validateBotToken(token)) return null;
    return { token };
  }

  return async function resolveTelegramNotificationRecipient({ scope, key, merchantId, storeId, eventType } = {}) {
    // Legacy system-admin jobs are always terminally suppressed.
    if (scope === 'system_admin') {
      return { scope: 'system_admin', merchantId: null, storeId: null, suppressed: true };
    }

    if (scope === 'merchant_store') {
      const tenantMerchantId = Number(merchantId);
      const tenantStoreId = Number(storeId);
      if (!Number.isSafeInteger(tenantMerchantId) || tenantMerchantId <= 0 ||
          !Number.isSafeInteger(tenantStoreId) || tenantStoreId <= 0 || typeof key !== 'string') return null;

      const eventToggle = {
        'order.created': 'notify_order_created',
        'order.settled': 'notify_settled',
        'order.refunded': 'notify_refunded'
      }[eventType];
      if (!eventToggle) return null;

      const destinationKey = parseTelegramDestinationRecipientKey(key);
      if (key.startsWith('destination:') && !destinationKey) {
        return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
      }
      if (destinationKey) {
        // New destination jobs are only active when the staging-gated routing
        // flag is enabled. Turning it off terminally suppresses already queued
        // destination jobs instead of falling back to legacy recipients.
        if (routingEnabled !== true) {
          return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
        }
        if (destinationKey.storeId !== tenantStoreId) return null;

        const recipients = await allAsync(
          `SELECT d.chat_id, d.is_enabled AS destination_enabled,
                  sub.is_enabled AS subscription_enabled,
                  sub.${eventToggle} AS event_enabled
           FROM telegram_chat_destinations d
           JOIN telegram_store_subscriptions sub
             ON sub.merchant_id=d.merchant_id AND sub.destination_id=d.id
           JOIN stores s ON s.id=sub.store_id AND s.merchant_id=sub.merchant_id
           JOIN merchants m ON m.id=d.merchant_id
           WHERE d.id=? AND d.merchant_id=? AND d.bot_profile='admin' AND d.chat_type IN ('private','group','supergroup')
             AND sub.store_id=? AND s.active=1 AND m.status=1
           LIMIT 1`,
          [destinationKey.destinationId, tenantMerchantId, tenantStoreId]
        );
        if (!Array.isArray(recipients) || !recipients.length ||
            Number(recipients[0].destination_enabled) !== 1 ||
            Number(recipients[0].subscription_enabled) !== 1 ||
            Number(recipients[0].event_enabled) !== 1) {
          return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
        }

        const credentials = await getAdminBotCredentials('merchant_store', tenantMerchantId, tenantStoreId);
        if (!credentials || credentials.suppressed) return credentials;
        const chatId = String(recipients[0].chat_id || '');
        if (!validateChatId(chatId)) {
          return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
        }
        return {
          scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId,
          destinationId: destinationKey.destinationId, token: credentials.token, chatId
        };
      }

      // After staging cutover is enabled, legacy store:<id> outbox rows must
      // never fall back to the old one-Chat-ID table or create duplicate sends.
      if (routingEnabled === true && /^store:[1-9]\d{0,18}$/.test(key)) {
        return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
      }

      // Compatibility mode: legacy queued jobs still resolve to the old
      // single-store recipient until staging explicitly enables new routing.
      if (routingEnabled !== true && /^store:[1-9]\d{0,18}$/.test(key)) {
        if (Number(key.slice(6)) !== tenantStoreId) return null;
        const recipients = await allAsync(
          `SELECT r.chat_id, r.is_enabled, r.${eventToggle} AS event_enabled
           FROM telegram_store_admin_recipients r
           JOIN stores s ON s.id=r.store_id AND s.merchant_id=r.merchant_id
           JOIN merchants m ON m.id=r.merchant_id
           WHERE r.merchant_id=? AND r.store_id=? AND s.active=1 AND m.status=1
           LIMIT 1`,
          [tenantMerchantId, tenantStoreId]
        );
        if (!Array.isArray(recipients) || !recipients.length ||
            Number(recipients[0].is_enabled) !== 1 || Number(recipients[0].event_enabled) !== 1) {
          return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
        }
        const credentials = await getAdminBotCredentials('merchant_store', tenantMerchantId, tenantStoreId);
        if (!credentials || credentials.suppressed) return credentials;
        const chatId = String(recipients[0].chat_id || '');
        if (!validateChatId(chatId)) {
          return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true };
        }
        return { scope: 'merchant_store', merchantId: tenantMerchantId, storeId: tenantStoreId, token: credentials.token, chatId };
      }
      return null;
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
    if (!Array.isArray(binding) || !binding.length) {
      return {
        scope: 'customer', merchantId: tenantMerchantId, storeId: tenantStoreId,
        suppressed: true, suppressionCode: 'binding_revoked'
      };
    }
    const settings = await allAsync(
      'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
      ['telegram_client_bot_enabled', 'telegram_client_bot_token']
    );
    const stored = Object.fromEntries((Array.isArray(settings) ? settings : []).map(row => [row.key, row.value]));
    const token = String(stored.telegram_client_bot_token || '');
    const chatId = String(binding[0].telegram_chat_id || '');
    if (stored.telegram_client_bot_enabled !== '1') {
      return { scope: 'customer', merchantId: tenantMerchantId, storeId: tenantStoreId, suppressed: true, suppressionCode: 'event_disabled' };
    }
    if (!validateBotToken(token) || !validateChatId(chatId)) return null;
    return { scope: 'customer', merchantId: tenantMerchantId, storeId: tenantStoreId, token, chatId };
  };
}

module.exports = { createTelegramNotificationRecipientResolver };
