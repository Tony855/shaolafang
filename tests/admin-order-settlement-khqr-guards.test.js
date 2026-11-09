'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerOrderRoutes = require('../routes/orders');

function setup({ initialOrder, lockedOrder = initialOrder } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const transactions = [];
  let settledOrder = null;
  let initialRead = false;
  const app = {
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); },
    delete(path, ...callbacks) { handlers.set('DELETE ' + path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE')) return lockedOrder;
      if (sql.includes('SELECT * FROM orders WHERE id = ? AND store_id = ?')) {
        if (!initialRead) { initialRead = true; return initialOrder; }
        return settledOrder || lockedOrder;
      }
      if (sql.includes('SELECT COUNT(*) AS cnt')) return { cnt: 1 };
      return null;
    },
    allAsync: async (sql, params) => {
      calls.push({ type: 'all', sql, params });
      if (sql.includes('SELECT id, name FROM tables')) return [{ id: 1, name: 'A01' }];
      return [];
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      if (sql.includes("SET table_name=?, session_token=?, items=?, total=?, status='done'")) {
        settledOrder = { ...lockedOrder, status: 'done', pay_khqr_ref: '', pay_expires_at: '' };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      transactions.push('begin');
      try { const result = await work(); transactions.push('commit'); return result; }
      catch (error) { transactions.push('rollback'); throw error; }
    },
    resolveOrderStoreId: () => 1,
    normalizeOrderItems: async items => items,
    assertTableExists: async table => table,
    syncTableStatus: async () => {},
    getClientIp: () => '127.0.0.1',
    formatOrder: row => ({ ...row }),
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } },
    requireAdminOrWaiter: (_req, _res, next) => next(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    authenticateAdmin: async () => null,
    getWaiterFromRequest: async () => null
  };
  registerOrderRoutes(app, deps);
  return { handler: handlers.get('PUT /api/orders/:id(\\d+)'), calls, events, transactions };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function order(overrides = {}) {
  return {
    id: 9, store_id: 1, table_name: 'A01', status: 'pending',
    total: 10, items: JSON.stringify([{ id: 3, name: 'Tea', price: 10, base_price: 10, quantity: 1, itemStatus: 'done' }]),
    awaiting_confirm: 0, pay_khqr_ref: '', pay_expires_at: '',
    session_token: 'session', note: '',
    ...overrides
  };
}

function adminRequest(body = {}) {
  return {
    params: { id: '9' }, storeId: 1, isAdmin: true, isPrimaryAdmin: true,
    adminId: 2, adminUsername: 'qa-admin', body: { status: 'done', pay_method: 'cash', cash_received: 12, ...body }
  };
}

test('admin direct settlement rejects a live KHQR payload under the order lock', async () => {
  const live = order({
    pay_khqr_ref: 'dynamic-qr',
    pay_expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  const { handler, calls, transactions } = setup({ initialOrder: live, lockedOrder: live });
  const res = response();
  await handler(adminRequest(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("status='done'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
});

test('admin direct settlement rejects a KHQR payload with unknown expiry', async () => {
  const unknown = order({ pay_khqr_ref: 'dynamic-qr', pay_expires_at: null });
  const { handler, calls, transactions } = setup({ initialOrder: unknown, lockedOrder: unknown });
  const res = response();
  await handler(adminRequest(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("status='done'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
});

test('admin direct settlement rechecks for a KHQR created after the initial read', async () => {
  const initial = order();
  const locked = order({
    pay_khqr_ref: 'qr-created-concurrently',
    pay_expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  const { handler, calls, transactions } = setup({ initialOrder: initial, lockedOrder: locked });
  const res = response();
  await handler(adminRequest(), res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes("status='done'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
});

test('admin direct settlement clears expired QR and writes audit in the same transaction', async () => {
  const expired = order({
    pay_khqr_ref: 'expired-qr',
    pay_expires_at: new Date(Date.now() - 60_000).toISOString()
  });
  const { handler, calls, transactions, events } = setup({ initialOrder: expired, lockedOrder: expired });
  const res = response();
  await handler(adminRequest(), res);
  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.includes("status='done'"));
  assert.ok(update);
  assert.match(update.sql, /pay_khqr_ref='', pay_expires_at=''/);
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs')));
  assert.deepEqual(transactions, ['begin', 'commit']);
  assert.ok(events.some(event => event.event === 'order:settled'));
});


test('admin direct cash settlement rejects sub-cent tender before transaction', async () => {
  const initial = order();
  const { handler, calls, transactions } = setup({ initialOrder: initial, lockedOrder: initial });
  const res = response();
  await handler(adminRequest({ cash_received: '12.005' }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /两位小数/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactions, []);
});

test('admin direct cash settlement persists exact cents and change', async () => {
  const initial = order({
    total: '10.01',
    items: JSON.stringify([{ id: 3, name: 'Tea', price: 10.01, base_price: 10.01, quantity: 1, itemStatus: 'done' }])
  });
  const { handler, calls, transactions } = setup({ initialOrder: initial, lockedOrder: initial });
  const res = response();
  await handler(adminRequest({ cash_received: '12.34' }), res);
  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.includes("status='done'"));
  assert.ok(update);
  assert.equal(update.params[6], 12.34);
  assert.equal(update.params[7], 2.33);
  assert.deepEqual(transactions, ['begin', 'commit']);
});

test('waiter completion cannot edit an order while its KHQR payload is active', async () => {
  const live = order({
    pay_khqr_ref: 'active-dynamic-qr',
    pay_expires_at: new Date(Date.now() + 60_000).toISOString()
  });
  const { handler, calls, transactions, events } = setup({ initialOrder: live, lockedOrder: live });
  const res = response();
  await handler({
    params: { id: '9' },
    storeId: 1,
    isAdmin: false,
    waiterStoreId: 1,
    waiter: { id: 7, store_id: 1, can_order: true, can_complete_order: true },
    body: { status: 'done', pay_method: 'cash', cash_received: '12.00' }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('UPDATE orders SET')), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
  assert.equal(events.length, 0);
});

test('waiter completion rejects sub-cent cash fields before transaction', async () => {
  const initial = order();
  const { handler, calls, transactions } = setup({ initialOrder: initial, lockedOrder: initial });
  const res = response();
  await handler({
    params: { id: '9' },
    storeId: 1,
    isAdmin: false,
    waiterStoreId: 1,
    waiter: { id: 7, store_id: 1, can_order: true, can_complete_order: true },
    body: { status: 'done', pay_method: 'cash', cash_received: '12.005', cash_change: '0.005' }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /两位小数/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactions, []);
});
