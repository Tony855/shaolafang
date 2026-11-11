'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/financial-reconciliation');

function setup({ rows = [] } = {}) {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  const deps = {
    runAsync: async () => ({ affectedRows: 1 }),
    getAsync: async () => null,
    allAsync: async (sql, params) => { calls.push({ sql, params }); return rows; },
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  };
  registerRoutes(app, deps);
  return { routes, calls };
}

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(body) { this.body = body; return this; }
  };
}

test('batch listing is tenant-scoped and returns a descending pagination cursor', async () => {
  const rows = [{ id: 27, merchant_id: 4, store_id: 9 }, { id: 26, merchant_id: 4, store_id: 9 }];
  const { routes, calls } = setup({ rows });
  const handler = routes.get('GET /api/admin/financial-reconciliation/batches').at(-1);
  const res = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 12, query: { limit: '2' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.rows, rows);
  assert.equal(res.body.nextCursor, 26);
  assert.match(calls[0].sql, /b\.merchant_id=\? AND b\.store_id=\?/);
  assert.deepEqual(calls[0].params, [4, 9, 4, 9, 0, Number.MAX_SAFE_INTEGER, 3]);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
});

test('batch listing applies the cursor to the next descending page', async () => {
  const { routes, calls } = setup();
  const handler = routes.get('GET /api/admin/financial-reconciliation/batches').at(-1);
  const res = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 12, query: { afterId: '26', limit: '10' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].params, [4, 9, 4, 9, 26, 26, 11]);
});

test('batch listing rejects invalid pagination without querying the database', async () => {
  const { routes, calls } = setup();
  const handler = routes.get('GET /api/admin/financial-reconciliation/batches').at(-1);
  const res = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 12, query: { afterId: '-1', limit: '1000' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('batch listing refuses requests without authenticated tenant context', async () => {
  const { routes, calls } = setup();
  const handler = routes.get('GET /api/admin/financial-reconciliation/batches').at(-1);
  const res = response();
  await handler({ merchantId: 4, storeId: null, adminId: 12, query: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});
