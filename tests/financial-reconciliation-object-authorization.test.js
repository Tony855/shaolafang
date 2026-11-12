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
  assert.match(itemLookup.sql, /WHERE id=\? AND batch_id=\? AND merchant_id=\? AND store_id=\?/);
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
    assert.match(replayLookup.sql, /alert_id=\? AND merchant_id=\? AND store_id=\? AND idempotency_key=\?/);
    assert.deepEqual(replayLookup.params, [777, 4, 9, key]);
    const alertLookup = reads.find(entry => entry.sql.includes('FROM financial_reconciliation_exception_alerts'));
    assert.ok(alertLookup, 'alert ownership must be checked');
    assert.match(alertLookup.sql, /id=\? AND merchant_id=\? AND store_id=\?/);
    assert.deepEqual(alertLookup.params, [777, 4, 9]);
    assert.equal(writes.some(entry => /UPDATE financial_reconciliation_exception_alerts|INSERT INTO financial_reconciliation_exception_alert_events/.test(entry.sql)), false,
      'a foreign alert ID must not cause state or audit writes');
  });
}


test('valid tenant session cannot transition a foreign exception item by guessing its ID', async () => {
  const reads = [];
  const writes = [];
  const routes = register({
    runAsync: async (sql, params) => {
      writes.push({ sql, params });
      return { insertId: 90, affectedRows: 1 };
    },
    getAsync: async (sql, params) => {
      reads.push({ sql, params });
      if (sql.includes('SELECT username FROM merchant_admins')) return { username: 'tenant-a-finance' };
      if (sql.includes('FROM financial_reconciliation_batches')) {
        return { id: 1, currency_code: 'USD', period_month: '2026-11' };
      }
      if (sql.includes('FROM financial_month_close_periods')) return { id: 90, status: 'open' };
      if (sql.includes('FROM financial_reconciliation_exception_events')) return null;
      if (sql.includes('FROM financial_reconciliation_items')) return null;
      return null;
    }
  });

  const key = 'tenant-a-exception-foreign-0001';
  const handler = routes.get('POST /api/admin/financial-reconciliation/exceptions/:itemId/workflow').at(-1);
  const res = response();
  await handler({
    merchantId: 4, storeId: 9, adminId: 7,
    params: { itemId: '101' },
    query: { merchantId: '99', storeId: '88' },
    body: {
      batchId: 1, action: 'start',
      reason: 'Attempt foreign exception transition',
      idempotencyKey: key
    },
    get: () => key
  }, res);

  assert.equal(res.statusCode, 404);
  const itemLookup = reads.find(entry => entry.sql.includes('FROM financial_reconciliation_items'));
  assert.ok(itemLookup, 'exception workflow must verify item ownership before creating a case');
  assert.match(itemLookup.sql, /WHERE i\.id=\? AND i\.batch_id=\? AND i\.merchant_id=\? AND i\.store_id=\?/);
  assert.deepEqual(itemLookup.params, [101, 1, 4, 9]);
  assert.equal(writes.some(entry => /INSERT INTO financial_reconciliation_exception_cases|UPDATE financial_reconciliation_exception_cases|INSERT INTO financial_reconciliation_exception_events/.test(entry.sql)), false,
    'a foreign exception item ID must not create, mutate, or audit an exception case');
});


