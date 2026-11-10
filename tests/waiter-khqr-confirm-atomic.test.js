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
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('SELECT id, name FROM stores')) return { id: 9, name: 'Test Store' };
      if (sql.includes('SELECT id FROM tables')) return { id: 1 };
      if (sql.includes('SELECT COUNT(*) AS cnt')) return { cnt: 0 };
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
  return {
    handler: handlers.get('/api/cashier/khqr/confirm'),
    generateHandler: handlers.get('/api/cashier/khqr/generate'),
    calls, events, transactions
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

const waiterRequest = body => ({
  body: { order_id: 42, pay_method: 'khqr', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ...body },
  storeId: 9,
  merchantId: 1,
  waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
  waiterStoreId: 9
});

test('legacy waiter KHQR confirm path atomically records and broadcasts cashier notification', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 0,
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01',
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
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01',
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
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01',
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
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const { handler, calls, transactions } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  const req = waiterRequest({});
  req.waiterStoreId = 10;
  req.waiter.store_id = 10;
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.equal(transactions.length, 0);
});


function adminRequest(body = {}) {
  return {
    body: { order_id: 42, expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ...body },
    storeId: 9,
    merchantId: 1,
    isAdmin: true,
    isPrimaryAdmin: true,
    adminId: 3
  };
}

test('cashier cannot settle a replacement QR generation using a stale confirmation window', async () => {
  const oldOrder = {
    id: 42, status: 'pending', awaiting_confirm: 1,
    pay_khqr_ref: 'same-dynamic-payload',
    pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    table_name: 'A01', total: '25.00', pay_method: 'khqr'
  };
  const replacementOrder = {
    ...oldOrder,
    pay_qr_generation_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  };
  const { handler, calls, transactions, events } = setup({ initialOrder: oldOrder, lockedOrder: replacementOrder });
  const res = response();
  await handler(adminRequest({}), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /二维码已变化/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.startsWith("UPDATE orders SET status='done'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
  assert.equal(events.length, 0);
});

test('stale QR confirmation cannot settle a later manual confirmation after QR cancellation', async () => {
  const manualOrder = {
    id: 42, status: 'pending', awaiting_confirm: 1,
    pay_khqr_ref: '', pay_qr_generation_id: '',
    table_name: 'A01', total: '25.00', pay_method: 'cash', cash_received: '30.00'
  };
  const { handler, calls, transactions, events } = setup({ initialOrder: manualOrder, lockedOrder: manualOrder });
  const res = response();
  await handler(adminRequest({
    expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  }), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /二维码已变化/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.startsWith("UPDATE orders SET status='done'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
  assert.equal(events.length, 0);
});

test('cashier KHQR confirmation rejects cash amounts with sub-cent precision', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 1,
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pay_expires_at: new Date(Date.now() + 60000).toISOString(),
    table_name: 'A01', total: '25.00', pay_method: 'cash', cash_received: '25.00'
  };
  const { handler, calls, transactions, events } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  await handler(adminRequest({ cash_received: '25.005' }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /两位小数/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.startsWith("UPDATE orders SET status='done'")), false);
  assert.deepEqual(transactions, ['begin', 'rollback']);
  assert.equal(events.length, 0);
});

test('cashier KHQR confirmation stores exact cents and clears confirmed QR metadata', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 1,
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pay_expires_at: new Date(Date.now() + 60000).toISOString(),
    table_name: 'A01', total: '25.00', pay_method: 'cash', cash_received: '30.00'
  };
  const { handler, calls, transactions, events } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  await handler(adminRequest({ cash_received: '30.00' }), res);

  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.startsWith("UPDATE orders SET status='done'"));
  assert.ok(update);
  assert.match(update.sql, /pay_khqr_ref='', pay_expires_at=''/);
  assert.equal(update.params[1], 30);
  assert.equal(update.params[2], 5);
  assert.deepEqual(transactions, ['begin', 'commit']);
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs')));
  assert.equal(events.length, 4);
});


test('waiter KHQR notification rejects sub-cent cash amounts before transaction', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 0,
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01',
    order_no: '110042', total: 25, pay_method: 'khqr'
  };
  const { handler, calls, transactions, events } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  const req = waiterRequest({ pay_method: 'cash', cash_received: '25.005', cash_change: '0.005' });
  // The notification route is registered separately from the legacy confirm route.
  const notificationHandlers = new Map();
  const app = {
    get() {}, put() {}, delete() {},
    post(path, ...callbacks) { notificationHandlers.set(path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async () => order,
    runAsync: async (sql, params) => { calls.push({ type: 'run', sql, params }); return { affectedRows: 1 }; },
    allAsync: async () => [],
    withTransaction: async work => { transactions.push('begin'); return work(); },
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
    io: { to() { return { emit(event, payload) { events.push({ event, payload }); } }; } }
  };
  registerAdminManageRoutes(app, deps);
  await notificationHandlers.get('/api/waiter/khqr/notify')(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /两位小数/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactions, []);
  assert.equal(events.length, 0);
});

test('KHQR confirmation rejects non-canonical order identifiers before database access', async () => {
  const { handler, calls, transactions } = setup();
  const res = response();
  await handler({ body: { order_id: '42abc' }, storeId: 9, isAdmin: true, isPrimaryAdmin: true, adminId: 3 }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.deepEqual(transactions, []);
});

test('KHQR generation rejects non-positive or non-integer order identifiers before database access', async () => {
  const { generateHandler, calls, transactions } = setup();
  for (const orderId of ['42abc', '0', '-1', '1.5', '9007199254740992', true, [], null]) {
    const res = response();
    await generateHandler({ body: { order_id: orderId }, storeId: 9, isAdmin: true, isPrimaryAdmin: true, adminId: 3 }, res);
    assert.equal(res.statusCode, 400, String(orderId));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(transactions, []);
});

test('KHQR confirmation rejects non-string and non-number identifiers', async () => {
  for (const orderId of [true, [], {}, null]) {
    const { handler, calls } = setup();
    const res = response();
    await handler({ body: { order_id: orderId }, storeId: 9, isAdmin: true, isPrimaryAdmin: true, adminId: 3 }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  }
});

test('cashier KHQR confirmation writes the parsed safe order ID, not the raw request value', async () => {
  const order = {
    id: 42, status: 'pending', awaiting_confirm: 1,
    pay_khqr_ref: 'dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pay_expires_at: new Date(Date.now() + 60000).toISOString(),
    table_name: 'A01', total: '25.00', pay_method: 'khqr'
  };
  const { handler, calls } = setup({ initialOrder: order, lockedOrder: order });
  const res = response();
  await handler(adminRequest({ order_id: '42' }), res);
  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.startsWith("UPDATE orders SET status='done'"));
  assert.ok(update);
  assert.equal(update.params[5], 42);
  assert.equal(typeof update.params[5], 'number');
});
