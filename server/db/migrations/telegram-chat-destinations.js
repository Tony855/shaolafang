'use strict';

const TELEGRAM_CHAT_DESTINATIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_chat_destinations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    bot_profile VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'admin',
    chat_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    chat_type ENUM('private', 'group', 'supergroup') NOT NULL,
    title VARCHAR(255) NOT NULL DEFAULT '',
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_chat_destination_chat_id (chat_id),
    UNIQUE KEY uq_telegram_chat_destination_merchant_id (merchant_id, id),
    KEY idx_telegram_chat_destination_merchant_enabled (merchant_id, is_enabled),
    CONSTRAINT fk_telegram_chat_destination_merchant
      FOREIGN KEY (merchant_id) REFERENCES merchants (id)
      ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_store_subscriptions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    destination_id BIGINT UNSIGNED NOT NULL,
    store_id INT NOT NULL,
    is_enabled TINYINT(1) NOT NULL DEFAULT 1,
    notify_order_created TINYINT(1) NOT NULL DEFAULT 1,
    notify_settled TINYINT(1) NOT NULL DEFAULT 1,
    notify_refunded TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_store_subscription_destination_store (destination_id, store_id),
    KEY idx_telegram_store_subscription_scope (merchant_id, store_id, is_enabled),
    KEY idx_telegram_store_subscription_destination (merchant_id, destination_id, is_enabled),
    CONSTRAINT fk_telegram_store_subscription_destination
      FOREIGN KEY (merchant_id, destination_id)
      REFERENCES telegram_chat_destinations (merchant_id, id)
      ON DELETE CASCADE,
    CONSTRAINT fk_telegram_store_subscription_store
      FOREIGN KEY (merchant_id, store_id)
      REFERENCES stores (merchant_id, id)
      ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function ensureTelegramChatDestinationSchema({ runAsync, getAsync }) {
  if (typeof runAsync !== 'function' || typeof getAsync !== 'function') throw new TypeError('runAsync and getAsync are required');

  // MySQL requires a matching unique index for the composite store FK. The
  // store ID remains globally unique; this index exists to enforce tenant scope.
  try {
    await runAsync('ALTER TABLE stores ADD UNIQUE KEY uq_telegram_store_merchant_id (merchant_id, id)');
  } catch (error) {
    if (!/duplicate key name|already exists/i.test(error?.message || '')) throw error;
  }

  await runAsync(TELEGRAM_CHAT_DESTINATIONS_SCHEMA_SQL);
  await runAsync(TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL);

  // CREATE TABLE IF NOT EXISTS does not widen an existing ENUM. Upgrade old
  // group-only installations idempotently without running a destructive rebuild.
  const column = await getAsync(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='telegram_chat_destinations' AND COLUMN_NAME='chat_type'"
  );
  const columnType = String(column?.COLUMN_TYPE || column?.column_type || '');
  if (!columnType.toLowerCase().includes("'private'")) {
    await runAsync("ALTER TABLE telegram_chat_destinations MODIFY chat_type ENUM('private','group','supergroup') NOT NULL");
  }
}

module.exports = {
  TELEGRAM_CHAT_DESTINATIONS_SCHEMA_SQL,
  TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL,
  ensureTelegramChatDestinationSchema
};
