'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerOrderRoutes = require('../routes/orders');

function setup(status = 'pending', { failAudit = false, passwordValid = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const emissions = [];
  let rolledBack = false;
  const order = {
    id: 9, order_no: '110009', table_name: 'A01', store_id: 7,
    status, total: 25, pay_method: 'cash', refund_amount: 0
  };
  const app = {
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); },
    delete(path, ...callbacks) { handlers.set('DELETE ' + path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM merchant_admins') && sql.includes('FOR UPDATE')) return { id: 2, password_hash: 'hash', username: 'admin-qa' };
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE')) return { ...order };
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=?')) return { ...order };
      if (sql.includes('SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE')) return { id: 1 };
      if (sql.includes('SELECT COUNT(*) AS cnt FROM orders')) return { cnt: 0 };
      return null;
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      return { affectedRows: 1 };
    },
    allAsync: async () => [],
    withTransaction: async work => {
      try { return await work(); } catch (error) { rolledBack = true; throw error; }
    },
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    requireAdminOrWaiter: (_req, _res, next) => next(),
    getWaiterFromRequest: async () => null,
    formatOrder: value => value,
    normalizeOrderItems: async value => value,
    assertTableExists: async value => value,
    syncTableStatus: async () => {},
    ensureOrderTables: async () => {},
    io: { to: room => ({ emit: (event, payload) => emissions.push({ room, event, payload }) }) },
    getClientIp: () => '127.0.0.1',
    logAudit: async (...args) => { calls.push({ type: 'audit', args }); },
    upload: {},
    UPLOAD_DIR: '/tmp',
    path: require('node:path'),
    allocateOrderNo: async () => '110009',
    getOrderCooldownMs: async () => 3000,
    createTableToken: async () => 'token',
    buildReceipt: () => '',
    buildKitchenTicket: () => '',
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => {},
    verifyPassword: () => passwordValid,
    authenticateAdmin: async () => ({ adminId: 2, merchantId: 3, storeId: 7 }),
    checkAndSetCooldown: async () => true,
  };
  registerOrderRoutes(app, deps);
  return { handler: handlers.get('DELETE /api/orders/:id(\\d+)'), calls, emissions, get rolledBack() { return rolledBack; } };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('admin order deletion locks table and order, audits details and broadcasts deletion', async () => {
  const { handler, calls, emissions } = setup();
  const res = response();
  await handler({
    params: { id: '9' },
    body: { password: 'admin-password' },
    adminId: 2,
    merchantId: 3,
    storeId: 7
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const lockAdmin = calls.findIndex(x => x.type === 'get' && x.sql.includes('FROM merchant_admins') && x.sql.includes('FOR UPDATE'));
  const lockTable = calls.findIndex(x => x.type === 'get' && x.sql.includes('SELECT id FROM tables') && x.sql.includes('FOR UPDATE'));
  const lockOrder = calls.findIndex(x => x.type === 'get' && x.sql.includes('SELECT * FROM orders') && x.sql.includes('FOR UPDATE'));
  const deleteOrder = calls.findIndex(x => x.type === 'run' && x.sql.startsWith('DELETE FROM orders'));
  const audit = calls.find(x => x.type === 'run' && x.sql.startsWith('INSERT INTO audit_logs'));
  assert.ok(lockAdmin >= 0 && lockTable > lockAdmin && lockOrder > lockTable && deleteOrder > lockOrder);
  assert.ok(audit);
  assert.equal(audit.params[3], 'delete_order');
  assert.equal(audit.params[5], 9);
  assert.deepEqual(emissions.map(x => [x.room, x.event]), [
    ['kitchen-7', 'order:deleted'],
    ['waiter-7', 'order:deleted'],
    ['cashier-7', 'order:deleted'],
    ['public-table-7-A01', 'order:deleted']
  ]);
});


test('settled and refunded orders cannot be deleted', async () => {
  for (const status of ['done', 'refunded']) {
    const { handler, calls, emissions } = setup(status);
    const res = response();
    await handler({
      params: { id: '9' }, body: { password: 'admin-password' },
      adminId: 2, merchantId: 3, storeId: 7
    }, res);
    assert.equal(res.statusCode, 409, status);
    assert.match(res.body.error, /不能删除/);
    assert.equal(calls.some(x => x.type === 'run' && x.sql.startsWith('DELETE FROM orders')), false);
    assert.equal(calls.some(x => x.type === 'run' && x.sql.startsWith('INSERT INTO audit_logs')), false);
    assert.deepEqual(emissions, []);
  }
});

test('order deletion does not write when the locked admin password is invalid', async () => {
  const { handler, calls } = setup('pending', { passwordValid: false });
  const res = response();
  await handler({
    params: { id: '9' }, body: { password: 'wrong' },
    adminId: 2, merchantId: 3, storeId: 7
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(calls.some(x => x.type === 'run' && x.sql.startsWith('DELETE FROM orders')), false);
});

test('order deletion rolls back if strict audit insertion fails', async () => {
  const ctx = setup('pending', { failAudit: true });
  const { handler, calls } = ctx;
  const res = response();
  await handler({
    params: { id: '9' }, body: { password: 'admin-password' },
    adminId: 2, merchantId: 3, storeId: 7
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.ok(calls.some(x => x.type === 'run' && x.sql.startsWith('DELETE FROM orders')));
});
