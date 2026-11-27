'use strict';

const MIGRATION_LEDGER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_chat_destination_migration_ledger (
    legacy_recipient_id BIGINT UNSIGNED NOT NULL,
    migrated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (legacy_recipient_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const MIGRATION_CONFLICTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_chat_destination_migration_conflicts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    legacy_recipient_id BIGINT UNSIGNED NOT NULL,
    chat_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
    legacy_merchant_id BIGINT UNSIGNED NOT NULL,
    store_id BIGINT UNSIGNED NOT NULL,
    existing_merchant_id INT DEFAULT NULL,
    reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    resolved_at DATETIME(3) DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_telegram_destination_migration_legacy_recipient (legacy_recipient_id),
    KEY idx_telegram_destination_migration_unresolved (resolved_at, reason)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

function classifyGroupChat(chatId) {
  const value = String(chatId || '').trim();
  if (!/^-\d+$/.test(value)) return null;
  return value.startsWith('-100') ? 'supergroup' : 'group';
}

async function ensureTelegramChatDestinationMigrationConflictsSchema({ runAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  await runAsync(MIGRATION_CONFLICTS_SCHEMA_SQL);
}

async function backfillTelegramStoreSubscriptions({ allAsync, getAsync, runAsync, withTransaction, logger = console }) {
  if (![allAsync, getAsync, runAsync, withTransaction].every(fn => typeof fn === 'function')) {
    throw new TypeError('allAsync, getAsync, runAsync and withTransaction are required');
  }

  await runAsync(MIGRATION_LEDGER_SCHEMA_SQL);
  await ensureTelegramChatDestinationMigrationConflictsSchema({ runAsync });
  const legacyRows = await allAsync(`
    SELECT r.id, r.merchant_id, r.store_id, r.chat_id, r.is_enabled,
           r.notify_order_created, r.notify_settled, r.notify_refunded,
           s.id AS matched_store_id
    FROM telegram_store_admin_recipients r
    LEFT JOIN stores s ON s.id=r.store_id AND s.merchant_id=r.merchant_id
    WHERE r.chat_id IS NOT NULL AND TRIM(r.chat_id)<>''
    ORDER BY r.id ASC
  `);

  const stats = { scanned: legacyRows.length, alreadyMigrated: 0, destinationsCreated: 0, subscriptionsCreated: 0, conflicts: 0 };
  for (const row of legacyRows) {
    await withTransaction(async () => {
      const migrated = await getAsync(
        'SELECT legacy_recipient_id FROM telegram_chat_destination_migration_ledger WHERE legacy_recipient_id=? FOR UPDATE',
        [Number(row.id)]
      );
      if (migrated) {
        stats.alreadyMigrated += 1;
        return;
      }

      const chatId = String(row.chat_id || '').trim();
      const chatType = classifyGroupChat(chatId);
      let reason = '';
      let existingMerchantId = null;

      if (!row.matched_store_id) reason = 'store_not_found_or_wrong_merchant';
      else if (!chatType) reason = 'invalid_group_chat_id';

      if (!reason) {
        const existingBeforeInsert = await getAsync(
          'SELECT id, merchant_id FROM telegram_chat_destinations WHERE chat_id=? FOR UPDATE',
          [chatId]
        );
        const destinationInsert = await runAsync(`
          INSERT INTO telegram_chat_destinations
            (merchant_id, bot_profile, chat_id, chat_type, title, username, is_enabled, created_at, updated_at)
          VALUES (?, 'admin', ?, ?, '', '', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)
        `, [Number(row.merchant_id), chatId, chatType]);
        if (!existingBeforeInsert && Number(destinationInsert?.affectedRows) === 1) {
          stats.destinationsCreated += 1;
        }

        const destination = await getAsync(
          'SELECT id, merchant_id FROM telegram_chat_destinations WHERE chat_id=? FOR UPDATE',
          [chatId]
        );
        existingMerchantId = destination ? Number(destination.merchant_id) : null;

        if (!destination) reason = 'destination_insert_not_visible';
        else if (existingMerchantId !== Number(row.merchant_id)) reason = 'chat_owned_by_another_merchant';
        else {
          const result = await runAsync(`
            INSERT INTO telegram_store_subscriptions
              (merchant_id, destination_id, store_id, is_enabled,
               notify_order_created, notify_settled, notify_refunded, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)
          `, [
            Number(row.merchant_id),
            Number(destination.id),
            Number(row.store_id),
            Number(row.is_enabled) ? 1 : 0,
            Number(row.notify_order_created) ? 1 : 0,
            Number(row.notify_settled) ? 1 : 0,
            Number(row.notify_refunded) ? 1 : 0
          ]);
          if (Number(result?.affectedRows) === 1) stats.subscriptionsCreated += 1;
          await runAsync(
            'INSERT INTO telegram_chat_destination_migration_ledger (legacy_recipient_id, migrated_at) VALUES (?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE legacy_recipient_id=VALUES(legacy_recipient_id)',
            [Number(row.id)]
          );
          await runAsync(
            'UPDATE telegram_chat_destination_migration_conflicts SET resolved_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE legacy_recipient_id=? AND resolved_at IS NULL',
            [Number(row.id)]
          );
          return;
        }
      }

      stats.conflicts += 1;
      await runAsync(`
        INSERT INTO telegram_chat_destination_migration_conflicts
          (legacy_recipient_id, chat_id, legacy_merchant_id, store_id, existing_merchant_id, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          chat_id=VALUES(chat_id),
          legacy_merchant_id=VALUES(legacy_merchant_id),
          store_id=VALUES(store_id),
          existing_merchant_id=VALUES(existing_merchant_id),
          reason=VALUES(reason),
          resolved_at=NULL,
          updated_at=UTC_TIMESTAMP(3)
      `, [
        Number(row.id), chatId, Number(row.merchant_id), Number(row.store_id),
        existingMerchantId, reason
      ]);
    });
  }

  if (logger?.info && stats.scanned > 0) {
    logger.info('[telegram-destination-migration] legacy recipient backfill complete', stats);
  }
  return stats;
}

module.exports = {
  MIGRATION_LEDGER_SCHEMA_SQL,
  MIGRATION_CONFLICTS_SCHEMA_SQL,
  classifyGroupChat,
  ensureTelegramChatDestinationMigrationConflictsSchema,
  backfillTelegramStoreSubscriptions
};
