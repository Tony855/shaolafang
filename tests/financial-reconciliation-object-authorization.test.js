'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/financial-reconciliation');

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

function register({ getAsync, runAsync, allAsync = async () => [] }) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async (sql, params = []) => runAsync(sql, params),
    getAsync: async (sql, params = []) => getAsync(sql, params),
    allAsync: async (sql, params = []) => allAsync(sql, params),
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  return routes;
}

test('valid tenant session cannot review a foreign statement item by guessing its ID', async () => {
  const reads = [];
  const writes = [];
  const routes = register({
    runAsync: async (sql, params) => { writes.push({ sql, params }); return { affectedRows: 1 }; },
    getAsync: async (sql, params) => {
      reads.push({ sql, params });
      if (sql.includes('SELECT username FROM merchant_admins')) return { username: 'tenant-a-finance' };
      if (sql.includes('DATE_FORMAT(imported_at')) return { id: 1, currency_code: 'USD', period_month: '2026-11' };
      if (sql.includes('FROM financial_month_close_periods')) return { id: 90, status: 'open' };
      if (sql.includes('FROM financial_reconciliation_batches')) return { id: 1, status: 'imported' };
      if (sql.includes('FROM financial_reconciliation_items')) return null;
      return null;
    }
  });

  const handler = routes.get('POST /api/admin/financial-reconciliation/items/:itemId/review').at(-1);
  const res = response();
  await handler({
    merchantId: 4, storeId: 9, adminId: 7,
    params: { itemId: '13' },
    query: { merchantId: '99', storeId: '88' },
    body: {
      batchId: 1, action: 'confirm', journalTransactionId: 31,
      reason: 'Verify tenant-owned statement row',
      idempotencyKey: 'tenant-a-review-foreign-01'
    },
    get: () => 'tenant-a-review-foreign-01'
  }, res);

  assert.equal(res.statusCode, 404);
  const itemLookup = reads.find(entry => entry.sql.includes('FROM financial_reconciliation_items'));
  assert.ok(itemLookup, 'review must perform a tenant-scoped item ownership lookup');
  assert.match(itemLookup.sql, /WHERE id=\\? AND batch_id=\\? AND merchant_id=\\? AND store_id=\\?/);
  assert.deepEqual(itemLookup.params, [13, 1, 4, 9]);
  assert.equal(writes.some(entry => /UPDATE financial_reconciliation_items|INSERT INTO financial_reconciliation_review_events/.test(entry.sql)), false,
    'a foreign item ID must not cause financial or audit writes');
});

for (const action of ['acknowledge', 'dismiss']) {
  test('valid tenant session cannot ' + action + ' a foreign SLA alert by guessing its ID', async () => {
    const reads = [];
    const writes = [];
    const routes = register({
      runAsync: async (sql, params) => { writes.push({ sql, params }); return { affectedRows: 1 }; },
      getAsync: async (sql, params) => {
        reads.push({ sql, params });
        if (sql.includes('SELECT username FROM merchant_admins')) return { username: 'tenant-a-finance' };
        return null;
      }
    });

    const key = 'tenant-a-alert-' + action + '-0001';
    const handler = routes.get('POST /api/admin/financial-reconciliation/exceptions/alerts/:alertId/' + action).at(-1);
    const res = response();
    await handler({
      merchantId: 4, storeId: 9, adminId: 7,
      params: { alertId: '777' },
      query: { merchantId: '99', storeId: '88' },
      body: { reason: 'Reviewed foreign alert identifier', idempotencyKey: key },
      get: () => key
    }, res);

    assert.equal(res.statusCode, 404);
    const replayLookup = reads.find(entry => entry.sql.includes('idempotency_key=? FOR UPDATE'));
    assert.ok(replayLookup, 'alert idempotency replay must be checked');
    assert.match(replayLookup.sql, /alert_id=\\? AND merchant_id=\\? AND store_id=\\? AND idempotency_key=\\?/);
    assert.deepEqual(replayLookup.params, [777, 4, 9, key]);
    const alertLookup = reads.find(entry => entry.sql.includes('FROM financial_reconciliation_exception_alerts'));
    assert.ok(alertLookup, 'alert ownership must be checked');
    assert.match(alertLookup.sql, /id=\\? AND merchant_id=\\? AND store_id=\\?/);
    assert.deepEqual(alertLookup.params, [777, 4, 9]);
    assert.equal(writes.some(entry => /UPDATE financial_reconciliation_exception_alerts|INSERT INTO financial_reconciliation_exception_alert_events/.test(entry.sql)), false,
      'a foreign alert ID must not cause state or audit writes');
  });
}
