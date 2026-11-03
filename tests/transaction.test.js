'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../server/db/pool');
const { withTransaction } = require('../server/db/helpers');

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
