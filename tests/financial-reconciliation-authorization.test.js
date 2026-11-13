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
      if (sql.includes('FROM financial_reconciliation_batches')) {
        return { id: 12, status: 'imported', currency_code: 'USD', row_count: 1 };
      }
      if (sql.includes('FROM financial_reconciliation_exception_alerts')) {
        return { id: 56, batch_id: 12, item_id: 34, merchant_id: 41, store_id: 93,
          alert_type: 'sla_overdue', status: 'pending' };
      }
      if (sql.includes('FROM financial_reconciliation_items i') && sql.includes("match_status='exception'")) {
        return { id: 34 };
      }
      if (sql.includes('FROM financial_reconciliation_exception_cases')) {
        return { id: 1, batch_id: 12, item_id: 34, merchant_id: 41, store_id: 93, status: 'open' };
      }
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
      limit: '25', afterRowNo: '0', batchId: '12', itemId: '34',
      alertId: '56'
    },
    params: { batchId: '12', itemId: '34', alertId: '56' },
    body: {},
    get: () => undefined
  };

  const cases = [
    { route: 'GET /api/admin/financial-reconciliation/batches' },
    { route: 'GET /api/admin/financial-reconciliation/batches/:batchId/items',
      dataQuery: 'FROM financial_reconciliation_items' },
    { route: 'GET /api/admin/financial-reconciliation/review-history' },
    { route: 'GET /api/admin/financial-reconciliation/journal-export' },
    { route: 'GET /api/admin/financial-reconciliation/month-close/period' },
    { route: 'GET /api/admin/financial-reconciliation/month-close/history' },
    { route: 'GET /api/admin/financial-reconciliation/monthly-close-preview' },
    { route: 'GET /api/admin/financial-reconciliation/daily-summary' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions/alerts' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions/alerts/:alertId/history',
      dataQuery: 'FROM financial_reconciliation_exception_alert_events' },
    { route: 'GET /api/admin/financial-reconciliation/period-summary' },
    { route: 'GET /api/admin/financial-reconciliation/period-report-export' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions/performance-summary' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions/performance-export' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions/performance-export-audit' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions/operations-summary' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions' },
    { route: 'GET /api/admin/financial-reconciliation/exceptions/:itemId/history',
      dataQuery: 'FROM financial_reconciliation_exception_events' }
  ];

  for (const { route, dataQuery } of cases) {
    const handler = routes.get(route)?.at(-1);
    assert.equal(typeof handler, 'function', 'missing route ' + route);
    const before = observations.length;
    const res = response();
    await handler(request, res);
    assert.notEqual(res.statusCode, 403, route + ' must accept the authenticated tenant context');
    const scopedQueries = observations.slice(before).filter(item => {
      const hasMerchant = item.params.some(value => String(value) === String(merchantId));
      const hasStore = item.params.some(value => String(value) === String(storeId)) ||
        item.params.some(value => typeof value === 'string' && value.includes('"store_id":' + storeId));
      return hasMerchant && hasStore && /merchant_id|merchant_admins|details LIKE/i.test(item.sql);
    });
    const query = dataQuery
      ? scopedQueries.find(item => item.sql.includes(dataQuery))
      : scopedQueries[0];
    assert.ok(query, route + ' must issue a tenant-scoped query' + (dataQuery ? ' for its result rows' : ''));
    assert.ok(!query.params.some(value => spoofed.includes(String(value))),
      route + ' must not bind attacker-supplied tenant or actor IDs');
    const serializedScopeParams = query.params.filter(value =>
      typeof value === 'string' && /"merchant_id"|"store_id"|"admin_id"|"actor_id"/.test(value)
    );
    const serializedSpoofed = serializedScopeParams.some(value => spoofed.some(id =>
      value.includes('"merchant_id":' + id) ||
      value.includes('"store_id":' + id) ||
      value.includes('"admin_id":' + id) ||
      value.includes('"actor_id":' + id)
    ));
    assert.ok(!serializedSpoofed,
      route + ' must not embed spoofed tenant or actor IDs inside serialized SQL filters');
    if (serializedScopeParams.length) {
      assert.ok(serializedScopeParams.some(value =>
        value.includes('"merchant_id":' + merchantId) && value.includes('"store_id":' + storeId)
      ), route + ' serialized tenant filters must use the authenticated merchant and store');
    }
  }
});


test('every financial mutation route rejects body/query actor spoofing when authenticated actor context is absent', async () => {
  const { routes, getDatabaseCalls } = setup();
  const mutationRoutes = [
    'POST /api/admin/financial-reconciliation/batches/import',
    'POST /api/admin/financial-reconciliation/month-close/transition',
    'POST /api/admin/financial-reconciliation/exceptions/alerts/generate',
    'POST /api/admin/financial-reconciliation/exceptions/alerts/:alertId/acknowledge',
    'POST /api/admin/financial-reconciliation/exceptions/alerts/:alertId/dismiss',
    'POST /api/admin/financial-reconciliation/exceptions/:itemId/workflow',
    'POST /api/admin/financial-reconciliation/items/:itemId/review'
  ];
  for (const route of mutationRoutes) {
    const handler = routes.get(route)?.at(-1);
    assert.equal(typeof handler, 'function', 'missing route ' + route);
    const res = response();
    await handler({
      merchantId: 41, storeId: 93,
      query: { adminId: '777', merchantId: '999', storeId: '888' },
      params: { itemId: '34', alertId: '56' },
      body: {
        adminId: 777, actorId: 777, merchantId: 999, storeId: 888,
        batchId: 12, action: 'confirm', reason: 'spoofed actor'
      },
      get: () => 'spoofed-idempotency-key'
    }, res);
    assert.equal(res.statusCode, 403, route + ' must require an authenticated finance actor');
  }
  assert.equal(getDatabaseCalls(), 0, 'actor spoofing must be rejected before any database access');
});
