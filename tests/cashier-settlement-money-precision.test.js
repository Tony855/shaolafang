'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerCashierRoutes = require('../routes/cashier');

function makeOrder(id, total) {
  return {
    id, status: 'pending', store_id: 9, table_name: 'A01',
    total, items: JSON.stringify([{ itemStatus: 'done' }]),
    awaiting_confirm: 0, pay_khqr_ref: '', pay_expires_at: ''
  };
}

function setup({ orders = [makeOrder(41, '10.01')], lockedOrders = null, lockedOrder = null } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const transactions = [];
  const app = {
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); },
    delete(path, ...callbacks) { handlers.set('DELETE ' + path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('SELECT id FROM tables')) return { id: 1 };
      if (sql.includes('SELECT COUNT(*) AS cnt')) return { cnt: 0 };
      if (sql.includes('SELECT * FROM orders') && sql.includes('FOR UPDATE')) return lockedOrder || orders[0];
      if (sql.includes('SELECT * FROM orders')) return orders[0];
      return null;
    },
    allAsync: async (sql, params) => {
      calls.push({ type: 'all', sql, params });
      if (sql.includes('SELECT id, name FROM tables')) return [{ id: 1, name: 'A01' }];
      if (sql.includes('SELECT * FROM orders') && sql.includes('FOR UPDATE')) return lockedOrders || orders;
      if (sql.includes('SELECT * FROM orders')) return orders;
      return [];
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      transactions.push('begin');
      try {
        const result = await work();
        transactions.push('commit');
        return result;
      } catch (error) {
        transactions.push('rollback');
        throw error;
      }
    },
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    verifyPassword: () => true,
    getClientIp: () => '127.0.0.1',
    requireCashier: (_req, _res, next) => next(),
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    formatOrder: order => ({ ...order }),
    syncTableStatus: async () => {},
    buildBatchReceipt: () => Buffer.from('receipt'),
    buildReceipt: () => Buffer.from('receipt'),
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => ({ success: true }),
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } }
  };
  registerCashierRoutes(app, deps);
  return { handlers, calls, events, transactions };
}

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function request(body = {}) {
  return {
    body, params: { id: '41' }, storeId: 9, merchantId: 1,
    cashier: { id: 5, username: 'cashier', permissions: { can_settle: true } }
  };
}

test('single cashier settlement rejects sub-cent cash tender before transaction', async () => {
  const { handlers, calls, transactions } = setup();
  const res = response();
  await handlers.get('PUT /api/cashier/orders/:id/settle')(request({ pay_method: 'cash', cash_received: '10.015' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /两位小数/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactions, []);
});

test('single cashier settlement persists exact cents and change', async () => {
  const order = makeOrder(41, '10.01');
  const { handlers, calls, transactions } = setup({ orders: [order], lockedOrder: order });
  const res = response();
  await handlers.get('PUT /api/cashier/orders/:id/settle')(request({ pay_method: 'cash', cash_received: '12.00' }), res);
  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.startsWith("UPDATE orders SET status='done'"));
  assert.ok(update);
  assert.equal(update.params[2], 12);
  assert.equal(update.params[3], 1.99);
  assert.deepEqual(transactions, ['begin', 'commit']);
});

test('batch cashier settlement rejects sub-cent cash tender before transaction', async () => {
  const { handlers, calls, transactions } = setup();
  const res = response();
  await handlers.get('PUT /api/cashier/orders/batch-settle')(request({
    order_ids: [41], pay_method: 'cash', cash_received: '10.015'
  }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /两位小数/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactions, []);
});

test('batch cashier settlement reconciles aggregate cash using integer cents', async () => {
  const orders = [makeOrder(41, '10.01'), makeOrder(42, '0.99')];
  orders[1].table_name = 'A01';
  const { handlers, calls, transactions } = setup({ orders, lockedOrders: orders });
  const res = response();
  await handlers.get('PUT /api/cashier/orders/batch-settle')(request({
    order_ids: [41, 42], pay_method: 'cash', cash_received: '12.00'
  }), res);
  assert.equal(res.statusCode, 200);
  const updates = calls.filter(call => call.type === 'run' && call.sql.startsWith("UPDATE orders SET status='done'"));
  assert.equal(updates.length, 2);
  assert.equal(updates.reduce((sum, call) => sum + call.params[2], 0), 12);
  assert.equal(updates.reduce((sum, call) => sum + call.params[3], 0), 1);
  assert.deepEqual(transactions, ['begin', 'commit']);
});
