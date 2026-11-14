'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerOrderRoutes = require('../routes/orders');

test('order creation logs only safe metadata when database access fails', async () => {
  let postHandler;
  const app = {
    post(route, ...handlers) {
      if (route === '/api/orders') postHandler = handlers[handlers.length - 1];
    },
    get() {},
    put() {},
    delete() {}
  };
  const secretMessage = 'DB_PASSWORD=do-not-log-this';
  const pass = (_req, _res, next) => next();
  registerOrderRoutes(app, {
    getAsync: async () => { throw new Error(secretMessage); },
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => [],
    requireAdminKey: pass,
    requirePermission: () => pass,
    requireAdminOrWaiter: pass,
    getWaiterFromRequest: async () => null,
    formatOrder: value => value,
    normalizeOrderItems: async value => value,
    assertTableExists: async value => value,
    syncTableStatus: async () => {},
    ensureOrderTables: async () => {},
    io: { to: () => ({ emit() {} }) },
    getClientIp: () => '127.0.0.1',
    logAudit: async () => {},
    upload: {},
    UPLOAD_DIR: '/tmp',
    path: require('node:path'),
    allocateOrderNo: async () => '110001',
    getOrderCooldownMs: async () => 3000,
    createTableToken: async () => 'token',
    buildReceipt: () => '',
    buildKitchenTicket: () => '',
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => ({ printed: false }),
    verifyPassword: () => true,
    authenticateAdmin: async () => null,
    checkAndSetCooldown: async () => true,
    withTransaction: async work => work()
  });

  assert.equal(typeof postHandler, 'function');
  const originalError = console.error;
  let logged;
  console.error = (...args) => { logged = args; };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  try {
    await postHandler({
      body: {
        table: 'A01',
        sessionToken: 'session-token',
        customerToken: 'customer-token',
        items: [{ id: 1, quantity: 1 }]
      },
      isAdmin: false
    }, res);
  } finally {
    console.error = originalError;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, '订单服务暂时不可用，请稍后重试');
  assert.deepEqual(logged, ['[POST /api/orders] 错误:', { name: 'Error' }]);
  assert.ok(!JSON.stringify(logged).includes(secretMessage));
});
