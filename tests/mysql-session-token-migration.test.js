'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { migrateSessionTokenStorage } = require('../server/services/session-token');

const databaseUrl = process.env.MYSQL_INTEGRATION_URL;
const sessionTables = [
  'admin_sessions', 'super_sessions', 'waiter_sessions',
  'cashier_sessions', 'scan_sessions'
];

test('database integration: session token migration works with ascii_bin hashes on MariaDB and MySQL', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const connection = await mysql.createConnection(databaseUrl);
  const runAsync = async (sql, params = []) => {
    const [result] = await connection.query(sql, params);
    return result;
  };
  const allAsync = async (sql, params = []) => {
    const [rows] = await connection.query(sql, params);
    return rows;
  };
  const withTransaction = async work => {
    await connection.beginTransaction();
    try {
      const result = await work();
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  };

  t.after(async () => {
    try {
      for (const table of [...sessionTables, 'orders', 'waiter_calls', 'settings']) {
        await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
      }
    } finally {
      await connection.end();
    }
  });

  for (const table of [...sessionTables, 'orders', 'waiter_calls', 'settings']) {
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
  }

  await connection.query(`
    CREATE TABLE settings (
      \`key\` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
      value TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    ) ENGINE=InnoDB
  `);
  await connection.query(`
    CREATE TABLE orders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      session_token VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
      customer_token VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    ) ENGINE=InnoDB
  `);
  await connection.query(`
    CREATE TABLE waiter_calls (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      session_token VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    ) ENGINE=InnoDB
  `);

  for (const table of sessionTables) {
    await connection.query(`
      CREATE TABLE \`${table}\` (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        token VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
        token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        expires_at DATETIME NULL
      ) ENGINE=InnoDB
    `);
    await connection.query(
      `INSERT INTO \`${table}\` (token, token_hash) VALUES (?, NULL), (?, ?)`,
      [`legacy-${table}-token`, `legacy-${table}-already-hashed`, 'a'.repeat(64)]
    );
  }

  await connection.query(
    "INSERT INTO settings (`key`, value) VALUES ('admin_access_key', 'legacy-admin-key')"
  );
  await connection.query(
    "INSERT INTO orders (session_token, customer_token) VALUES ('legacy-order-session', 'legacy-customer-token')"
  );
  await connection.query(
    "INSERT INTO waiter_calls (session_token) VALUES ('legacy-waiter-session')"
  );

  await migrateSessionTokenStorage({ runAsync, allAsync, withTransaction });

  for (const table of sessionTables) {
    const rows = await allAsync(
      `SELECT token, token_hash FROM \`${table}\` ORDER BY id`
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].token, null, `${table}: plaintext legacy token must be cleared`);
    assert.equal(rows[0].token_hash, require('crypto').createHash('sha256').update(`legacy-${table}-token`).digest('hex'));
    assert.equal(rows[1].token, null, `${table}: existing digest row must also clear plaintext`);
    assert.equal(rows[1].token_hash, 'a'.repeat(64), `${table}: existing digest must not be overwritten`);
  }

  const [settings] = await connection.query(
    "SELECT `key`, value FROM settings WHERE `key` IN ('admin_access_key', 'admin_access_key_hash') ORDER BY `key`"
  );
  assert.equal(settings.find(row => row.key === 'admin_access_key').value, '');
  assert.match(settings.find(row => row.key === 'admin_access_key_hash').value, /^[a-f0-9]{64}$/);

  const [orders] = await connection.query('SELECT session_token, customer_token FROM orders');
  assert.match(orders[0].session_token, /^[a-f0-9]{64}$/);
  assert.match(orders[0].customer_token, /^[a-f0-9]{64}$/);
  const [waiterCalls] = await connection.query('SELECT session_token FROM waiter_calls');
  assert.match(waiterCalls[0].session_token, /^[a-f0-9]{64}$/);
});
