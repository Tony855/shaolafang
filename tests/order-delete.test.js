'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerOrderRoutes = require('../routes/orders');

function setup() {
  const handlers = new Map();
  const calls = [];
  const emissions = [];
  const order = {
    id: 9, order_no: '110009', table_name: 'A01', store_id: 7,
    status: 'done', total: 25, pay_method: 'cash', refund_amount: 0
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
      if (sql.includes('SELECT password_hash, username FROM merchant_admins')) return { password_hash: 'hash', username: 'admin-qa' };
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE')) return { ...order };
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=?')) return { ...order };
      if (sql.includes('SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE')) return { id: 1 };
      if (sql.includes('SELECT COUNT(*) AS cnt FROM orders')) return { cnt: 0 };
      return null;
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      return { affectedRows: 1 };
    },
    allAsync: async () => [],
    withTransaction: async work => work(),
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
    verifyPassword: () => true,
    authenticateAdmin: async () => ({ adminId: 2, merchantId: 3, storeId: 7 }),
    checkAndSetCooldown: async () => true,
    withTransaction: async work => work()
  };
  registerOrderRoutes(app, deps);
  return { handler: handlers.get('DELETE /api/orders/:id(\\d+)'), calls, emissions };
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
  const lockTable = calls.findIndex(x => x.type === 'get' && x.sql.includes('SELECT id FROM tables') && x.sql.includes('FOR UPDATE'));
  const lockOrder = calls.findIndex(x => x.type === 'get' && x.sql.includes('SELECT * FROM orders') && x.sql.includes('FOR UPDATE'));
  const deleteOrder = calls.findIndex(x => x.type === 'run' && x.sql.startsWith('DELETE FROM orders'));
  const audit = calls.find(x => x.type === 'audit');
  assert.ok(lockTable >= 0 && lockOrder > lockTable && deleteOrder > lockOrder);
  assert.ok(audit);
  assert.equal(audit.args[3], 'delete_order');
  assert.equal(audit.args[5], 9);
  assert.deepEqual(emissions.map(x => [x.room, x.event]), [
    ['kitchen-7', 'order:deleted'],
    ['waiter-7', 'order:deleted'],
    ['cashier-7', 'order:deleted'],
    ['public-table-7-A01', 'order:deleted']
  ]);
});
