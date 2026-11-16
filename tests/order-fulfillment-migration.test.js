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
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /information_schema\.COLUMNS/i);
  assert.deepEqual(calls[0].params, ['orders', 'fulfillment_type']);
  assert.match(calls[1].sql, /ADD COLUMN fulfillment_type VARCHAR\(20\) NOT NULL DEFAULT 'dine_in'/);
});

test('does not alter orders when fulfillment_type already exists', async () => {
  const executed = [];
  await ensureOrderFulfillmentSchema({
    allAsync: async () => [{ COLUMN_NAME: 'fulfillment_type' }],
    runAsync: async sql => executed.push(sql)
  });
  assert.deepEqual(executed, []);
});
