const test = require('node:test');
const assert = require('node:assert/strict');
const registerDisplayRoutes = require('../routes/display');

function setup(options = {}) {
  const routes = new Map();
  const writes = [];
  let rolledBack = false;
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers[handlers.length - 1]); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers[handlers.length - 1]); }
  };
  const allAsync = async (sql, params) => {
    if (options.allAsync) return options.allAsync(sql, params);
    return [];
  };
  const runAsync = async (sql, params) => {
    if (options.runAsync) return options.runAsync(sql, params, writes);
    writes.push({ sql, params });
    return { affectedRows: 1 };
  };
  const withTransaction = async work => {
    try { return await work(); }
    catch (error) { rolledBack = true; throw error; }
  };
  registerDisplayRoutes(app, {
    allAsync, runAsync, withTransaction,
    requireAdminKey: (_req, _res, next) => next && next(),
    requirePermission: () => (_req, _res, next) => next && next()
  });
  return { routes, writes, get rolledBack() { return rolledBack; } };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('display settings reject out-of-range durations before writing', async () => {
  const app = setup();
  const res = response();
  await app.routes.get('POST /api/admin/display-page-settings')(
    { storeId: 7, body: { image_duration: 0 } }, res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(app.writes.length, 0);
});

test('display settings normalize accepted flags and language arrays in a transaction', async () => {
  const app = setup();
  const res = response();
  await app.routes.get('POST /api/admin/display-page-settings')(
    { storeId: 7, body: { image_duration: 12, show_price: '0', languages: ['zh', 'en', 'zh'] } }, res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(app.writes.length, 3);
  assert.deepEqual(app.writes.map(item => item.params[1]), ['12', '0', '["zh","en"]']);
});

test('public display settings reject partially numeric store identifiers', async () => {
  const app = setup();
  const res = response();
  await app.routes.get('GET /api/public/display-page-settings')(
    { query: { store_id: '2abc' } }, res
  );
  assert.equal(res.statusCode, 400);
});

test('apply-all rolls back on a failed write and does not expose database errors', async () => {
  let calls = 0;
  const app = setup({
    allAsync: async sql => {
      if (sql.includes('FROM merchants')) return [{ id: 3 }];
      if (sql.includes('FROM stores WHERE id=')) return [{ id: 7 }];
      if (sql.includes('FROM stores WHERE merchant_id=')) return [{ id: 7 }, { id: 8 }];
      return [];
    },
    runAsync: async () => {
      calls++;
      if (calls === 2) throw new Error('sensitive SQL connection details');
      return { affectedRows: 1 };
    }
  });
  const res = response();
  await app.routes.get('POST /api/admin/display-page-settings/apply-all')(
    { storeId: 7, merchantId: 3 }, res
  );
  assert.equal(app.rolledBack, true);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.includes('sensitive SQL'), false);
});
