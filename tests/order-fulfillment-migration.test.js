'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureOrderFulfillmentSchema } = require('../server/db/migrations/order-fulfillment');

test('adds fulfillment_type with a safe dine_in default for legacy orders', async () => {
  const calls = [];
  await ensureOrderFulfillmentSchema({
    allAsync: async (sql, params) => { calls.push({ type: 'query', sql, params }); return []; },
    runAsync: async sql => { calls.push({ type: 'exec', sql }); return {}; }
  });
  assert.equal(calls.length, 4);
  assert.match(calls[0].sql, /information_schema\.COLUMNS/i);
  assert.deepEqual(calls[0].params, ['orders', 'fulfillment_type']);
  assert.match(calls[1].sql, /ADD COLUMN fulfillment_type VARCHAR\(20\) NOT NULL DEFAULT 'dine_in'/);
  assert.match(calls[2].sql, /MODIFY COLUMN table_name VARCHAR\(50\) NULL/i);
  assert.match(calls[3].sql, /UPDATE orders o INNER JOIN delivery_jobs j/i);
});

test('does not alter orders when fulfillment_type already exists', async () => {
  const executed = [];
  await ensureOrderFulfillmentSchema({
    allAsync: async () => [{ COLUMN_NAME: 'fulfillment_type' }],
    runAsync: async sql => executed.push(sql)
  });
  assert.equal(executed.length, 2);
  assert.match(executed[0], /MODIFY COLUMN table_name VARCHAR\(50\) NULL/i);
  assert.match(executed[1], /UPDATE orders o INNER JOIN delivery_jobs j/i);
});
