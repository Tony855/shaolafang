'use strict';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS telegram_customer_binding_challenges (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    challenge_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    customer_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    merchant_id BIGINT UNSIGNED NOT NULL,
    store_id BIGINT UNSIGNED NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    consumed_at DATETIME(3) DEFAULT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_customer_challenge_hash (challenge_hash),
    KEY idx_telegram_customer_challenge_owner (customer_token_hash, store_id, expires_at),
    KEY idx_telegram_customer_challenge_expiry (expires_at, consumed_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS telegram_customer_bindings (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    customer_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    merchant_id BIGINT UNSIGNED NOT NULL,
    store_id BIGINT UNSIGNED NOT NULL,
    telegram_user_id BIGINT UNSIGNED NOT NULL,
    telegram_chat_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_customer_binding_chat (telegram_chat_id),
    UNIQUE KEY uq_telegram_customer_binding_owner (customer_token_hash, store_id),
    KEY idx_telegram_customer_binding_tenant (merchant_id, store_id, is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
    update_id BIGINT UNSIGNED NOT NULL,
    received_at DATETIME(3) NOT NULL,
    PRIMARY KEY (update_id),
    KEY idx_telegram_webhook_received (received_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function ensureTelegramCustomerBindingSchema({ runAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  for (const statement of SCHEMA_STATEMENTS) await runAsync(statement);
}

module.exports = { SCHEMA_STATEMENTS, ensureTelegramCustomerBindingSchema };