test('month-close transition uses authenticated tenant and actor context, ignoring spoofed body IDs', async () => {
  const reads = [];
  const writes = [];
  const routes = register({
    runAsync: async (sql, params = []) => {
      writes.push({ sql, params });
      if (sql.includes('INSERT INTO financial_month_close_periods')) return { insertId: 90 };
      if (sql.includes('INSERT INTO financial_month_close_events')) return { insertId: 91 };
      return { affectedRows: 1 };
    },
    getAsync: async (sql, params = []) => {
      reads.push({ sql, params });
      if (sql.includes('SELECT username FROM merchant_admins')) return { username: 'tenant-a-finance' };
      if (sql.includes('FROM financial_month_close_periods')) {
        return {
          id: 90, merchant_id: 4, store_id: 9,
          period_month: '2026-11', currency_code: 'USD', status: 'open',
          pending_action: null, pending_actor_admin_id: null,
          pending_actor_username: null, pending_reason: null,
          locked_by_admin_id: null, locked_at: null
        };
      }
      if (sql.includes('COUNT(DISTINCT b.id)')) {
        return { batch_count: 1, statement_row_count: 2, unresolved_count: 0 };
      }
      return null;
    }
  });

  const key = 'tenant-a-month-close-ctx-0001';
  const handler = routes.get('POST /api/admin/financial-reconciliation/month-close/transition').at(-1);
  const res = response();
  await handler({
    merchantId: 4, storeId: 9, adminId: 7,
    query: { merchantId: '999', storeId: '888', adminId: '777' },
    params: {},
    body: {
      merchantId: 999, storeId: 888, actorId: 777,
      month: '2026-11', currencyCode: 'USD',
      action: 'request_close',
      reason: 'Close month after all statement rows are reconciled',
      idempotencyKey: key
    },
    get: header => header === 'Idempotency-Key' ? key : undefined
  }, res);

  assert.equal(res.statusCode, 201);
  const actorLookup = reads.find(entry => entry.sql.includes('SELECT username FROM merchant_admins'));
  assert.deepEqual(actorLookup.params, [7, 4]);
  const periodInsert = writes.find(entry => entry.sql.includes('INSERT INTO financial_month_close_periods'));
  assert.deepEqual(periodInsert.params.slice(0, 4), [4, 9, '2026-11', 'USD']);
  const readiness = reads.find(entry => entry.sql.includes('COUNT(DISTINCT b.id)'));
  assert.deepEqual(readiness.params.slice(0, 3), [4, 9, 'USD']);
  const eventInsert = writes.find(entry => entry.sql.includes('INSERT INTO financial_month_close_events'));
  assert.ok(eventInsert);
  assert.deepEqual(eventInsert.params.slice(0, 3), [90, 4, 9]);
  assert.equal(reads.some(entry => entry.params.some(value => [999, 888, 777, '999', '888', '777'].includes(value))), false,
    'attacker-controlled tenant and actor IDs must not enter SQL parameters');
});


test('journal CSV export ignores spoofed tenant IDs and writes an authenticated tenant audit record', async () => {
  const reads = [];
  const queries = [];
  const writes = [];
  const routes = register({
    getAsync: async (sql, params = []) => {
      reads.push({ sql, params });
      if (sql.includes('SELECT username FROM merchant_admins')) return { username: 'tenant-a-finance' };
      return null;
    },
    allAsync: async (sql, params = []) => {
      queries.push({ sql, params });
      return [{
        journalTransactionId: 501, createdAt: '2026-11-12 10:00:00',
        currencyCode: 'USD', sourceType: 'order', sourceId: 7001,
        description: 'Tenant A settlement', createdBy: 'system',
        lineNo: 1, accountCode: 'CASH', direction: 'debit',
        amountMinor: 12500, memo: 'daily settlement'
      }];
    },
    runAsync: async (sql, params = []) => {
      writes.push({ sql, params });
      return { insertId: 81, affectedRows: 1 };
    }
  });

  const handler = routes.get('GET /api/admin/financial-reconciliation/journal-export').at(-1);
  const res = response();
  await handler({
    merchantId: 4, storeId: 9, adminId: 7,
    query: { merchantId: '999', storeId: '888', adminId: '777', from: '2026-11-12', to: '2026-11-12' },
    params: {}, body: {}, ip: '192.0.2.10'
  }, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/csv/);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.match(res.body, /Tenant A settlement/);

  const actorLookup = reads.find(entry => entry.sql.includes('SELECT username FROM merchant_admins'));
  assert.deepEqual(actorLookup.params, [7, 4]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /WHERE j\.merchant_id=\? AND j\.store_id=\?/);
  assert.match(queries[0].sql, /e\.merchant_id=\? AND e\.store_id=\?/);
  assert.deepEqual(queries[0].params.slice(0, 4), [4, 9, 4, 9]);
  assert.equal(queries[0].params.some(value => [999, 888, 777, '999', '888', '777'].includes(value)), false);

  const audit = writes.find(entry => entry.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit, 'export must persist an audit record before returning the CSV');
  assert.deepEqual(audit.params.slice(0, 3), ['merchant_admin', 7, 'tenant-a-finance']);
  assert.equal(audit.params[3], 'export_financial_journal');
  const details = JSON.parse(audit.params[4]);
  assert.deepEqual(
    { merchant_id: details.merchant_id, store_id: details.store_id, row_count: details.row_count, scope: details.scope },
    { merchant_id: 4, store_id: 9, row_count: 1, scope: 'financial_journal' }
  );
  assert.equal(audit.params.some(value => [999, 888, 777, '999', '888', '777'].includes(value)), false);
});
