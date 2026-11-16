'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureDeliverySchema } = require('../server/db/migrations/delivery');

test('delivery migration creates tenant-scoped rider, job and latest-location tables', async () => {
  const statements = [];
  const result = await ensureDeliverySchema({ runAsync: async sql => { statements.push(sql); }, allAsync: async () => [{ COLUMN_TYPE: "enum('assigned','accepted','picked_up','delivering','delivered','cancelled')" }] });
  assert.equal(result.changed, true);
  assert.equal(statements.length, 5);
  for (const table of ['delivery_riders', 'delivery_rider_sessions', 'delivery_jobs', 'delivery_rider_locations']) {
    assert.ok(statements.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS ' + table)), table);
  }
  assert.match(statements[0], /UNIQUE KEY uq_delivery_rider_store_username \(store_id, username\)/);
  assert.match(statements[2], /UNIQUE KEY uq_delivery_job_order \(order_id\)/);
  assert.match(statements[3], /PRIMARY KEY \(rider_id\)/);
});

test('delivery migration rejects missing database helper', async () => {
  await assert.rejects(() => ensureDeliverySchema({}), /runAsync and allAsync are required/);
});
