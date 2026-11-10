'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerAdminManageRoutes = require('../routes/admin-manage');

function setup({ affectedRows = 1 } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const app = {
    get() {},
    put() {},
    delete() {},
    post(path, ...callbacks) { handlers.set(path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async () => ({
      id: 42, status: 'pending', awaiting_confirm: 0, pay_khqr_ref: 'issued-dynamic-payload',
      table_name: 'A01', order_no: '110042', total: 25
    }),
    runAsync: async (sql, params) => {
      calls.push({ sql, params });
      return { affectedRows };
    },
    withTransaction: async work => work(),
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
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } }
  };
  registerAdminManageRoutes(app, deps);
  return { handler: handlers.get('/api/waiter/khqr/notify'), calls, events };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('waiter without order permission cannot notify cashier to confirm KHQR payment', async () => {
  const { handler, calls, events } = setup();
  const res = response();
  await handler({
    body: { order_id: 42, pay_method: 'khqr' },
    waiter: { id: 7, store_id: 9, can_order: 0 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
  assert.equal(events.length, 0);
});

test('waiter with order permission can notify cashier using a store-scoped atomic update', async () => {
  const { handler, calls, events } = setup();
  const res = response();
  await handler({
    body: { order_id: 42, pay_method: 'khqr', cash_received: 25, cash_change: 0 },
    waiter: { id: 7, store_id: 9, can_order: 1, display_name: 'QA waiter' },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'awaiting_confirm');
  const update = calls.find(call => call.sql.startsWith('UPDATE orders SET awaiting_confirm=1'));
  assert.ok(update);
  assert.match(update.sql, /WHERE id=\? AND store_id=\? AND status='pending' AND awaiting_confirm=0/);
  assert.deepEqual(update.params, ['khqr', 25, 0, 42, 9]);
  assert.equal(events.length, 1);
});

test('waiter KHQR notification returns conflict when order state changes concurrently', async () => {
  const { handler, calls, events } = setup({ affectedRows: 0 });
  const res = response();
  await handler({
    body: { order_id: 42, pay_method: 'khqr' },
    waiter: { id: 7, store_id: 9, can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(calls.filter(call => call.sql.startsWith('UPDATE orders SET awaiting_confirm=1')).length, 1);
  assert.equal(events.length, 0);
});
