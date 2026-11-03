'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getActiveWaiter, ACTIVE_WAITER_SQL } = require('../server/services/waiter-auth');

test('waiter lookup requires an active store and active merchant', async () => {
  let received;
  const waiter = await getActiveWaiter(async (sql, params) => {
    received = { sql, params };
    return null;
  }, 4);
  assert.equal(waiter, null);
  assert.equal(received.sql, ACTIVE_WAITER_SQL);
  assert.deepEqual(received.params, [4]);
  assert.match(received.sql, /JOIN stores/);
  assert.match(received.sql, /s\.active=1/);
  assert.match(received.sql, /m\.status=1/);
  assert.match(received.sql, /w\.active=1/);
});

test('active waiter lookup returns only the scoped waiter record', async () => {
  const expected = { id: 4, store_id: 7, merchant_id: 9, active: 1 };
  const actual = await getActiveWaiter(async () => expected, 4);
  assert.deepEqual(actual, expected);
});
