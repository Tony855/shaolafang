'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerCashierRoutes = require('../routes/cashier');

function setup({ orders = [], lockedOrders = orders, singleOrder = orders[0] || null } = {}) {
  const handlers = new Map();
  const calls = [];
  const transactions = [];
  const app = {
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); },
    delete(path, ...callbacks) { handlers.set('DELETE ' + path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('SELECT id FROM tables')) return { id: 1 };
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE')) return singleOrder;
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=?')) return singleOrder;
      if (sql.includes('SELECT COUNT(*) AS cnt')) return { cnt: 1 };
      return null;
    },
    allAsync: async (sql, params) => {
      calls.push({ type: 'all', sql, params });
      if (sql.includes('SELECT id, name FROM tables')) return [{ id: 1, name: 'A01' }];
      if (sql.includes('SELECT * FROM orders') && sql.includes('ORDER BY id FOR UPDATE')) return lockedOrders;
      if (sql.includes("status='pending'")) return orders;
      return [];
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      transactions.push('begin');
      try { const result = await work(); transactions.push('commit'); return result; }
      catch (error) { transactions.push('rollback'); throw error; }
    },
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    verifyPassword: () => true,
    getClientIp: () => '127.0.0.1',
    requireCashier: (_req, _res, next) => next(),
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    formatOrder: x => x,
    syncTableStatus: async () => {},
    buildBatchReceipt: () => Buffer.from('receipt'),
    buildReceipt: () => Buffer.from('receipt'),
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => {},
    io: { to: () => ({ emit() {} }) }
  };
  registerCashierRoutes(app, deps);
  return {
    batchHandler: handlers.get('PUT /api/cashier/orders/batch-settle'),
    singleHandler: handlers.get('PUT /api/cashier/orders/:id/settle'),
    cancelHandler: handlers.get('PUT /api/cashier/orders/:id/cancel'),
    calls, transactions
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function pendingOrder(overrides = {}) {
  return {
    id: 5, store_id: 1, table_name: 'A01', status: 'pending',
    total: 10, items: JSON.stringify([{ itemStatus: 'done' }]),
    awaiting_confirm: 0, pay_khqr_ref: '', pay_expires_at: '',
    ...overrides
  };
}

const cashierRequest = body => ({
  storeId: 1,
  merchantId: 1,
  cashier: { username: 'qa-cashier', permissions: { can_settle: true } },
  body
});

test('batch settlement rejects mixed valid and invalid order identifiers without silently settling a subset', async () => {
  const { batchHandler, calls, transactions } = setup({ orders: [pendingOrder()] });
  const res = response();
  await batchHandler(cashierRequest({ order_ids: [5, 'not-an-id'], pay_method: 'cash', cash_received: 10 }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /无效编号/);
  assert.equal(calls.length, 0);
  assert.equal(transactions.length, 0);
});

test('batch settlement refuses an order awaiting payment confirmation', async () => {
  const order = pendingOrder({ awaiting_confirm: 1 });
  const { batchHandler, calls, transactions } = setup({ orders: [order] });
  const res = response();
  await batchHandler(cashierRequest({ order_ids: [5], pay_method: 'cash', cash_received: 10 }), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("SET status='done'")), false);
  assert.equal(transactions.length, 0);
});

test('batch settlement refuses to orphan a live KHQR payload', async () => {
  const order = pendingOrder({
    pay_khqr_ref: 'dynamic-qr-payload',
    pay_expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  const { batchHandler, calls, transactions } = setup({ orders: [order] });
  const res = response();
  await batchHandler(cashierRequest({ order_ids: [5], pay_method: 'cash', cash_received: 10 }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("SET status='done'")), false);
  assert.equal(transactions.length, 0);
});

test('single settlement refuses an order with an active KHQR payload', async () => {
  const order = pendingOrder({
    pay_khqr_ref: 'dynamic-qr-payload',
    pay_expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  const { singleHandler, calls, transactions } = setup({ singleOrder: order });
  const res = response();
  await singleHandler({
    ...cashierRequest({ pay_method: 'cash', cash_received: 10 }),
    params: { id: '5' }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("SET status='done'")), false);
  assert.equal(transactions.length, 0);
});

test('expired KHQR payload may be settled and is cleared from the order', async () => {
  const expired = pendingOrder({
    pay_khqr_ref: 'expired-payload',
    pay_expires_at: new Date(Date.now() - 60_000).toISOString()
  });
  const { batchHandler, calls, transactions } = setup({ orders: [expired], lockedOrders: [expired] });
  const res = response();
  await batchHandler(cashierRequest({ order_ids: [5], pay_method: 'cash', cash_received: 10 }), res);
  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.includes("SET status='done'"));
  assert.ok(update);
  assert.match(update.sql, /pay_khqr_ref='', pay_expires_at=''/);
  assert.deepEqual(transactions, ['begin', 'commit']);
});


test('batch settlement rechecks for a newly-created KHQR under the order lock', async () => {
  const initial = pendingOrder();
  const locked = pendingOrder({
    pay_khqr_ref: 'qr-created-after-initial-read',
    pay_expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  const { batchHandler, calls, transactions } = setup({ orders: [initial], lockedOrders: [locked] });
  const res = response();
  await batchHandler(cashierRequest({ order_ids: [5], pay_method: 'cash', cash_received: 10 }), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("SET status='done'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
});

test('batch settlement rejects coercible non-numeric order IDs before querying', async () => {
  for (const id of [true, false, [], {}, null, ' 5 ', '5.0', '5e0']) {
    const { batchHandler, calls, transactions } = setup({ orders: [pendingOrder()] });
    const res = response();
    await batchHandler(cashierRequest({ order_ids: [id], pay_method: 'cash', cash_received: 10 }), res);
    assert.equal(res.statusCode, 400, String(id));
    assert.equal(calls.length, 0);
    assert.equal(transactions.length, 0);
  }
});

test('single settlement and cancellation reject partial order path IDs before querying', async () => {
  const invalidParams = { id: '5garbage' };
  const settle = setup({ orders: [pendingOrder()] });
  const settleRes = response();
  await settle.singleHandler({ ...cashierRequest({ pay_method: 'cash', cash_received: 10 }), params: invalidParams }, settleRes);
  assert.equal(settleRes.statusCode, 400);
  assert.equal(settle.calls.length, 0);
  assert.equal(settle.transactions.length, 0);

  const cancel = setup({ orders: [pendingOrder()] });
  const cancelRes = response();
  await cancel.cancelHandler({
    storeId: 1, cashier: { username: 'qa-cashier', permissions: { can_cancel: true } }, params: invalidParams
  }, cancelRes);
  assert.equal(cancelRes.statusCode, 400);
  assert.equal(cancel.calls.length, 0);
  assert.equal(cancel.transactions.length, 0);
});


test('cashier cancellation refuses an order awaiting KHQR confirmation under the order lock', async () => {
  const order = pendingOrder({
    awaiting_confirm: 1,
    pay_khqr_ref: 'submitted-qr',
    pay_expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  const { cancelHandler, calls, transactions } = setup({ singleOrder: order });
  const res = response();
  await cancelHandler({
    storeId: 1,
    cashier: { username: 'qa-cashier', permissions: { can_cancel: true } },
    params: { id: '5' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("SET status='canceled'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
  const lockedRead = calls.find(call => call.type === 'get' && call.sql.includes('FOR UPDATE'));
  assert.match(lockedRead.sql, /awaiting_confirm, pay_khqr_ref, pay_expires_at/);
});

test('cashier cancellation clears an expired KHQR payload atomically', async () => {
  const order = pendingOrder({
    pay_khqr_ref: 'expired-qr',
    pay_expires_at: new Date(Date.now() - 60_000).toISOString()
  });
  const { cancelHandler, calls, transactions } = setup({ singleOrder: order });
  const res = response();
  await cancelHandler({
    storeId: 1,
    cashier: { username: 'qa-cashier', permissions: { can_cancel: true } },
    params: { id: '5' }
  }, res);

  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.includes("SET status='canceled'"));
  assert.ok(update);
  assert.match(update.sql, /awaiting_confirm=0, pay_khqr_ref='', pay_expires_at=''/);
  assert.deepEqual(transactions, ['begin', 'commit']);
});
