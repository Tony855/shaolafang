'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerCashierRoutes = require('../routes/cashier');

function setup(reportOrders = []) {
  const handlers = new Map();
  const app = {
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); },
    delete(path, ...callbacks) { handlers.set('DELETE ' + path, callbacks[callbacks.length - 1]); }
  };
  const state = { id: 5, store_id: 1, table_name: 'A01', status: 'done', total: 100, refund_amount: 0 };
  const deps = {
    getAsync: async (sql) => {
      if (sql.includes('FROM orders WHERE id=? AND store_id=? FOR UPDATE')) return { ...state };
      return null;
    },
    allAsync: async sql => sql.includes("status IN ('done', 'refunded')") ? reportOrders : [],
    runAsync: async (sql, params) => {
      if (sql.startsWith('UPDATE orders SET status=?')) {
        state.status = params[0];
        state.refund_amount = Number(params[5]);
        return { affectedRows: 1 };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => work(),
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    verifyPassword: () => true,
    getClientIp: () => '127.0.0.1',
    requireCashier: (_req, _res, next) => next(),
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    formatOrder: x => x,
    syncTableStatus: async () => {},
    buildBatchReceipt: () => '',
    buildReceipt: () => '',
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => {},
    io: { to: () => ({ emit() {} }) }
  };
  registerCashierRoutes(app, deps);
  return { handler: handlers.get('PUT /api/cashier/orders/:id/refund'), reportHandler: handlers.get('GET /api/cashier/report/today'), state };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('partial refunds accumulate without closing the order until the full amount is refunded', async () => {
  const { handler, state } = setup();
  const req = { params: { id: '5' }, storeId: 1, cashier: { username: 'qa-cashier', permissions: { can_refund: true } }, body: { amount: 30, reason: 'customer request' } };
  const first = response();
  await handler(req, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.total_refunded, 30);
  assert.equal(first.body.remaining_amount, 70);
  assert.equal(first.body.fully_refunded, false);
  assert.equal(state.status, 'done');
  assert.equal(state.refund_amount, 30);

  req.body.amount = 70;
  const second = response();
  await handler(req, second);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.total_refunded, 100);
  assert.equal(second.body.remaining_amount, 0);
  assert.equal(second.body.fully_refunded, true);
  assert.equal(state.status, 'refunded');
  assert.equal(state.refund_amount, 100);
});

test('refunds cannot exceed the remaining refundable balance or repeat after full refund', async () => {
  const { handler, state } = setup();
  state.refund_amount = 80;
  const req = { params: { id: '5' }, storeId: 1, cashier: { username: 'qa-cashier', permissions: { can_refund: true } }, body: { amount: 25, reason: 'customer request' } };
  const over = response();
  await handler(req, over);
  assert.equal(over.statusCode, 400);
  assert.equal(state.refund_amount, 80);

  state.refund_amount = 100;
  state.status = 'refunded';
  const repeated = response();
  await handler(req, repeated);
  assert.equal(repeated.statusCode, 409);
});


test('daily cashier report includes fully refunded orders and separates refund totals', async () => {
  const settledAt = new Date().toISOString();
  const reportOrders = [
    { id: 5, store_id: 1, status: 'refunded', total: 100, refund_amount: 100, settled_at: settledAt },
    { id: 6, store_id: 1, status: 'done', total: 50, refund_amount: 10, settled_at: settledAt }
  ];
  const { reportHandler } = setup(reportOrders);
  const res = response();
  await reportHandler({ storeId: 1, cashier: { permissions: { can_view_report: true } } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderCount, 2);
  assert.equal(res.body.totalRevenue, '40.00');
  assert.equal(res.body.totalRefunded, '110.00');
  assert.equal(res.body.refundedOrderCount, 1);
  assert.equal(res.body.orders.length, 2);
});


test('refund amount rejects fractions smaller than one cent instead of rounding them', async () => {
  const { handler, state } = setup();
  for (const amount of [0.001, 1.005, '2.999']) {
    const res = response();
    await handler({
      params: { id: '5' },
      storeId: 1,
      cashier: { username: 'qa-cashier', permissions: { can_refund: true } },
      body: { amount, reason: 'precision validation' }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /两位小数/);
    assert.equal(state.refund_amount, 0);
  }
});

test('refund calculations persist exact decimal cents and reject corrupt historical refund totals', async () => {
  const { handler, state } = setup();
  const res = response();
  await handler({
    params: { id: '5' },
    storeId: 1,
    cashier: { username: 'qa-cashier', permissions: { can_refund: true } },
    body: { amount: '0.10', reason: 'small exact refund' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total_refunded, 0.1);
  assert.equal(state.refund_amount, 0.1);

  state.refund_amount = -0.01;
  const corrupt = response();
  await handler({
    params: { id: '5' },
    storeId: 1,
    cashier: { username: 'qa-cashier', permissions: { can_refund: true } },
    body: { amount: '0.10', reason: 'invalid history' }
  }, corrupt);
  assert.equal(corrupt.statusCode, 409);
  assert.equal(state.refund_amount, -0.01);
});
