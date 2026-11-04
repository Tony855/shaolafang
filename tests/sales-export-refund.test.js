const test = require('node:test');
const assert = require('node:assert/strict');
const attachAdminReports = require('../routes/admin-reports');

function middleware() {
  return (_req, _res, next) => next();
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
  assert.match(calls[0].sql, /o\.status IN \('done', 'refunded'\)/);
  assert.deepEqual(calls[0].params, [7]);
  assert.match(res.body, /Noodle/);
  assert.match(res.body, /42/);
});
