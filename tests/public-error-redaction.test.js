'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const attachMenuRoutes = require('../routes/menu');
const attachCashierRoutes = require('../routes/cashier');
const attachSuperRoutes = require('../routes/super');

function pass(_req, _res, next) { if (next) next(); }

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function harness() {
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set('GET ' + route, handlers); },
    post(route, ...handlers) { routes.set('POST ' + route, handlers); },
    put(route, ...handlers) { routes.set('PUT ' + route, handlers); },
    delete(route, ...handlers) { routes.set('DELETE ' + route, handlers); }
  };
  return { app, routes };
}

const sensitiveError = new Error('ER_ACCESS_DENIED_ERROR db.internal:3306 user=foodflow password=do-not-return');

test('public menu endpoint does not expose database or connection details', async () => {
  const { app, routes } = harness();
  attachMenuRoutes(app, {
    getAsync: async () => { throw sensitiveError; },
    runAsync: async () => ({ affectedRows: 1, lastID: 1 }),
    allAsync: async () => [],
    requireAdminKey: pass,
    requirePermission: () => pass,
    requireAdminOrWaiter: pass,
    getWaiterFromRequest: async () => null,
    formatOrder: value => value,
    normalizeOrderItems: value => value,
    assertTableExists: async () => {},
    syncTableStatus: async () => {},
    ensureOrderTables: async () => {},
    io: { to: () => ({ emit() {} }) },
    getClientIp: () => '127.0.0.1',
    logAudit: async () => {},
    upload: { fields: () => pass, single: () => pass },
    UPLOAD_DIR: '/tmp',
    path,
    fs,
    allocateOrderNo: async () => 'unused',
    getOrderCooldownMs: () => 0,
    createTableToken: () => 'unused',
    buildReceipt: () => '',
    buildKitchenTicket: () => '',
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => {},
    verifyPassword: () => true,
    authenticateAdmin: async () => null,
    checkAndSetCooldown: async () => {},
    withTransaction: async work => work()
  });
  const handler = routes.get('GET /api/menu').at(-1);
  const res = response();
  await handler({ query: { store_id: '7' } }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '菜单加载失败，请稍后重试' });
  assert.doesNotMatch(JSON.stringify(res.body), /ER_ACCESS_DENIED|db\.internal|password=/i);
});

test('waiter login returns a generic server error when authentication storage fails', async () => {
  const { app, routes } = harness();
  attachCashierRoutes(app, {
    getAsync: async () => { throw sensitiveError; },
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => { throw sensitiveError; },
    withTransaction: async work => work(),
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    verifyPassword: () => false,
    getClientIp: () => '127.0.0.1',
    requireCashier: pass,
    requireAdminOrCashierOrWaiter: pass,
    formatOrder: value => value,
    syncTableStatus: async () => {},
    buildBatchReceipt: () => '',
    buildReceipt: () => '',
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => {},
    io: { to: () => ({ emit() {} }) }
  });
  const handler = routes.get('POST /api/waiter/login').at(-1);
  const res = response();
  await handler({ body: { username: 'waiter', password: 'password' } }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '服务员登录失败，请稍后重试' });
  assert.doesNotMatch(JSON.stringify(res.body), /ER_ACCESS_DENIED|db\.internal|password=/i);
});

test('super-admin login returns a generic server error when authentication storage fails', async () => {
  const { app, routes } = harness();
  attachSuperRoutes(app, {
    getAsync: async () => { throw sensitiveError; },
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => [],
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    verifyPassword: () => true,
    hashPassword: value => value,
    getClientIp: () => '127.0.0.1',
    getLocationByIp: async () => '',
    requireSuperAdmin: pass,
    logAudit: async () => {},
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({}),
    withTransaction: async work => work()
  });
  const handler = routes.get('POST /api/super/login').at(-1);
  const res = response();
  await handler({ body: { username: 'root', password: 'password' }, get: () => '' }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '超级管理员登录失败，请稍后重试' });
  assert.doesNotMatch(JSON.stringify(res.body), /ER_ACCESS_DENIED|db\.internal|password=/i);
});


test('route handlers never return raw exception messages for internal server errors', () => {
  const routeDir = path.join(__dirname, '..', 'routes');
  const files = fs.readdirSync(routeDir).filter(name => name.endsWith('.js'));
  const unsafePatterns = [
    /res\\.status\\(\\s*500\\s*\\)\\s*\\.json\\(\\s*\\{\\s*error\\s*:\\s*(?:e|error)\\.message\\b/,
    /res\\.status\\(\\s*(?:e|error)\\.status\\s*\\|\\|\\s*500\\s*\\)\\s*\\.json\\(\\s*\\{\\s*error\\s*:\\s*(?:e|error)\\.message\\b/,
    /res\\.status\\(\\s*(?:e|error)\\.statusCode\\s*\\|\\|\\s*500\\s*\\)\\s*\\.json\\(\\s*\\{\\s*error\\s*:\\s*(?:e|error)\\.message\\b/
  ];
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(routeDir, file), 'utf8');
    for (const pattern of unsafePatterns) {
      if (pattern.test(source)) violations.push(file + ': ' + pattern);
    }
  }
  assert.deepEqual(violations, []);
});
