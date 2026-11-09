const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOrderStoreId } = require('../server/services/order-store-scope');

test('admin order scope uses only the authenticated store id', () => {
  assert.equal(resolveOrderStoreId({ isAdmin: true, storeId: 12 }), 12);
  assert.equal(resolveOrderStoreId({ isAdmin: true, storeId: '12' }), 12);
});

test('admin order scope fails closed instead of silently selecting store one', () => {
  assert.equal(resolveOrderStoreId({ isAdmin: true }), null);
  assert.equal(resolveOrderStoreId({ isAdmin: true, storeId: 0 }), null);
  assert.equal(resolveOrderStoreId({ isAdmin: true, storeId: '1abc' }), null);
  assert.equal(resolveOrderStoreId({ isAdmin: true, storeId: -1 }), null);
});

test('waiter order scope uses the middleware-bound waiter store', () => {
  assert.equal(resolveOrderStoreId({ isAdmin: false, waiterStoreId: 8 }), 8);
  assert.equal(resolveOrderStoreId({ isAdmin: false, waiter: { store_id: 9 } }), 9);
});

test('waiter order scope ignores unrelated admin store ids and fails closed', () => {
  assert.equal(resolveOrderStoreId({ isAdmin: false, storeId: 1 }), null);
  assert.equal(resolveOrderStoreId({ isAdmin: false }), null);
  assert.equal(resolveOrderStoreId({ isAdmin: false, waiterStoreId: '0' }), null);
  assert.equal(resolveOrderStoreId(null), null);
});
