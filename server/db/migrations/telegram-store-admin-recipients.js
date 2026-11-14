'use strict';

const STORE_ADMIN_RECIPIENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_store_admin_recipients (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    merchant_id BIGINT UNSIGNED NOT NULL,
    store_id BIGINT UNSIGNED NOT NULL,
    chat_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    is_enabled TINYINT(1) NOT NULL DEFAULT 0,
    notify_order_created TINYINT(1) NOT NULL DEFAULT 1,
    notify_settled TINYINT(1) NOT NULL DEFAULT 1,
    notify_refunded TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_store_admin_recipient (merchant_id, store_id),
    KEY idx_telegram_store_admin_enabled (merchant_id, store_id, is_enabled)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function ensureTelegramStoreAdminRecipientSchema({ runAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  await runAsync(STORE_ADMIN_RECIPIENT_SCHEMA_SQL);
}

module.exports = { STORE_ADMIN_RECIPIENT_SCHEMA_SQL, ensureTelegramStoreAdminRecipientSchema };
