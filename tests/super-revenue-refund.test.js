'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');

function middleware() {
  return (_req, _res, next) => next();
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ invalidRefundCount = 0 } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = {
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); },
    delete(path, ...callbacks) { handlers.set('DELETE ' + path, callbacks[callbacks.length - 1]); }
  };
  const deps = {
    getAsync: async sql => {
      calls.push({ type: 'get', sql });
      if (sql.includes('invalid_count')) return { invalid_count: invalidRefundCount };
      if (sql.includes('SUM(GREATEST')) return { total: '40.00' };
      return { count: 1, total: '40.00' };
    },
    allAsync: async sql => {
      calls.push({ type: 'all', sql });
      return [];
    },
    runAsync: async () => ({ affectedRows: 1 }),
    withTransaction: async work => work(),
    requireSuperAdmin: middleware,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    verifyPassword: () => true,
    hashPassword: value => value,
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({})
  };
  attachSuperRoutes(app, deps);
  return { handlers, calls };
}

test('super revenue stats include fully refunded orders and clamp invalid negative net revenue', async () => {
  const { handlers, calls } = setup();
  const res = response();
  await handlers.get('GET /api/super/stats')({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.todayRevenue, 40);
  assert.equal(res.body.monthRevenue, 40);
  assert.equal(res.body.yearRevenue, 40);
  const revenueQueries = calls.filter(call => call.type === 'get' && call.sql.includes('SUM('));
  assert.equal(revenueQueries.length, 3);
  for (const query of revenueQueries) {
    assert.match(query.sql, /GREATEST\(0, total - COALESCE\(refund_amount,0\)\)/);
    assert.match(query.sql, /status IN \('done','refunded'\)/);
  }
});

test('super store revenue breakdown includes refunded orders with non-negative net totals', async () => {
  const { handlers, calls } = setup();
  const res = response();
  await handlers.get('GET /api/super/store-breakdown')({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.stores, []);
  const query = calls.find(call => call.type === 'all' && call.sql.includes('today_revenue'));
  assert.ok(query);
  assert.equal((query.sql.match(/GREATEST\(0, o\.total - COALESCE\(o\.refund_amount,0\)\)/g) || []).length, 3);
  assert.equal((query.sql.match(/o\.status IN \('done','refunded'\)/g) || []).length, 3);
});


test('super dashboard stats fail closed on corrupt refund history', async () => {
  const { handlers } = setup({ invalidRefundCount: 1 });
  const res = response();
  await handlers.get('GET /api/super/stats')({}, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /退款数据异常/);
});

test('super store breakdown fails closed on corrupt refund history', async () => {
  const { handlers, calls } = setup({ invalidRefundCount: 2 });
  const res = response();
  await handlers.get('GET /api/super/store-breakdown')({}, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /退款数据异常/);
  assert.equal(calls.some(call => call.type === 'all'), false);
});
