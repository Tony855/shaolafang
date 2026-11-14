'use strict';

async function enqueueSystemAdminTelegramNotification({ getAsync, eventKey, event, enqueue } = {}) {
  if (typeof getAsync !== 'function') throw new TypeError('getAsync is required');
  const setting = await getAsync("SELECT value FROM settings WHERE `key`=?", ['telegram_admin_bot_enabled']);
  if (String(setting?.value || '') !== '1') return false;
  const enqueueNotification = enqueue || require('./telegram-notification-outbox').enqueueTelegramNotification;
  await enqueueNotification({
    eventKey,
    recipientScope: 'system_admin',
    recipientKey: 'admin:primary',
    event
  });
  return true;
}


async function enqueueCustomerTelegramNotification({ allAsync, customerTokenHash, merchantId, storeId, eventKey, event, enqueue } = {}) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');
  if (typeof customerTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(customerTokenHash)) return false;
  const merchant = Number(merchantId);
  const store = Number(storeId);
  if (!Number.isSafeInteger(merchant) || merchant <= 0 || !Number.isSafeInteger(store) || store <= 0) return false;
  const settings = await allAsync('SELECT `key`, value FROM settings WHERE `key`=?', ['telegram_client_bot_enabled']);
  if (!Array.isArray(settings) || settings[0]?.value !== '1') return false;
  const bindings = await allAsync(
    'SELECT b.id FROM telegram_customer_bindings b JOIN stores s ON s.id=b.store_id AND s.merchant_id=b.merchant_id JOIN merchants m ON m.id=b.merchant_id WHERE b.customer_token_hash=? AND b.merchant_id=? AND b.store_id=? AND b.is_active=1 AND b.revoked_at IS NULL AND s.active=1 AND m.status=1 LIMIT 1',
    [customerTokenHash, merchant, store]
  );
  if (!Array.isArray(bindings) || !bindings.length) return false;
  const enqueueNotification = enqueue || require('./telegram-notification-outbox').enqueueTelegramNotification;
  await enqueueNotification({
    eventKey,
    recipientScope: 'customer',
    recipientKey: `binding:${Number(bindings[0].id)}`,
    merchantId: merchant,
    storeId: store,
    event
  });
  return true;
}

module.exports = { enqueueSystemAdminTelegramNotification, enqueueCustomerTelegramNotification };
