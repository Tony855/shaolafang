'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerAdminManageRoutes = require('../routes/admin-manage');

function setup() {
  const handlers = new Map();
  const calls = [];
  const app = {
    get() {},
    put() {},
    delete() {},
    post(path, ...callbacks) { handlers.set(path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async sql => sql.includes('FROM stores WHERE id=? AND merchant_id=?')
      ? { id: 9, name: 'Test Store' }
      : null,
    runAsync: async (sql, params) => {
      calls.push({ sql, params });
      return { affectedRows: 1 };
    },
    allAsync: async () => [],
    requireAdminOrWaiter: (_req, _res, next) => next(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    requireAdminOrCashier: (_req, _res, next) => next(),
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    hashPassword: value => value,
    verifyPassword: () => true,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) }
  };
  registerAdminManageRoutes(app, deps);
  return { handler: handlers.get('/api/cashier/khqr/cancel'), calls };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('waiter without order permission cannot cancel a KHQR confirmation', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler({
    body: { order_id: 42 }, storeId: 9, merchantId: 3,
    isWaiter: true, waiter: { store_id: 9, can_order: 0 }, waiterStoreId: 9
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('cashier without settlement permission cannot cancel a KHQR confirmation', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler({
    body: { order_id: 42 }, storeId: 9, merchantId: 3,
    isCashier: true, cashier: { permissions: { can_settle: false } }
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('non-primary admin without order management permission cannot cancel a KHQR confirmation', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler({
    body: { order_id: 42 }, storeId: 9, merchantId: 3,
    isAdmin: true, isPrimaryAdmin: false, adminPermissions: { can_manage_order: 0 }
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('authorized waiter cancellation remains store-scoped and validates order id', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler({
    body: { order_id: '42' }, storeId: 9, merchantId: 3,
    isWaiter: true, waiter: { store_id: 9, can_order: 1 }, waiterStoreId: 9
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].params, [42, 9]);
  assert.match(calls[0].sql, /WHERE id=\? AND store_id=\? AND status='pending' AND \(awaiting_confirm=1 OR pay_khqr_ref<>''\)/);
});
