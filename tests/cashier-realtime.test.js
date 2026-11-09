'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerCashierRoutes = require('../routes/cashier');

function setup() {
  const handlers = new Map();
  const emissions = [];
  const order = {
    id: 41,
    order_no: '110001',
    table_name: 'A01',
    store_id: 1,
    status: 'pending',
    total: 100,
    items: JSON.stringify([{ id: 1, name: 'Test dish', quantity: 1, itemStatus: 'done' }])
  };
  const app = {
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); },
    delete(path, ...callbacks) { handlers.set('DELETE ' + path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async sql => {
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=?')) return { ...order };
      if (sql.includes('SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE')) return { id: 1 };
      if (sql.includes('FROM orders WHERE id=? AND store_id=? FOR UPDATE')) {
        return { ...order, awaiting_confirm: 0, pay_khqr_ref: '', pay_expires_at: '' };
      }
      if (sql.includes('SELECT COUNT(*) AS cnt FROM orders')) return { cnt: 1 };
      if (sql.includes('SELECT value FROM settings')) return null;
      return null;
    },
    allAsync: async sql => {
      if (sql.includes('FROM orders WHERE id IN') && sql.includes('FOR UPDATE')) return [{ ...order }];
      if (sql.includes('FROM orders WHERE id IN') && sql.includes("status='pending'")) return [{ ...order }];
      if (sql.includes('FROM tables WHERE store_id=? AND name IN')) return [{ id: 1, name: 'A01' }];
      return [];
    },
    runAsync: async sql => {
      if (sql.includes("UPDATE orders SET status='canceled'")) order.status = 'canceled';
      if (sql.includes("UPDATE orders SET status='done'")) order.status = 'done';
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
    formatOrder: value => value,
    syncTableStatus: async () => {},
    buildBatchReceipt: () => '',
    buildReceipt: () => '',
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => {},
    io: { to: room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) }) }
  };
  registerCashierRoutes(app, deps);
  return { handlers, emissions, order };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('batch settlement broadcasts order:settled to all active views', async () => {
  const { handlers, emissions } = setup();
  const res = response();
  await handlers.get('PUT /api/cashier/orders/batch-settle')({
    storeId: 1,
    merchantId: 1,
    cashier: { username: 'cashier-qa', permissions: { can_settle: true } },
    body: { order_ids: [41], pay_method: 'cash', cash_received: 100 }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.settled, 1);
  assert.deepEqual(emissions.map(item => [item.room, item.event]), [
    ['kitchen-1', 'order:settled'],
    ['waiter-1', 'order:settled'],
    ['cashier-1', 'order:settled'],
    ['public-table-1-A01', 'order:settled']
  ]);
});

test('single cancellation broadcasts order:cancelled to all active views', async () => {
  const { handlers, emissions } = setup();
  const res = response();
  await handlers.get('PUT /api/cashier/orders/:id/cancel')({
    params: { id: '41' },
    storeId: 1,
    cashier: { username: 'cashier-qa', permissions: { can_cancel: true } },
    body: {}
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(emissions.map(item => [item.room, item.event]), [
    ['kitchen-1', 'order:cancelled'],
    ['waiter-1', 'order:cancelled'],
    ['cashier-1', 'order:cancelled'],
    ['public-table-1-A01', 'order:cancelled']
  ]);
});
