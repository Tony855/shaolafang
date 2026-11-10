'use strict';

process.env.DB_DATABASE = process.env.DB_DATABASE || 'foodflow_test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../server/db/pool');
const { authenticateAdmin } = require('../server/middleware/admin-auth');
const { hashSessionToken } = require('../server/services/session-token');

function request(storeId) {
  return {
    get(name) {
      if (name === 'Authorization') return '';
      if (name === 'X-Admin-Key') return 'legacy-integration-secret';
      if (name === 'X-Store-Id') return storeId;
      return '';
    }
  };
}

test('legacy admin API key cannot select a different store outside its configured scope', async () => {
  const originalExecute = pool.execute;
  const queries = [];
  pool.execute = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("key` = 'admin_access_key_hash'")) return [[{ value: hashSessionToken('legacy-integration-secret') }]];
    if (sql.includes("key` = 'admin_access_key_store_id'")) return [[{ value: '23' }]];
    throw new Error('Store lookup must not run for an out-of-scope request');
  };

  try {
    const result = await authenticateAdmin(request('42'));
    assert.equal(result.code, 'STORE_NOT_IN_API_KEY_SCOPE');
    assert.equal(queries.some(query => query.sql.includes('JOIN merchants')), false);
  } finally {
    pool.execute = originalExecute;
  }
});

test('legacy admin API key is bound to its configured store when the header is omitted', async () => {
  const originalExecute = pool.execute;
  const queries = [];
  pool.execute = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes("key` = 'admin_access_key_hash'")) return [[{ value: hashSessionToken('legacy-integration-secret') }]];
    if (sql.includes("key` = 'admin_access_key_store_id'")) return [[{ value: '23' }]];
    if (sql.includes('JOIN merchants')) return [[{ id: 23, merchant_id: 9 }]];
    throw new Error('Unexpected SQL: ' + sql);
  };

  try {
    const result = await authenticateAdmin(request(undefined));
    assert.deepEqual(result, { storeId: 23, merchantId: 9, legacyApiKey: true });
    const storeLookup = queries.find(query => query.sql.includes('JOIN merchants'));
    assert.deepEqual(storeLookup.params, [23]);
  } finally {
    pool.execute = originalExecute;
  }
});

test('legacy admin API key rejects malformed configured store scope', async () => {
  const originalExecute = pool.execute;
  pool.execute = async (sql) => {
    if (sql.includes("key` = 'admin_access_key_hash'")) return [[{ value: hashSessionToken('legacy-integration-secret') }]];
    if (sql.includes("key` = 'admin_access_key_store_id'")) return [[{ value: '0' }]];
    throw new Error('Store lookup must not run for invalid scope');
  };

  try {
    const result = await authenticateAdmin(request(undefined));
    assert.equal(result.code, 'INVALID_API_KEY_STORE_SCOPE');
  } finally {
    pool.execute = originalExecute;
  }
});
