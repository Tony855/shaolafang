'use strict';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS telegram_merchant_bots (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    merchant_id BIGINT UNSIGNED NOT NULL,
    client_bot_token_encrypted TEXT DEFAULT NULL,
    client_bot_token_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
    client_bot_id BIGINT UNSIGNED DEFAULT NULL,
    client_bot_username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
    client_bot_enabled TINYINT(1) NOT NULL DEFAULT 0,
    admin_bot_token_encrypted TEXT DEFAULT NULL,
    admin_bot_token_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
    admin_bot_id BIGINT UNSIGNED DEFAULT NULL,
    admin_bot_username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
    admin_bot_enabled TINYINT(1) NOT NULL DEFAULT 0,
    webhook_path_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    webhook_secret_encrypted TEXT DEFAULT NULL,
    key_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_merchant_bots_merchant (merchant_id),
    UNIQUE KEY uq_telegram_merchant_bots_path (webhook_path_hash),
    UNIQUE KEY uq_telegram_merchant_bots_client_fp (client_bot_token_fingerprint),
    UNIQUE KEY uq_telegram_merchant_bots_admin_fp (admin_bot_token_fingerprint),
    KEY idx_telegram_merchant_bots_client_status (client_bot_enabled, merchant_id),
    KEY idx_telegram_merchant_bots_admin_status (admin_bot_enabled, merchant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS telegram_merchant_webhook_updates (
    bot_config_id BIGINT UNSIGNED NOT NULL,
    update_id BIGINT UNSIGNED NOT NULL,
    received_at DATETIME(3) NOT NULL,
    PRIMARY KEY (bot_config_id, update_id),
    KEY idx_telegram_merchant_webhook_received (received_at),
    CONSTRAINT fk_telegram_merchant_webhook_bot
      FOREIGN KEY (bot_config_id) REFERENCES telegram_merchant_bots(id)
      ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function ensureTelegramMerchantBotSchema({ runAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  for (const statement of SCHEMA_STATEMENTS) await runAsync(statement);
}

module.exports = { SCHEMA_STATEMENTS, ensureTelegramMerchantBotSchema };
