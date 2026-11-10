'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerAdminManageRoutes = require('../routes/admin-manage');

function setup({ affectedRows = 1, order = null } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const transactionEvents = [];
  const app = {
    get() {},
    put() {},
    delete() {},
    post(path, ...callbacks) {
      handlers.set(path, callbacks[callbacks.length - 1]);
    }
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      return order || {
        id: 42, status: 'pending', awaiting_confirm: 0, pay_khqr_ref: 'issued-dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        table_name: 'A01', order_no: '110042', total: 25
      };
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      if (sql.startsWith('UPDATE orders SET awaiting_confirm=1')) {
        return { affectedRows };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      transactionEvents.push('begin');
      try { const result = await work(); transactionEvents.push('commit'); return result; }
      catch (error) { transactionEvents.push('rollback'); throw error; }
    },
    allAsync: async () => [],
    requireAdminOrWaiter: (_req, _res, next) => next(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    requireAdminOrCashier: (_req, _res, next) => next(),
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    requireAdminOrWaiter: (_req, _res, next) => next(),
    hashPassword: value => value,
    verifyPassword: () => true,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    syncTableStatus: async () => {},
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } }
  };
  registerAdminManageRoutes(app, deps);
  return {
    handler: handlers.get('/api/waiter/khqr/notify'),
    cancelHandler: handlers.get('/api/cashier/khqr/cancel'),
    calls, events, transactionEvents
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

test('waiter KHQR notification locks order and commits state plus audit before broadcasting', async () => {
  const { handler, calls, events, transactionEvents } = setup();
  const res = response();
  await handler({
    body: { order_id: '42', pay_method: 'khqr', payment_channel: 'khqr', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cash_received: 25, cash_change: 0 },
    waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'awaiting_confirm');
  const lockedRead = calls.find(call => call.type === 'get');
  assert.match(lockedRead.sql, /WHERE id=\? AND store_id=\? FOR UPDATE/);
  const update = calls.find(call => call.type === 'run' && call.sql.startsWith('UPDATE orders SET awaiting_confirm=1'));
  assert.ok(update);
  assert.match(update.sql, /WHERE id=\? AND store_id=\? AND status='pending' AND awaiting_confirm=0/);
  assert.deepEqual(update.params, ['khqr', 25, 0, 42, 9]);
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs')));
  assert.deepEqual(transactionEvents, ['begin', 'commit']);
  assert.equal(events.length, 1);
});


test('waiter KHQR notification rejects an order without an issued QR before state or audit writes', async () => {
  const { handler, calls, events, transactionEvents } = setup({
    order: {
      id: 42, status: 'pending', awaiting_confirm: 0, pay_khqr_ref: '',
      table_name: 'A01', order_no: '110042', total: 25
    }
  });
  const res = response();
  await handler({
    body: { order_id: 42, payment_channel: 'khqr', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pay_method: 'aba' },
    waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /尚未生成 KHQR/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.equal(events.length, 0);
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
});

test('manual cash notification remains available without a dynamic KHQR QR', async () => {
  const { handler, calls, events, transactionEvents } = setup({
    order: {
      id: 42, status: 'pending', awaiting_confirm: 0, pay_khqr_ref: '',
      table_name: 'A01', order_no: '110042', total: 25
    }
  });
  const res = response();
  await handler({
    body: { order_id: 42, payment_channel: 'manual', pay_method: 'cash', cash_received: '30.00', cash_change: '5.00' },
    waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('UPDATE orders SET awaiting_confirm=1')));
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs')));
  assert.equal(events.length, 1);
  assert.deepEqual(transactionEvents, ['begin', 'commit']);
});

test('waiter KHQR notification rejects a concurrent state change without broadcasting or auditing', async () => {
  const { handler, calls, events, transactionEvents } = setup({ affectedRows: 0 });
  const res = response();
  await handler({
    body: { order_id: 42, payment_channel: 'khqr', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', pay_method: 'khqr' },
    waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(events.length, 0);
  assert.equal(calls.filter(call => call.type === 'run').length, 1);
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
});

test('waiter KHQR notification rejects invalid order identifiers before querying', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler({
    body: { order_id: '42 OR 1=1' },
    waiter: { id: 7, store_id: 9, can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});


test('repeated waiter KHQR notification is idempotent and does not duplicate audit or broadcast', async () => {
  const { handler, calls, events, transactionEvents } = setup({
    order: { id: 42, status: 'pending', awaiting_confirm: 1, pay_khqr_ref: 'issued-dynamic-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01', order_no: '110042', total: 25 }
  });
  const res = response();
  await handler({
    body: { order_id: 42, pay_method: 'khqr' },
    waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.already, true);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactionEvents, ['begin', 'commit']);
  assert.equal(events.length, 0);
});

test('stale waiter notification cannot target a replacement QR generation with identical payload', async () => {
  const { handler, calls, events, transactionEvents } = setup({
    order: {
      id: 42, status: 'pending', awaiting_confirm: 0,
      pay_khqr_ref: 'same-dynamic-payload',
      pay_qr_generation_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      table_name: 'A01', order_no: '110042', total: 25
    }
  });
  const res = response();
  await handler({
    body: {
      order_id: 42, payment_channel: 'khqr', pay_method: 'aba',
      expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    },
    waiter: { id: 7, store_id: 9, display_name: 'QA waiter', can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /二维码已变化/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.equal(events.length, 0);
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
});

test('waiter KHQR notification rejects non-finite tender values before starting transaction', async () => {
  const { handler, calls, transactionEvents } = setup();
  const res = response();
  await handler({
    body: { order_id: 42, pay_method: 'cash', cash_received: 'Infinity' },
    waiter: { id: 7, store_id: 9, can_order: 1 },
    waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal(transactionEvents.length, 0);
});

test('waiter KHQR notification rejects coercible non-numeric identifiers before querying', async () => {
  for (const orderId of [true, false, [], {}, null, ' 42 ', '4.2', '4e1']) {
    const { handler, calls } = setup();
    const res = response();
    await handler({
      body: { order_id: orderId, pay_method: 'khqr' },
      waiter: { id: 7, store_id: 9, can_order: 1 },
      waiterStoreId: 9
    }, res);
    assert.equal(res.statusCode, 400, String(orderId));
    assert.equal(calls.length, 0);
  }
});

test('KHQR cancellation rejects coercible non-numeric identifiers before querying', async () => {
  for (const orderId of [true, false, [], {}, null, ' 42 ', '4.2', '4e1']) {
    const { cancelHandler, calls } = setup();
    const res = response();
    await cancelHandler({
      body: { order_id: orderId },
      isAdmin: true, isPrimaryAdmin: true, storeId: 9, merchantId: 5, adminId: 1
    }, res);
    assert.equal(res.statusCode, 400, String(orderId));
    assert.equal(calls.length, 0);
  }
});
