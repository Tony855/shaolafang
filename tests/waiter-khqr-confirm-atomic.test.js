'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerAdminManageRoutes = require('../routes/admin-manage');

function setup({ initialOrder = null, lockedOrder = null, affectedRows = 1 } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const transactions = [];
  let transactionState = 'idle';
  const app = {
    get() {}, put() {}, delete() {},
    post(path, ...callbacks) { handlers.set(path, callbacks[callbacks.length - 1]); }
  };
  const defaultOrder = {
    id: 42, status: 'pending', awaiting_confirm: 0,
    pay_khqr_ref: 'dynamic-payload', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FOR UPDATE')) return lockedOrder || initialOrder || defaultOrder;
      return initialOrder || defaultOrder;
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      if (sql.startsWith('UPDATE orders SET awaiting_confirm=1')) return { affectedRows };
      return { affectedRows: 1 };
    },
    allAsync: async () => [],
    withTransaction: async work => {
      transactionState = 'active';
      transactions.push('begin');
      try {
        const result = await work();
        transactions.push('commit');
        transactionState = 'committed';
        return result;
      } catch (error) {
        transactions.push('rollback');
        transactionState = 'rolled_back';
        throw error;
      }
    },
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    requireAdminOrWaiter: (_req, _res, next) => next(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    requireAdminOrCashier: (_req, _res, next) => next(),
    hashPassword: value => value,
    verifyPassword: () => true,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    syncTableStatus: async () => {},
    io: { to(room) { return { emit(event, payload) {
      events.push({ room, event, payload, transactionState });
    } }; } }
  };
  registerAdminManageRoutes(app, deps);
  return { handler: handlers.get('/api/cashier/khqr/confirm'), calls, events, transactions };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

const waiterRequest = body => ({
  body: { order_id: 42, pay_method: 'khqr', ...body },
  waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
  waiterStoreId: 9
});

test('legacy waiter KHQR confirm path atomically records and broadcasts cashier notification', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 0,
    pay_khqr_ref: 'dynamic-payload', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const { handler, calls, events, transactions } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  await handler(waiterRequest({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'awaiting_confirm');
  assert.deepEqual(transactions, ['begin', 'commit']);
  assert.ok(calls.some(call => call.type === 'get' && call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE orders SET awaiting_confirm=1')));
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs')));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'khqr:awaiting');
  assert.equal(events[0].transactionState, 'committed');
});

test('legacy waiter KHQR confirm retry is idempotent and emits no duplicate event or audit', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 1,
    pay_khqr_ref: 'dynamic-payload', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const { handler, calls, events, transactions } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  await handler(waiterRequest({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.already, true);
  assert.deepEqual(transactions, ['begin', 'commit']);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.equal(events.length, 0);
});

test('legacy waiter KHQR confirm rejects non-finite cash amounts before writing', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 0,
    pay_khqr_ref: 'dynamic-payload', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const { handler, calls, transactions } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  await handler(waiterRequest({ pay_method: 'cash', cash_received: 'Infinity' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.equal(transactions.length, 0);
});

test('legacy waiter KHQR confirm rejects cross-store access', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 0,
    pay_khqr_ref: 'dynamic-payload', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const { handler, calls, transactions } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  const req = waiterRequest({});
  req.waiterStoreId = 10;
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.equal(transactions.length, 0);
});
