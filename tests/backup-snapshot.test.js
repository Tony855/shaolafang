'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
let inTransaction = false;
let failOnTable = null;
const reads = [];
require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: {
    runAsync: async () => ({ affectedRows: 0 }),
    getAsync: async () => null,
    allAsync: async sql => {
      assert.equal(inTransaction, true, 'every backup SELECT must use the snapshot transaction');
      reads.push(sql);
      if (failOnTable && sql.includes(failOnTable)) throw new Error('simulated read failure');
      return [{ id: reads.length }];
    },
    withTransaction: async work => {
      assert.equal(inTransaction, false, 'backup transaction must not be nested unexpectedly');
      inTransaction = true;
      try {
        return await work();
      } finally {
        inTransaction = false;
      }
    }
  }
};

const { collectBackupData } = require('../server/services/backup');

test('collectBackupData reads every exported table in one transaction', async () => {
  reads.length = 0;
  const backup = await collectBackupData();

  assert.equal(inTransaction, false);
  assert.equal(reads.length, 18);
  assert.equal(Object.keys(backup.tables).length, 18);
  assert.ok(Object.hasOwn(backup.tables, 'refund_requests'));
  assert.ok(backup.exportedAt);
  assert.ok(reads.every(sql => sql.startsWith('SELECT * FROM')));
});

test('collectBackupData propagates read failures and closes the transaction', async () => {
  reads.length = 0;
  failOnTable = 'orders';
  await assert.rejects(collectBackupData(), /simulated read failure/);
  assert.equal(inTransaction, false);
  failOnTable = null;
});
