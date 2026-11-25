'use strict';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS telegram_tenant_client_bots (
    merchant_id BIGINT UNSIGNED NOT NULL,
    bot_token VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    bot_username VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
    is_enabled TINYINT(1) NOT NULL DEFAULT 0,
    webhook_path_token CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    webhook_secret VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (merchant_id),
    UNIQUE KEY uq_telegram_tenant_bot_token (bot_token),
    UNIQUE KEY uq_telegram_tenant_bot_username (bot_username),
    UNIQUE KEY uq_telegram_tenant_webhook_path (webhook_path_token),
    KEY idx_telegram_tenant_bot_enabled (is_enabled, merchant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function ensureTelegramTenantClientBotSchema({ runAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  for (const statement of SCHEMA_STATEMENTS) await runAsync(statement);
}

module.exports = { SCHEMA_STATEMENTS, ensureTelegramTenantClientBotSchema };
