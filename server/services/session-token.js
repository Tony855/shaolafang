'use strict';

const crypto = require('crypto');

// Session tokens are high-entropy random bearer credentials. Persist only their
// SHA-256 digest; never log or return this digest as a credential.
function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function migrateSessionTokenStorage({ runAsync, allAsync, withTransaction }) {
  if (typeof runAsync !== 'function' || typeof allAsync !== 'function' || typeof withTransaction !== 'function') {
    throw new TypeError('runAsync, allAsync, and withTransaction are required');
  }

  const sessionTables = [
    'admin_sessions',
    'super_sessions',
    'waiter_sessions',
    'cashier_sessions',
    'scan_sessions'
  ];

  for (const table of sessionTables) {
    const columns = await allAsync(
      'SELECT COLUMN_NAME AS Field, IS_NULLABLE AS `Null` FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
      [table]
    );
    const names = new Set(columns.map(column => column.Field));
    if (!names.has('token_hash')) {
      await runAsync(`ALTER TABLE \`${table}\` ADD COLUMN token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL`);
    }

    const tokenColumn = columns.find(column => column.Field === 'token');
    if (tokenColumn && String(tokenColumn.Null).toUpperCase() === 'NO') {
      // Keep the legacy column nullable during rolling upgrades; all new writes
      // leave it NULL and use the unique digest column.
      await runAsync(`ALTER TABLE \`${table}\` MODIFY token VARCHAR(255) NULL`);
    }

    const indexes = await allAsync(
      'SELECT INDEX_NAME AS Key_name, NON_UNIQUE AS Non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
      [table]
    );
    const indexName = `uq_${table}_token_hash`;
    if (!indexes.some(index => index.Key_name === indexName && Number(index.Non_unique) === 0)) {
      await runAsync(`CREATE UNIQUE INDEX \`${indexName}\` ON \`${table}\` (token_hash)`);
    }


  }

  // Migrate session rows and their historical order references atomically. The
  // settings marker avoids rescanning large order tables on every application boot.
  const referenceMigration = await allAsync(
    "SELECT value FROM settings WHERE `key`=? LIMIT 1",
    ['session_token_references_hashed_v1']
  );
  const needsReferenceMigration = !referenceMigration.length;

  await withTransaction(async () => {
    // The legacy integration key is also a bearer credential. Hash and clear
    // any configured plaintext value under a row lock so concurrent app
    // instances cannot race the one-time migration or lose a key rotation.
    const adminKeyRows = await allAsync(
      "SELECT `key`, value FROM settings WHERE `key` IN (?, ?) FOR UPDATE",
      ['admin_access_key', 'admin_access_key_hash']
    );
    const legacyAdminKey = adminKeyRows.find(row => row.key === 'admin_access_key')?.value;
    if (typeof legacyAdminKey === 'string' && legacyAdminKey.length > 0) {
      await runAsync(
        "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        ['admin_access_key_hash', hashSessionToken(legacyAdminKey)]
      );
      await runAsync(
        "UPDATE settings SET value='' WHERE `key`='admin_access_key' AND value=?",
        [legacyAdminKey]
      );
    }

    for (const table of sessionTables) {
      await runAsync(
        `UPDATE \`${table}\` SET token_hash=COALESCE(NULLIF(token_hash, ''), SHA2(token, 256)), token=NULL WHERE token IS NOT NULL AND token<>''`
      );
    }

    if (needsReferenceMigration) {
      await runAsync(
        "UPDATE orders SET session_token=SHA2(session_token, 256) WHERE session_token IS NOT NULL AND session_token<>'' AND CHAR_LENGTH(session_token)<>64"
      );
      await runAsync(
        "UPDATE orders SET customer_token=SHA2(customer_token, 256) WHERE customer_token IS NOT NULL AND customer_token<>'' AND CHAR_LENGTH(customer_token)<>64"
      );
      await runAsync(
        "UPDATE waiter_calls SET session_token=SHA2(session_token, 256) WHERE session_token IS NOT NULL AND session_token<>'' AND CHAR_LENGTH(session_token)<>64"
      );
      await runAsync(
        "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        ['session_token_references_hashed_v1', new Date().toISOString()]
      );
    }
  });
}

module.exports = { hashSessionToken, migrateSessionTokenStorage };
