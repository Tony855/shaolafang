'use strict';

const ROUTING_FLAG_NAME = 'TELEGRAM_GROUP_SUBSCRIPTIONS_ROUTING_ENABLED';

function isTelegramGroupSubscriptionsRoutingEnabled(value) {
  const configured = arguments.length === 0 ? process.env[ROUTING_FLAG_NAME] : value;
  return typeof configured === 'string' && configured.trim().toLowerCase() === 'true';
}

function buildTelegramDestinationRecipientKey(destinationId, storeId) {
  const destination = Number(destinationId);
  const store = Number(storeId);
  if (!Number.isSafeInteger(destination) || destination <= 0 || !Number.isSafeInteger(store) || store <= 0) {
    throw new TypeError('Telegram 群组或门店编号无效');
  }
  return `destination:${destination}:store:${store}`;
}

function parseTelegramDestinationRecipientKey(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^destination:([1-9]\d{0,18}):store:([1-9]\d{0,18})$/);
  if (!match) return null;
  const destinationId = Number(match[1]);
  const storeId = Number(match[2]);
  if (!Number.isSafeInteger(destinationId) || !Number.isSafeInteger(storeId)) return null;
  return { destinationId, storeId };
}

function buildTelegramDestinationEventKey(eventKey, destinationId) {
  if (typeof eventKey !== 'string') throw new TypeError('通知幂等键无效');
  const destination = Number(destinationId);
  if (!Number.isSafeInteger(destination) || destination <= 0) throw new TypeError('Telegram 群组编号无效');
  const key = `${eventKey}:destination:${destination}`;
  if (key.length > 160) throw new TypeError('Telegram 群组通知幂等键过长');
  return key;
}

module.exports = {
  ROUTING_FLAG_NAME,
  isTelegramGroupSubscriptionsRoutingEnabled,
  buildTelegramDestinationRecipientKey,
  parseTelegramDestinationRecipientKey,
  buildTelegramDestinationEventKey
};
