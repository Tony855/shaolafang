'use strict';

const OUTBOX_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    event_key VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    merchant_id BIGINT UNSIGNED DEFAULT NULL,
    store_id BIGINT UNSIGNED DEFAULT NULL,
    recipient_scope ENUM('system_admin','merchant_store','customer') NOT NULL,
    recipient_key VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload_json JSON NOT NULL,
    state ENUM('pending','processing','delivered','dead') NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    available_at DATETIME(3) NOT NULL,
    locked_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
    locked_until DATETIME(3) DEFAULT NULL,
    delivered_at DATETIME(3) DEFAULT NULL,
    last_error_code VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_outbox_event (event_key),
    KEY idx_telegram_outbox_claim (state, available_at, locked_until, id),
    KEY idx_telegram_outbox_tenant (merchant_id, store_id, created_at),
    KEY idx_telegram_outbox_recipient (recipient_scope, recipient_key, state)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

async function ensureTelegramNotificationOutboxSchema({ runAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  await runAsync(OUTBOX_SCHEMA_SQL);
}

module.exports = { OUTBOX_SCHEMA_SQL, ensureTelegramNotificationOutboxSchema };
