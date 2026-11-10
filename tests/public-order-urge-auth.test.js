'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachAdminManageRoutes = require('../routes/admin-manage');
const { hashSessionToken } = require('../server/services/session-token');

const pass = (_req, _res, next) => next();

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ orderMatches = true } = {}) {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); },
    put(path, ...handlers) { routes.set('PUT ' + path, handlers); },
    delete(path, ...handlers) { routes.set('DELETE ' + path, handlers); }
  };
  const session = {
    table_name: 'A01',
    store_id: 7,
    expires_at: new Date(Date.now() + 60000).toISOString()
  };
  attachAdminManageRoutes(app, {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM scan_sessions')) return session;
      if (sql.includes('FROM tables')) return { id: 1 };
      if (sql.includes('FROM stores')) return { id: 7 };
      if (sql.includes('FROM orders')) {
        return orderMatches ? {
          id: 42, table_name: 'A01', store_id: 7, session_token: 'session-A',
          customer_token: 'customer-A', status: 'pending'
        } : null;
      }
      if (sql.includes('FROM waiter_calls')) return null;
      return null;
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params });
      return { affectedRows: 1 };
    },
    allAsync: async () => [],
    withTransaction: async work => work(),
    syncTableStatus: async () => {},
    requireAdminKey: pass,
    requirePermission: () => pass,
    requireAdminOrCashier: pass,
    requireAdminOrCashierOrWaiter: pass,
    requireAdminOrWaiter: pass,
    hashPassword: value => value,
    verifyPassword: () => true,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    io: { to: () => ({ emit() {} }) }
  });
  return { handler: routes.get('POST /api/orders/:id(\\d+)/urge').at(-1), calls };
}

test('public order urge requires both scan and customer credentials', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ params: { id: '42' }, body: { sessionToken: 'session-A' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.calls.length, 0);
});

test('public order urge cannot target another customer or another scan session order', async () => {
  const ctx = setup({ orderMatches: false });
  const res = response();
  await ctx.handler({
    params: { id: '42' },
    body: { sessionToken: 'session-A', customerToken: 'customer-B' }
  }, res);
  assert.equal(res.statusCode, 404);
  const orderLookup = ctx.calls.find(call => call.type === 'get' && call.sql.includes('FROM orders'));
  assert.ok(orderLookup);
  assert.match(orderLookup.sql, /session_token=\? AND customer_token=\?/);
  assert.deepEqual(orderLookup.params, [42, 7, 'A01', hashSessionToken('session-A'), hashSessionToken('customer-B')]);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO waiter_calls')), false);
});

test('public order urge succeeds only when both credentials match the order', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({
    params: { id: '42' },
    body: { sessionToken: 'session-A', customerToken: 'customer-A' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO waiter_calls')));
});
