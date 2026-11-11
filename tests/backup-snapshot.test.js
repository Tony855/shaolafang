'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
let inTransaction = false;
let failOnTable = null;
let rowsByTable = {};
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
      const tableName = sql.slice(15, -1);
      return rowsByTable[tableName] || [{ id: reads.length }];
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
  rowsByTable = {};
  const backup = await collectBackupData();

  assert.equal(inTransaction, false);
  assert.equal(reads.length, 21);
  assert.equal(Object.keys(backup.tables).length, 21);
  assert.ok(Object.hasOwn(backup.tables, 'refund_requests'));
  assert.ok(Object.hasOwn(backup.tables, 'provider_webhook_events'));
  assert.ok(Object.hasOwn(backup.tables, 'financial_journal_transactions'));
  assert.ok(Object.hasOwn(backup.tables, 'financial_journal_entries'));
  assert.ok(backup.exportedAt);
  assert.ok(reads.every(sql => sql.startsWith('SELECT * FROM')));
});

test('collectBackupData redacts bearer tokens whose backing sessions are not restored', async () => {
  reads.length = 0;
  rowsByTable = {
    orders: [{ id: 1, session_token: 'scan-secret', customer_token: 'customer-secret', total: 12 }],
    waiter_calls: [{ id: 'call-1', session_token: 'call-secret', status: 'pending' }],
    tables: [{ id: 3, qr_token: 'persistent-table-qr-secret', name: 'A1' }]
  };

  const backup = await collectBackupData();

  assert.deepEqual(backup.tables.orders, [{
    id: 1, session_token: '', customer_token: '', total: 12
  }]);
  assert.deepEqual(backup.tables.waiter_calls, [{
    id: 'call-1', session_token: '', status: 'pending'
  }]);
  // Persistent table QR codes are intentionally preserved for restore compatibility.
  assert.equal(backup.tables.tables[0].qr_token, 'persistent-table-qr-secret');
  const serialized = JSON.stringify(backup);
  assert.equal(serialized.includes('scan-secret'), false);
  assert.equal(serialized.includes('customer-secret'), false);
  assert.equal(serialized.includes('call-secret'), false);
  rowsByTable = {};
});

test('collectBackupData propagates read failures and closes the transaction', async () => {
  reads.length = 0;
  failOnTable = 'orders';
  await assert.rejects(collectBackupData(), /simulated read failure/);
  assert.equal(inTransaction, false);
  failOnTable = null;
});
