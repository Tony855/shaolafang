'use strict';

async function enqueueSystemAdminTelegramNotification({ getAsync, eventKey, event, enqueue } = {}) {
  if (typeof getAsync !== 'function') throw new TypeError('getAsync is required');
  // Lock the setting row so a concurrent Bot-disable transaction either sees
  // this enqueue and dead-letters it, or commits first and prevents the enqueue.
  const setting = await getAsync("SELECT value FROM settings WHERE `key`=? FOR UPDATE", ['telegram_admin_bot_enabled']);
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

  // Use one stable lock order (global setting -> merchant -> store -> binding
  // -> outbox) shared with the settings/suspension/revocation transactions.
  const settings = await allAsync('SELECT `key`, value FROM settings WHERE `key` IN (?, ?) ORDER BY `key` FOR UPDATE', ['telegram_admin_bot_enabled', 'telegram_client_bot_enabled']);
  const clientBot = Array.isArray(settings) ? settings.find(row => row.key === 'telegram_client_bot_enabled') : null;
  if (clientBot?.value !== '1') return false;
  const merchants = await allAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchant]);
  if (!Array.isArray(merchants) || !merchants.length) return false;
  const stores = await allAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [store, merchant]);
  if (!Array.isArray(stores) || !stores.length) return false;
  const bindings = await allAsync(
    'SELECT id FROM telegram_customer_bindings WHERE customer_token_hash=? AND merchant_id=? AND store_id=? AND is_active=1 AND revoked_at IS NULL LIMIT 1 FOR UPDATE',
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

async function enqueueStoreAdminTelegramNotification({ allAsync, merchantId, storeId, eventKey, event, enqueue } = {}) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');
  const merchant = Number(merchantId);
  const store = Number(storeId);
  if (!Number.isSafeInteger(merchant) || merchant <= 0 || !Number.isSafeInteger(store) || store <= 0) return false;
  const toggleByEvent = { 'order.created': 'notify_order_created', 'order.settled': 'notify_settled', 'order.refunded': 'notify_refunded' };
  const toggle = toggleByEvent[event?.type];
  if (!toggle) return false;

  // Lock the same setting/tenant/recipient rows that the disable route updates.
  // This prevents an enqueue racing past a disable-and-re-enable cycle.
  const settings = await allAsync('SELECT `key`, value FROM settings WHERE `key` IN (?, ?) ORDER BY `key` FOR UPDATE', ['telegram_admin_bot_enabled', 'telegram_client_bot_enabled']);
  const adminBot = Array.isArray(settings) ? settings.find(row => row.key === 'telegram_admin_bot_enabled') : null;
  if (adminBot?.value !== '1') return false;
  const merchants = await allAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchant]);
  if (!Array.isArray(merchants) || !merchants.length) return false;
  const stores = await allAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [store, merchant]);
  if (!Array.isArray(stores) || !stores.length) return false;
  const recipients = await allAsync(
    `SELECT id FROM telegram_store_admin_recipients WHERE merchant_id=? AND store_id=? AND is_enabled=1 AND ${toggle}=1 LIMIT 1 FOR UPDATE`,
    [merchant, store]
  );
  if (!Array.isArray(recipients) || !recipients.length) return false;
  const enqueueNotification = enqueue || require('./telegram-notification-outbox').enqueueTelegramNotification;
  await enqueueNotification({ eventKey, recipientScope: 'merchant_store', recipientKey: `store:${store}`, merchantId: merchant, storeId: store, event });
  return true;
}

module.exports = { enqueueSystemAdminTelegramNotification, enqueueCustomerTelegramNotification, enqueueStoreAdminTelegramNotification };
