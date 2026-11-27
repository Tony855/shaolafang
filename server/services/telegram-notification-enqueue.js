'use strict';

const {
  isTelegramGroupSubscriptionsRoutingEnabled,
  buildTelegramDestinationRecipientKey,
  buildTelegramDestinationEventKey
} = require('./telegram-notification-routing');

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

async function enqueueStoreAdminTelegramNotification({
  allAsync, merchantId, storeId, eventKey, event, enqueue,
  routingEnabled = isTelegramGroupSubscriptionsRoutingEnabled()
} = {}) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');
  const merchant = Number(merchantId);
  const store = Number(storeId);
  if (!Number.isSafeInteger(merchant) || merchant <= 0 || !Number.isSafeInteger(store) || store <= 0) return false;
  const toggleByEvent = { 'order.created': 'notify_order_created', 'order.settled': 'notify_settled', 'order.refunded': 'notify_refunded' };
  const toggle = toggleByEvent[event?.type];
  if (!toggle) return false;

  // Keep the same global lock order as Bot suspension and customer opt-out.
  // Store -> destination -> subscription -> outbox is shared with the
  // subscription settings routes and the worker's irreversible-send boundary.
  const settings = await allAsync('SELECT `key`, value FROM settings WHERE `key` IN (?, ?) ORDER BY `key` FOR UPDATE', ['telegram_admin_bot_enabled', 'telegram_client_bot_enabled']);
  const adminBot = Array.isArray(settings) ? settings.find(row => row.key === 'telegram_admin_bot_enabled') : null;
  if (adminBot?.value !== '1') return false;
  const merchants = await allAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchant]);
  if (!Array.isArray(merchants) || !merchants.length) return false;
  const stores = await allAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [store, merchant]);
  if (!Array.isArray(stores) || !stores.length) return false;

  if (routingEnabled === true) {
    // First read candidate IDs without locking. All writes then lock store,
    // destinations in ascending ID order, subscriptions, and finally outbox.
    const candidates = await allAsync(
      `SELECT destination_id FROM telegram_store_subscriptions
       WHERE merchant_id=? AND store_id=? AND is_enabled=1 AND ${toggle}=1
       ORDER BY destination_id`,
      [merchant, store]
    );
    const candidateIds = [...new Set((Array.isArray(candidates) ? candidates : [])
      .map(row => Number(row.destination_id))
      .filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!candidateIds.length) return false;

    const placeholders = candidateIds.map(() => '?').join(',');
    const destinations = await allAsync(
      `SELECT id FROM telegram_chat_destinations
       WHERE merchant_id=? AND id IN (${placeholders}) AND bot_profile='admin'
         AND chat_type IN ('group','supergroup') AND is_enabled=1
       ORDER BY id FOR UPDATE`,
      [merchant, ...candidateIds]
    );
    const destinationIds = [...new Set((Array.isArray(destinations) ? destinations : [])
      .map(row => Number(row.id))
      .filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!destinationIds.length) return false;

    const destinationPlaceholders = destinationIds.map(() => '?').join(',');
    const subscriptions = await allAsync(
      `SELECT id, destination_id FROM telegram_store_subscriptions
       WHERE merchant_id=? AND store_id=? AND destination_id IN (${destinationPlaceholders})
         AND is_enabled=1 AND ${toggle}=1
       ORDER BY destination_id FOR UPDATE`,
      [merchant, store, ...destinationIds]
    );
    if (!Array.isArray(subscriptions) || !subscriptions.length) return false;
    const enqueueNotification = enqueue || require('./telegram-notification-outbox').enqueueTelegramNotification;

    for (const subscription of subscriptions) {
      const destinationId = Number(subscription.destination_id);
      await enqueueNotification({
        eventKey: buildTelegramDestinationEventKey(eventKey, destinationId),
        recipientScope: 'merchant_store',
        recipientKey: buildTelegramDestinationRecipientKey(destinationId, store),
        merchantId: merchant,
        storeId: store,
        event
      });
    }
    return true;
  }

  // Compatibility mode: until the staging flag is enabled, keep the old
  // single-Chat-ID recipient path unchanged.
  const recipients = await allAsync(
    `SELECT id FROM telegram_store_admin_recipients
     WHERE merchant_id=? AND store_id=? AND chat_id<>'' AND ${toggle}=1 LIMIT 1 FOR UPDATE`,
    [merchant, store]
  );
  if (!Array.isArray(recipients) || !recipients.length) return false;
  const enqueueNotification = enqueue || require('./telegram-notification-outbox').enqueueTelegramNotification;
  await enqueueNotification({
    eventKey, recipientScope: 'merchant_store', recipientKey: `store:${store}`,
    merchantId: merchant, storeId: store, event
  });
  return true;
}
module.exports = { enqueueCustomerTelegramNotification, enqueueStoreAdminTelegramNotification };
