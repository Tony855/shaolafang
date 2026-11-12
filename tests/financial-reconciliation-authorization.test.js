'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/financial-reconciliation');

function setup() {
  const routes = new Map();
  const permissionCalls = [];
  let databaseCalls = 0;
  const adminAuth = function adminAuth(_req, _res, next) { next(); };
  const financePermission = function financePermission(_req, _res, next) { next(); };
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async () => { databaseCalls += 1; return { affectedRows: 1 }; },
    getAsync: async () => { databaseCalls += 1; return null; },
    allAsync: async () => { databaseCalls += 1; return []; },
    withTransaction: async work => work(),
    requireAdminKey: adminAuth,
    requirePermission: permission => {
      permissionCalls.push(permission);
      return financePermission;
    }
  });
  return { routes, permissionCalls, adminAuth, financePermission, getDatabaseCalls: () => databaseCalls };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

test('every financial reconciliation route is protected by admin authentication and finance permission', () => {
  const { routes, permissionCalls, adminAuth, financePermission } = setup();
  assert.equal(permissionCalls.length, 1);
  assert.equal(permissionCalls[0], 'can_manage_financial_reconciliation');
  assert.ok(routes.size >= 20, 'expected the full finance route set to be registered');

  for (const [route, handlers] of routes) {
    assert.equal(handlers[0], adminAuth, route + ' must require administrator authentication');
    assert.equal(handlers[1], financePermission, route + ' must require finance reconciliation permission');
    assert.equal(typeof handlers[2], 'function', route + ' must register a route handler');
  }
});

test('finance read and export handlers reject missing merchant, store, or actor context before database access', async () => {
  const { routes, getDatabaseCalls } = setup();
  const protectedRoutes = [
    'GET /api/admin/financial-reconciliation/batches',
    'GET /api/admin/financial-reconciliation/daily-summary',
    'GET /api/admin/financial-reconciliation/period-summary',
    'GET /api/admin/financial-reconciliation/period-report-export',
    'GET /api/admin/financial-reconciliation/exceptions',
    'GET /api/admin/financial-reconciliation/exceptions/performance-summary',
    'GET /api/admin/financial-reconciliation/exceptions/performance-export-audit',
    'GET /api/admin/financial-reconciliation/monthly-close-preview'
  ];

  for (const route of protectedRoutes) {
    const handlers = routes.get(route);
    assert.ok(handlers, 'missing route ' + route);
    const res = response();
    await handlers.at(-1)({ query: {}, params: {}, body: {} }, res);
    assert.equal(res.statusCode, 403, route + ' must reject missing tenant context');
  }
  assert.equal(getDatabaseCalls(), 0, 'invalid tenant context must be rejected before any database access');
});

test('period report reads tenant scope only from authenticated request context, not query parameters', async () => {
  const seen = [];
  const routes2 = new Map();
  const app2 = {
    get(path, ...handlers) { routes2.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes2.set('POST ' + path, handlers); }
  };
  // Register once on the capturing app so the terminal route handler is exercised.
  registerRoutes(app2, {
    runAsync: async () => ({ affectedRows: 1 }),
    getAsync: async () => null,
    allAsync: async (_sql, params) => { seen.push(params); return []; },
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  const res = response();
  await routes2.get('GET /api/admin/financial-reconciliation/period-summary').at(-1)(
    { merchantId: 4, storeId: 9, adminId: 7,
      query: { merchantId: '999', storeId: '888', period: 'day', from: '2026-11-12', to: '2026-11-12' } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen[0].slice(0, 2), [4, 9]);
});

test('every registered finance endpoint rejects spoofed tenant IDs before database access', async () => {
  const { routes, getDatabaseCalls } = setup();
  assert.ok(routes.size >= 20, 'the tenant matrix must cover the complete registered finance route set');

  for (const [route, handlers] of routes) {
    const res = response();
    await handlers.at(-1)({
      // These are attacker-controlled request values and must never establish tenant scope.
      query: { merchantId: '999', storeId: '888', adminId: '777' },
      params: { merchantId: '999', storeId: '888', adminId: '777', batchId: '1', itemId: '1', alertId: '1' },
      body: { merchantId: 999, storeId: 888, adminId: 777 },
      get: () => 'attacker-idempotency-key'
    }, res);
    assert.equal(res.statusCode, 403, route + ' must reject missing authenticated tenant context');
  }

  assert.equal(getDatabaseCalls(), 0,
    'no finance endpoint may query or mutate data when authenticated tenant context is absent');
});

test('authenticated tenant scope overrides spoofed merchant and store IDs across finance read surfaces', async () => {
  const merchantId = 41;
  const storeId = 93;
  const actorId = 17;
  const spoofed = ['999', '888', '777'];
  const observations = [];

  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async (sql, params = []) => {
      observations.push({ kind: 'run', sql, params });
      return { affectedRows: 1, insertId: 1 };
    },
    getAsync: async (sql, params = []) => {
      observations.push({ kind: 'get', sql, params });
      if (sql.includes('SELECT username FROM merchant_admins')) return { username: 'finance-admin' };
      return null;
    },
    allAsync: async (sql, params = []) => {
      observations.push({ kind: 'all', sql, params });
      return [];
    },
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });

  const request = {
    merchantId, storeId, adminId: actorId,
    query: {
      merchantId: spoofed[0], storeId: spoofed[1], adminId: spoofed[2],
      from: '2026-11-01', to: '2026-11-12', period: 'day',
      month: '2026-11', currencyCode: 'USD', slaHours: '24',
      limit: '25'
    },
    params: { batchId: '12', itemId: '34' },
    body: {},
    get: () => undefined
  };

  const cases = [
    ['GET /api/admin/financial-reconciliation/batches', 'all'],
    ['GET /api/admin/financial-reconciliation/period-summary', 'all'],
    ['GET /api/admin/financial-reconciliation/month-close/period', 'get'],
    ['GET /api/admin/financial-reconciliation/batches/:batchId/items', 'get'],
    ['GET /api/admin/financial-reconciliation/exceptions/performance-export-audit', 'all']
  ];

  for (const [route, expectedKind] of cases) {
    const handler = routes.get(route)?.at(-1);
    assert.equal(typeof handler, 'function', 'missing route ' + route);
    const before = observations.length;
    const res = response();
    await handler(request, res);
    assert.notEqual(res.statusCode, 403, route + ' must accept the authenticated tenant context');
    const query = observations.slice(before).find(item => item.kind === expectedKind);
    assert.ok(query, route + ' must execute its expected tenant-scoped query');
    assert.match(query.sql, /merchant_id|merchantId|merchant_admins/i,
      route + ' query must contain an explicit merchant ownership predicate');
    assert.ok(query.params.includes(merchantId),
      route + ' must bind the authenticated merchant ID');
    assert.ok(!query.params.some(value => spoofed.includes(String(value))),
      route + ' must not bind attacker-supplied tenant or actor IDs');
    if (route === 'GET /api/admin/financial-reconciliation/exceptions/performance-export-audit') {
      assert.ok(query.params.some(value => typeof value === 'string' && value.includes('"store_id":' + storeId)),
        route + ' must filter audit details by the authenticated store ID');
    } else {
      assert.ok(query.params.includes(storeId),
        route + ' must bind the authenticated store ID');
    }
  }
});
