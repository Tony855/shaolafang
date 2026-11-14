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
  const writeParams = [];
  const queries = [];
  const runAsync = async (sql, params = []) => { writes.push(sql); writeParams.push(params); return { affectedRows: 1 }; };
  let transactionCount = 0;
  const withTransaction = async work => { transactionCount++; return work(); };
  const allAsync = async sql => {
    queries.push(sql);
    if (sql.includes('information_schema.COLUMNS')) return [{ Field: 'token', Null: 'NO' }, { Field: 'expires_at', Null: 'NO' }];
    if (sql.includes('information_schema.STATISTICS')) return [];
    if (sql.startsWith('SELECT `key`, value FROM settings')) return [{ key: 'admin_access_key', value: 'legacy-integration-secret' }];
    if (sql.startsWith('SELECT value FROM settings')) return [];
    throw new Error('unexpected metadata query: ' + sql);
  };

  await migrateSessionTokenStorage({ runAsync, allAsync, withTransaction });
  assert.equal(transactionCount, 1);

  for (const table of ['admin_sessions', 'super_sessions', 'waiter_sessions', 'cashier_sessions', 'scan_sessions']) {
    assert.ok(writes.some(sql => sql.includes(`ALTER TABLE \`${table}\` ADD COLUMN token_hash CHAR(64)`)), table);
    assert.ok(writes.some(sql => sql.includes(`ALTER TABLE \`${table}\` MODIFY token VARCHAR(255) NULL`)), table);
    assert.ok(writes.some(sql => sql.includes(`CREATE UNIQUE INDEX \`uq_${table}_token_hash\``)), table);
    assert.ok(writes.some(sql => sql.includes(`UPDATE \`${table}\` SET token_hash=CONVERT(SHA2(token, 256) USING ascii) COLLATE ascii_bin`)), table + ' must normalize the digest to ascii_bin');
    assert.ok(writes.some(sql => sql.includes(`UPDATE \`${table}\` SET token=NULL WHERE token IS NOT NULL AND CHAR_LENGTH(token)>0`)), table + ' must clear legacy plaintext tokens');
  }
  assert.ok(writes.some(sql => sql.includes('UPDATE orders SET session_token=SHA2(session_token, 256)')));
  assert.ok(writes.some(sql => sql.includes('UPDATE orders SET customer_token=SHA2(customer_token, 256)')));
  assert.ok(writes.some(sql => sql.includes('UPDATE waiter_calls SET session_token=SHA2(session_token, 256)')));
  assert.ok(writes.some((sql, i) => sql.includes('INSERT INTO settings (`key`, value) VALUES (?, ?)') && writeParams[i][0] === 'admin_access_key_hash' && writeParams[i][1] === hashSessionToken('legacy-integration-secret')));
  assert.ok(writes.some((sql, i) => sql.includes("UPDATE settings SET value='' WHERE `key`='admin_access_key'") && writeParams[i][0] === 'legacy-integration-secret'));
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
    if (sql.includes('information_schema.STATISTICS')) {
      const table = params[0];
      return [{ Key_name: `uq_${table}_token_hash`, Non_unique: 0 }];
    }
    if (sql.startsWith('SELECT `key`, value FROM settings')) return [];
    if (sql.startsWith('SELECT value FROM settings')) return [{ value: 'done' }];
    throw new Error('unexpected metadata query: ' + sql);
  };

  await migrateSessionTokenStorage({ runAsync, allAsync, withTransaction });
  assert.equal(transactionCount, 1);
  assert.equal(writes.some(sql => /ADD COLUMN token_hash/.test(sql)), false);
  assert.equal(writes.some(sql => /MODIFY token VARCHAR/.test(sql)), false);
  assert.equal(writes.some(sql => /CREATE UNIQUE INDEX/.test(sql)), false);
  assert.equal(writes.filter(sql => sql.startsWith('UPDATE')).length, 5);
});
