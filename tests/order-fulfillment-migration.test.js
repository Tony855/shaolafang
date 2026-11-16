'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureOrderFulfillmentSchema } = require('../server/db/migrations/order-fulfillment');

test('adds fulfillment_type and makes legacy table_name nullable', async () => {
  const calls = [];
  await ensureOrderFulfillmentSchema({
    allAsync: async (sql, params) => {
      calls.push({ type: 'query', sql, params });
      return params[1] === 'table_name' ? [{ IS_NULLABLE: 'NO' }] : [];
    },
    runAsync: async sql => { calls.push({ type: 'exec', sql }); return {}; }
  });
  assert.equal(calls.length, 5);
  assert.ok(calls[0].sql.includes('information_schema.COLUMNS'));
  assert.deepEqual(calls[0].params, ['orders', 'fulfillment_type']);
  assert.ok(calls[1].sql.includes("ADD COLUMN fulfillment_type VARCHAR(20) NOT NULL DEFAULT 'dine_in'"));
  assert.ok(calls[2].sql.includes('information_schema.COLUMNS'));
  assert.deepEqual(calls[2].params, ['orders', 'table_name']);
  assert.ok(calls[3].sql.includes('MODIFY COLUMN table_name VARCHAR(50) NULL'));
  assert.ok(calls[4].sql.includes('UPDATE orders o INNER JOIN delivery_jobs j'));
});

test('does not repeat table DDL when table_name is already nullable', async () => {
  const executed = [];
  await ensureOrderFulfillmentSchema({
    allAsync: async (_sql, params) => params[1] === 'table_name'
      ? [{ IS_NULLABLE: 'YES' }]
      : [{ COLUMN_NAME: 'fulfillment_type' }],
    runAsync: async sql => executed.push(sql)
  });
  assert.equal(executed.length, 1);
  assert.ok(executed[0].includes('UPDATE orders o INNER JOIN delivery_jobs j'));
});
