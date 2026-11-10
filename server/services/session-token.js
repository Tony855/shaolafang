'use strict';

const crypto = require('crypto');

// Session tokens are high-entropy random bearer credentials. Persist only their
// SHA-256 digest; never log or return this digest as a credential.
function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function migrateSessionTokenStorage({ runAsync, allAsync }) {
  if (typeof runAsync !== 'function' || typeof allAsync !== 'function') {
    throw new TypeError('runAsync and allAsync are required');
  }

  const sessionTables = [
    'admin_sessions',
    'super_sessions',
    'waiter_sessions',
    'cashier_sessions',
    'scan_sessions'
  ];

  for (const table of sessionTables) {
    const columns = await allAsync(`SHOW COLUMNS FROM \`${table}\``);
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

    const indexes = await allAsync(`SHOW INDEX FROM \`${table}\``);
    const indexName = `uq_${table}_token_hash`;
    if (!indexes.some(index => index.Key_name === indexName && Number(index.Non_unique) === 0)) {
      await runAsync(`CREATE UNIQUE INDEX \`${indexName}\` ON \`${table}\` (token_hash)`);
    }

    // One-time, idempotent migration: existing clients keep their active token,
    // while the database retains only its digest after this statement commits.
    await runAsync(
      `UPDATE \`${table}\` SET token_hash=SHA2(token, 256), token=NULL WHERE token IS NOT NULL AND token<>'' AND (token_hash IS NULL OR token_hash='')`
    );
  }

  // These historical columns are used only as stable order/customer grouping
  // identifiers. Hash them too so old database copies cannot replay credentials.
  await runAsync(
    "UPDATE orders SET session_token=SHA2(session_token, 256) WHERE session_token IS NOT NULL AND session_token<>'' AND CHAR_LENGTH(session_token)<>64"
  );
  await runAsync(
    "UPDATE orders SET customer_token=SHA2(customer_token, 256) WHERE customer_token IS NOT NULL AND customer_token<>'' AND CHAR_LENGTH(customer_token)<>64"
  );
  await runAsync(
    "UPDATE waiter_calls SET session_token=SHA2(session_token, 256) WHERE session_token IS NOT NULL AND session_token<>'' AND CHAR_LENGTH(session_token)<>64"
  );
}

module.exports = { hashSessionToken, migrateSessionTokenStorage };
