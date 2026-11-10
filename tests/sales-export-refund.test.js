const test = require('node:test');
const assert = require('node:assert/strict');
const attachAdminReports = require('../routes/admin-reports');

function middleware() {
  return (_req, _res, next) => next();
}

function assertNoStoreHeaders(res) {
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.headers.Pragma, 'no-cache');
  assert.equal(res.headers.Expires, '0');
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(value) { this.body = value; }
  };
}

test('sales CSV export includes refunded orders and respects returned quantities', async () => {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path, ...handlers) {
      routes.set(path, handlers[handlers.length - 1]);
    }
  };
  attachAdminReports(app, {
    getAsync: async () => ({}),
    allAsync: async (sql, params) => {
      calls.push({ sql, params });
      return [{
        id: 42,
        name: 'Noodle',
        price: 5,
        total_qty: 2,
        total_revenue: 0
      }];
    },
    requireAdminKey: middleware,
    requirePermission: () => middleware(),
    authenticateAdmin: middleware
  });

  const handler = routes.get('/api/admin/export/:type');
  assert.equal(typeof handler, 'function');
  const res = createResponse();
  await handler({ params: { type: 'sales' }, storeId: 7, isPrimaryAdmin: true }, res);

  assert.equal(res.statusCode, 200);
  assertNoStoreHeaders(res);
  assert.match(calls[0].sql, /o\.status IN \('done', 'refunded'\)/);
  assert.deepEqual(calls[0].params, [7]);
  assert.match(res.body, /Noodle/);
  assert.match(res.body, /42/);
});


test('order CSV export uses the database decimal net total instead of JS float subtraction', async () => {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path, ...handlers) {
      routes.set(path, handlers[handlers.length - 1]);
    }
  };
  attachAdminReports(app, {
    getAsync: async () => ({}),
    allAsync: async (sql, params) => {
      calls.push({ sql, params });
      return [{
        id: 42, table_name: 'A01', status: 'done',
        total: '0.30', refund_amount: '0.10', net_total: '0.20',
        note: '', createdAt: '2026-11-09T00:00:00.000Z'
      }];
    },
    requireAdminKey: middleware,
    requirePermission: () => middleware(),
    authenticateAdmin: middleware
  });

  const handler = routes.get('/api/admin/export/:type');
  const res = createResponse();
  await handler({ params: { type: 'orders' }, storeId: 7, isPrimaryAdmin: true }, res);

  assert.equal(res.statusCode, 200);
  assertNoStoreHeaders(res);
  assert.match(calls[0].sql, /GREATEST\(0, total - COALESCE\(refund_amount, 0\)\) AS net_total/);
  assert.match(res.body, /"0.20"/);
});


test('advanced CSV export is marked private and non-cacheable', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) {
      routes.set(path, handlers[handlers.length - 1]);
    }
  };
  attachAdminReports.attachAdvancedExport(app, {
    getAsync: async () => ({ invalid_count: 0 }),
    allAsync: async () => [{
      id: 42, order_no: '110042', table_name: 'A01',
      total: '0.30', refund_amount: '0.00', net_total: '0.30',
      status: 'done', pay_method: 'cash', note: '',
      createdAt: '2026-11-10T00:00:00.000Z',
      settled_at: '2026-11-10T00:01:00.000Z'
    }],
    requireAdminKey: middleware,
    requirePermission: () => middleware()
  });

  const handler = routes.get('/api/admin/export-advanced');
  const res = createResponse();
  await handler({
    storeId: 7,
    query: { startDate: '2026-11-10', endDate: '2026-11-10', dimension: 'orders', statuses: 'done' }
  }, res);

  assert.equal(res.statusCode, 200);
  assertNoStoreHeaders(res);
  assert.match(res.body, /110042/);
});
