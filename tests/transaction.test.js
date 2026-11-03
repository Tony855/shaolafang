'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// Unit tests replace the connection pool and never connect to a real database.
process.env.DB_DATABASE = process.env.DB_DATABASE || 'foodflow_test';
const { pool } = require('../server/db/pool');
const { runAsync, getAsync, allAsync, withTransaction } = require('../server/db/helpers');

function mockConnection(options = {}) {
  const calls = [];
  return {
    calls,
    released: false,
    async query(sql) {
      calls.push(sql);
      if (options.failOn === sql) throw new Error('mock failure: ' + sql);
      return [{}];
    },
    release() { this.released = true; }
  };
}

test('transaction commits and always releases its connection', async () => {
  const original = pool.getConnection;
  const conn = mockConnection();
  pool.getConnection = async () => conn;
  try {
    assert.equal(await withTransaction(async () => 'committed'), 'committed');
    assert.deepEqual(conn.calls, ['START TRANSACTION', 'COMMIT']);
    assert.equal(conn.released, true);
  } finally {
    pool.getConnection = original;
  }
});

test('transaction start failure still releases the connection', async () => {
  const original = pool.getConnection;
  const conn = mockConnection({ failOn: 'START TRANSACTION' });
  pool.getConnection = async () => conn;
  try {
    await assert.rejects(withTransaction(async () => 'unreachable'), /mock failure/);
    assert.equal(conn.released, true);
    assert.deepEqual(conn.calls, ['START TRANSACTION']);
  } finally {
    pool.getConnection = original;
  }
});

test('nested transaction uses a savepoint and rolls back only the nested work', async () => {
  const original = pool.getConnection;
  const conn = mockConnection();
  pool.getConnection = async () => conn;
  try {
    await withTransaction(async () => {
      await assert.rejects(withTransaction(async () => { throw new Error('nested failure'); }), /nested failure/);
    });
    assert.equal(conn.calls[0], 'START TRANSACTION');
    assert.match(conn.calls[1], /^SAVEPOINT foodflow_sp_\d+$/);
    assert.match(conn.calls[2], /^ROLLBACK TO SAVEPOINT foodflow_sp_\d+$/);
    assert.match(conn.calls[3], /^RELEASE SAVEPOINT foodflow_sp_\d+$/);
    assert.equal(conn.calls[4], 'COMMIT');
    assert.equal(conn.released, true);
  } finally {
    pool.getConnection = original;
  }
});


test('helpers use the replacement pool after database bootstrap', async () => {
  const poolModule = require('../server/db/pool');
  const { runAsync } = require('../server/db/helpers');
  const originalPool = poolModule.pool;
  const replacementCalls = [];
  const replacementConnection = mockConnection();
  const replacementPool = {
    async execute(sql, params) {
      replacementCalls.push({ sql, params });
      if (sql.startsWith('SELECT')) return [[{ id: 42, value: 'replacement' }]];
      return [{ affectedRows: 1, insertId: 12 }];
    },
    async getConnection() {
      replacementCalls.push({ sql: 'GET_CONNECTION' });
      return replacementConnection;
    }
  };

  poolModule.setPool(replacementPool);
  try {
    const result = await runAsync('UPDATE bootstrap_test SET ready=?', [1]);
    assert.equal(result.affectedRows, 1);
    assert.deepEqual(await getAsync('SELECT id FROM bootstrap_test WHERE id=?', [42]), { id: 42, value: 'replacement' });
    assert.deepEqual(await allAsync('SELECT id FROM bootstrap_test'), [{ id: 42, value: 'replacement' }]);
    await withTransaction(async () => 'replacement-pool');
    assert.equal(replacementCalls[0].sql, 'UPDATE bootstrap_test SET ready=?');
    assert.ok(replacementCalls.some(call => call.sql === 'GET_CONNECTION'));
    assert.equal(replacementConnection.released, true);
  } finally {
    poolModule.setPool(originalPool);
  }
});
