'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerAdminManageRoutes = require('../routes/admin-manage');

function setup({ order = { id: 42, status: 'pending', awaiting_confirm: 0, pay_khqr_ref: 'qr-payload', pay_expires_at: '2030-01-01T00:00:00.000Z', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01' }, affectedRows = 1, failAudit = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const transactionEvents = [];
  const app = {
    get() {},
    put() {},
    delete() {},
    post(path, ...callbacks) { handlers.set(path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM stores WHERE id=? AND merchant_id=?')) return { id: 9, name: 'Test Store' };
      if (sql.includes('FROM orders WHERE id=? AND store_id=? FOR UPDATE')) return { ...order };
      return null;
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params });
      if (failAudit && sql.includes('INSERT INTO audit_logs')) throw new Error('audit failure');
      return { affectedRows: sql.startsWith('UPDATE orders SET awaiting_confirm=0') ? affectedRows : 1 };
    },
    allAsync: async () => [],
    withTransaction: async work => {
      transactionEvents.push('begin');
      try {
        const result = await work();
        transactionEvents.push('commit');
        return result;
      } catch (error) {
        transactionEvents.push('rollback');
        throw error;
      }
    },
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
  return { handler: handlers.get('/api/cashier/khqr/cancel'), calls, transactionEvents };
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

test('conditional KHQR cancellation refuses to clear a different QR issued after the close request', async () => {
  const { handler, calls, transactionEvents } = setup({
    order: { id: 42, status: 'pending', awaiting_confirm: 0, pay_khqr_ref: 'newer-qr-payload', pay_expires_at: '2030-01-01T00:00:00.000Z', pay_qr_generation_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', table_name: 'A01' }
  });
  const res = response();
  await handler({
    body: { order_id: 42, expected_qr_ref: 'older-qr-payload', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    isAdmin: true, isPrimaryAdmin: true, storeId: 9, merchantId: 3, adminId: 1
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /二维码生成批次已变化/);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
});

test('active QR cannot be canceled by an unqualified stale close request', async () => {
  const { handler, calls, transactionEvents } = setup();
  const res = response();
  await handler({
    body: { order_id: 42 }, storeId: 9, merchantId: 3,
    isWaiter: true, waiter: { id: 7, store_id: 9, can_order: 1 }, waiterStoreId: 9
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /缺少二维码生成标识/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE orders SET awaiting_confirm=0')), false);
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
});

test('authorized waiter can cancel an unsubmitted QR with row lock and audit', async () => {
  const { handler, calls, transactionEvents } = setup();
  const res = response();
  await handler({
    body: { order_id: '42', expected_qr_ref: 'qr-payload', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, storeId: 9, merchantId: 3,
    isWaiter: true, waiter: { id: 7, store_id: 9, can_order: 1, display_name: 'QA waiter' }, waiterStoreId: 9
  }, res);
  assert.equal(res.statusCode, 200);
  const locked = calls.find(call => call.type === 'get' && call.sql.includes('FROM orders'));
  assert.match(locked.sql, /WHERE id=\? AND store_id=\? FOR UPDATE/);
  const update = calls.find(call => call.type === 'run' && call.sql.startsWith('UPDATE orders SET awaiting_confirm=0'));
  assert.ok(update);
  assert.match(update.sql, /AND status='pending' AND awaiting_confirm=\? AND pay_khqr_ref <=> \?/);
  const audit = calls.find(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(audit.params[0], 'waiter');
  assert.equal(audit.params[3], 'khqr_cancel');
  assert.deepEqual(transactionEvents, ['begin', 'commit']);
});

test('waiter cannot cancel a payment already submitted for cashier confirmation', async () => {
  const { handler, calls, transactionEvents } = setup({
    order: { id: 42, status: 'pending', awaiting_confirm: 1, pay_khqr_ref: 'qr-payload', table_name: 'A01' }
  });
  const res = response();
  await handler({
    body: { order_id: 42 }, storeId: 9, merchantId: 3,
    isWaiter: true, waiter: { id: 7, store_id: 9, can_order: 1 }, waiterStoreId: 9
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some(call => call.type === 'run'), false);
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
});

test('authorized cashier can cancel a submitted confirmation and the action is audited', async () => {
  const { handler, calls, transactionEvents } = setup({
    order: { id: 42, status: 'pending', awaiting_confirm: 1, pay_khqr_ref: 'qr-payload', pay_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', table_name: 'A01' }
  });
  const res = response();
  await handler({
    body: { order_id: 42, expected_qr_ref: 'qr-payload', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, storeId: 9, merchantId: 3,
    isCashier: true, cashier: { id: 8, username: 'qa-cashier', permissions: { can_settle: true } }
  }, res);
  assert.equal(res.statusCode, 200);
  const audit = calls.find(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(audit.params[0], 'cashier');
  assert.equal(audit.params[2], 'qa-cashier');
  assert.deepEqual(transactionEvents, ['begin', 'commit']);
});

test('cashier can cancel a manual payment confirmation that has no dynamic QR', async () => {
  const { handler, calls, transactionEvents } = setup({
    order: { id: 42, status: 'pending', awaiting_confirm: 1, pay_khqr_ref: '', pay_qr_generation_id: '', table_name: 'A01' }
  });
  const res = response();
  await handler({
    body: { order_id: 42 }, storeId: 9, merchantId: 3,
    isCashier: true, cashier: { id: 8, username: 'qa-cashier', permissions: { can_settle: true } }
  }, res);

  assert.equal(res.statusCode, 200);
  const update = calls.find(call => call.type === 'run' && call.sql.startsWith('UPDATE orders SET awaiting_confirm=0'));
  assert.ok(update);
  assert.equal(update.params[4], '');
  assert.deepEqual(transactionEvents, ['begin', 'commit']);
});

test('KHQR cancellation rolls back when the audit record cannot be written', async () => {
  const { handler, calls, transactionEvents } = setup({ failAudit: true });
  const res = response();
  await handler({
    body: { order_id: 42, expected_qr_ref: 'qr-payload', expected_qr_generation_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, storeId: 9, merchantId: 3,
    isAdmin: true, isPrimaryAdmin: true, adminId: 1, username: 'root'
  }, res);
  assert.equal(res.statusCode, 500);
  assert.ok(calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE orders')));
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
});

test('authorized waiter cancellation remains store-scoped and validates order id', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler({
    body: { order_id: '42' }, storeId: 9, merchantId: 3,
    isWaiter: true, waiter: { store_id: 8, can_order: 1 }, waiterStoreId: 8
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some(call => call.type === 'run'), false);
});

test('KHQR cancellation rejects coercible non-numeric identifiers before querying', async () => {
  for (const orderId of [true, false, [], {}, null, ' 42 ', '4.2', '4e1']) {
    const { handler, calls } = setup();
    const res = response();
    await handler({
      body: { order_id: orderId },
      isAdmin: true, isPrimaryAdmin: true, storeId: 9, merchantId: 5, adminId: 1
    }, res);
    assert.equal(res.statusCode, 400, String(orderId));
    assert.equal(calls.length, 0);
  }
});
