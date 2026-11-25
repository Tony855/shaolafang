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
    UNIQUE KEY uq_telegram_customer_binding_chat_store (telegram_chat_id, store_id),
    UNIQUE KEY uq_telegram_customer_binding_owner (customer_token_hash, store_id),
    KEY idx_telegram_customer_binding_tenant (merchant_id, store_id, is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
    merchant_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
    update_id BIGINT UNSIGNED NOT NULL,
    received_at DATETIME(3) NOT NULL,
    PRIMARY KEY (merchant_id, update_id),
    KEY idx_telegram_webhook_received (received_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function ensureTelegramWebhookUpdateTenantKey({ runAsync, getAsync }) {
  if (typeof runAsync !== 'function' || typeof getAsync !== 'function') throw new TypeError('runAsync and getAsync are required');
  const columns = await getAsync(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
    ['telegram_webhook_updates']
  );
  const names = new Set((Array.isArray(columns) ? columns : []).map(row => String(row.COLUMN_NAME || row.column_name)));
  if (!names.has('merchant_id')) {
    await runAsync('ALTER TABLE telegram_webhook_updates ADD COLUMN merchant_id BIGINT UNSIGNED NOT NULL DEFAULT 0 FIRST');
  }
  const indexes = await getAsync(
    'SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? ORDER BY SEQ_IN_INDEX',
    ['telegram_webhook_updates', 'PRIMARY']
  );
  const primary = Array.isArray(indexes) ? indexes : [];
  if (!(primary.length === 2 && String(primary[0].COLUMN_NAME || primary[0].column_name) === 'merchant_id' &&
      String(primary[1].COLUMN_NAME || primary[1].column_name) === 'update_id')) {
    await runAsync('ALTER TABLE telegram_webhook_updates DROP PRIMARY KEY, ADD PRIMARY KEY (merchant_id, update_id)');
  }
}

async function ensureTelegramCustomerBindingSchema({ runAsync, getAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  for (const statement of SCHEMA_STATEMENTS) await runAsync(statement);
  if (typeof getAsync === 'function') await ensureTelegramWebhookUpdateTenantKey({ runAsync, getAsync });
}

module.exports = { SCHEMA_STATEMENTS, ensureTelegramCustomerBindingSchema, ensureTelegramWebhookUpdateTenantKey };
