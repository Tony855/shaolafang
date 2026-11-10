'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { hashSessionToken, migrateSessionTokenStorage } = require('../server/services/session-token');

test('session bearer tokens are represented by deterministic SHA-256 digests', () => {
  const token = 'opaque-random-session-token';
  const digest = hashSessionToken(token);
  assert.equal(digest, crypto.createHash('sha256').update(token).digest('hex'));
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(hashSessionToken(token), digest);
  assert.notEqual(digest, token);
  assert.equal(hashSessionToken(''), '');
  assert.equal(hashSessionToken(null), '');
});

test('session storage migration adds unique digest columns and clears legacy credentials', async () => {
  const writes = [];
  const queries = [];
  const runAsync = async sql => { writes.push(sql); return { affectedRows: 1 }; };
  let transactionCount = 0;
  const withTransaction = async work => { transactionCount++; return work(); };
  const allAsync = async sql => {
    queries.push(sql);
    if (sql.includes('information_schema.COLUMNS')) return [{ Field: 'token', Null: 'NO' }, { Field: 'expires_at', Null: 'NO' }];
    if (sql.includes('information_schema.STATISTICS')) return [];
    if (sql.startsWith('SELECT value FROM settings')) return [];
    throw new Error('unexpected metadata query: ' + sql);
  };

  await migrateSessionTokenStorage({ runAsync, allAsync, withTransaction });
  assert.equal(transactionCount, 1);

  for (const table of ['admin_sessions', 'super_sessions', 'waiter_sessions', 'cashier_sessions', 'scan_sessions']) {
    assert.ok(writes.some(sql => sql.includes(`ALTER TABLE \`${table}\` ADD COLUMN token_hash CHAR(64)`)), table);
    assert.ok(writes.some(sql => sql.includes(`ALTER TABLE \`${table}\` MODIFY token VARCHAR(255) NULL`)), table);
    assert.ok(writes.some(sql => sql.includes(`CREATE UNIQUE INDEX \`uq_${table}_token_hash\``)), table);
    assert.ok(writes.some(sql => sql.includes(`UPDATE \`${table}\` SET token_hash=`)), table);
  }
  assert.ok(writes.some(sql => sql.includes('UPDATE orders SET session_token=SHA2(session_token, 256)')));
  assert.ok(writes.some(sql => sql.includes('UPDATE orders SET customer_token=SHA2(customer_token, 256)')));
  assert.ok(writes.some(sql => sql.includes('UPDATE waiter_calls SET session_token=SHA2(session_token, 256)')));
});

test('session storage migration is safe to rerun after digest columns and indexes exist', async () => {
  const writes = [];
  const runAsync = async sql => { writes.push(sql); return { affectedRows: 0 }; };
  let transactionCount = 0;
  const withTransaction = async work => { transactionCount++; return work(); };
  const allAsync = async (sql, params = []) => {
    if (sql.includes('information_schema.COLUMNS')) return [
      { Field: 'token', Null: 'YES' },
      { Field: 'token_hash', Null: 'YES' },
      { Field: 'expires_at', Null: 'NO' }
    ];
    if (sql.startsWith('SHOW INDEX')) {
      const table = sql.match(/FROM `([^\`]+)`/)[1];
      return [{ Key_name: `uq_${table}_token_hash`, Non_unique: 0 }];
    }
    throw new Error('unexpected metadata query: ' + sql);
  };

  await migrateSessionTokenStorage({ runAsync, allAsync, withTransaction });
  assert.equal(transactionCount, 1);
  assert.equal(writes.some(sql => /ADD COLUMN token_hash/.test(sql)), false);
  assert.equal(writes.some(sql => /MODIFY token VARCHAR/.test(sql)), false);
  assert.equal(writes.some(sql => /CREATE UNIQUE INDEX/.test(sql)), false);
  assert.equal(writes.filter(sql => sql.startsWith('UPDATE')).length, 5);
});
