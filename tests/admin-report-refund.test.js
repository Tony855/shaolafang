const test = require('node:test');
const assert = require('node:assert/strict');
const attachAdminReports = require('../routes/admin-reports');

function middleware() {
  return (_req, _res, next) => next();
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('daily admin report includes fully refunded orders and reports net revenue', async () => {
  const routes = new Map();
  const sqlCalls = [];
  const app = {
    get(path, ...handlers) {
      routes.set(path, handlers[handlers.length - 1]);
    }
  };
  attachAdminReports(app, {
    getAsync: async (sql, params) => {
      sqlCalls.push({ sql, params });
      return {
        total_orders: 3,
        completed_orders: 2,
        canceled_orders: 1,
        total_revenue: 40,
        avg_order_value: 20,
        refunded_orders: 1,
        total_refunded: 110,
        invalid_refund_orders: 0
      };
    },
    allAsync: async (sql, params) => {
      sqlCalls.push({ sql, params });
      return [];
    },
    requireAdminKey: middleware,
    requirePermission: () => middleware(),
    authenticateAdmin: middleware
  });

  const handler = routes.get('/api/admin/reports/daily');
  assert.equal(typeof handler, 'function');
  const res = createResponse();
  await handler({
    query: { startDate: '2026-11-04', endDate: '2026-11-04', scope: 'current' },
    storeId: 7,
    merchantId: 3
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.summary.completedOrders, 2);
  assert.equal(res.body.summary.totalRevenue, 40);
  assert.equal(res.body.summary.refundedOrders, 1);
  assert.equal(res.body.summary.totalRefunded, 110);

  const aggregateSql = sqlCalls[0].sql;
  assert.match(aggregateSql, /status IN \('done', 'refunded'\)/);
  assert.match(aggregateSql, /status='refunded'/);
  assert.equal(sqlCalls[0].params.length, 24);
});


test('daily admin report fails closed when historical refund exceeds order total', async () => {
  const routes = new Map();
  const sqlCalls = [];
  const app = { get(path, ...handlers) { routes.set(path, handlers[handlers.length - 1]); } };
  attachAdminReports(app, {
    getAsync: async (sql, params) => {
      sqlCalls.push({ sql, params });
      return { invalid_refund_orders: 1 };
    },
    allAsync: async (sql, params) => { sqlCalls.push({ sql, params }); return []; },
    requireAdminKey: middleware,
    requirePermission: () => middleware(),
    authenticateAdmin: middleware
  });
  const res = createResponse();
  await routes.get('/api/admin/reports/daily')({
    query: { startDate: '2026-11-04', endDate: '2026-11-04', scope: 'current' },
    storeId: 7, merchantId: 3
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /退款数据异常/);
  assert.equal(sqlCalls.length, 1);
  assert.match(sqlCalls[0].sql, /refund_amount, 0\) > total/);
});

test('admin summary report refuses to publish totals with invalid refund records', async () => {
  const routes = new Map();
  const app = { get(path, ...handlers) { routes.set(path, handlers[handlers.length - 1]); } };
  attachAdminReports(app, {
    getAsync: async () => ({ revenue: 10, orders: 1, invalid_refunds: 1 }),
    allAsync: async () => [],
    requireAdminKey: middleware,
    requirePermission: () => middleware(),
    authenticateAdmin: middleware
  });
  const res = createResponse();
  await routes.get('/api/admin/reports/summary')({ storeId: 7 }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /退款数据异常/);
});
