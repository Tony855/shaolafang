'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/financial-reconciliation');
const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');

function serviceWith(allAsync) {
  return createFinancialReconciliationReviewService({
    runAsync: async () => ({ affectedRows: 1 }),
    getAsync: async () => null,
    allAsync,
    withTransaction: async work => work()
  });
}

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(body) { this.body = body; return this; }
  };
}

function routeSetup(allAsync) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async () => ({ affectedRows: 1 }),
    getAsync: async () => null,
    allAsync,
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  return routes;
}

test('review history uses merchant/store scope, optional filters, and a descending cursor', async () => {
  const seen = [];
  const rows = [30, 20, 10].map(id => ({
    id, batch_id: 8, item_id: 90, journal_transaction_id: null,
    exception_category: null, actor_admin_id: 7, actor_username: 'finance',
    action: 'reject', reason: 'Manual investigation required',
    idempotency_key: 'review-event-key-' + id,
    before_json: '{"matchStatus":"pending"}',
    after_json: '{"matchStatus":"unmatched"}',
    previous_hash: '', event_hash: 'a'.repeat(64), created_at: '2026-11-11 10:00:00'
  }));
  const service = serviceWith(async (sql, params) => {
    seen.push({ sql, params });
    const cursor = Number(params[2]);
    return rows.filter(row => Number(row.id) < cursor).slice(0, params.at(-1));
  });
  const first = await service.listReviewHistory({
    merchantId: 4, storeId: 9, batchId: 8, itemId: 90, limit: 2
  });
  assert.deepEqual(first.items.map(item => item.eventId), [30, 20]);
  assert.equal(first.nextCursor, 20);
  assert.deepEqual(seen[0].params, [4, 9, Number.MAX_SAFE_INTEGER, 8, 90, 3]);
  assert.match(seen[0].sql, /merchant_id=\? AND store_id=\?/);
  assert.match(seen[0].sql, /batch_id=\? AND item_id=\?/);
  assert.deepEqual(first.items[0].before, { matchStatus: 'pending' });
  const second = await service.listReviewHistory({
    merchantId: 4, storeId: 9, limit: 2, afterId: first.nextCursor
  });
  assert.deepEqual(seen[1].params, [4, 9, 20, 3]);
  assert.equal(second.nextCursor, null);
});

test('review history rejects unsafe cursor, limit, and tenant IDs', async () => {
  const service = serviceWith(async () => []);
  await assert.rejects(service.listReviewHistory({ merchantId: 0, storeId: 9 }));
  await assert.rejects(service.listReviewHistory({ merchantId: 4, storeId: 9, limit: 201 }));
  await assert.rejects(service.listReviewHistory({ merchantId: 4, storeId: 9, afterId: -1 }));
  await assert.rejects(service.listReviewHistory({ merchantId: 4, storeId: 9, itemId: '1 OR 1=1' }));
});

test('monthly close preview aggregates by currency and flags unresolved rows', async () => {
  const calls = [];
  const service = serviceWith(async (sql, params) => {
    calls.push({ sql, params });
    return [
      { currency_code: 'KHR', batch_count: 2, statement_row_count: 12,
        total_debit_minor: 5000, total_credit_minor: 5000, closed_batch_count: 1,
        open_batch_count: 1, matched_count: 10, pending_count: 1, unmatched_count: 0,
        ambiguous_count: 0, exception_count: 1, unresolved_count: 2 },
      { currency_code: 'USD', batch_count: 1, statement_row_count: 4,
        total_debit_minor: 1200, total_credit_minor: 1200, closed_batch_count: 0,
        open_batch_count: 1, matched_count: 4, pending_count: 0, unmatched_count: 0,
        ambiguous_count: 0, exception_count: 0, unresolved_count: 0 }
    ];
  });
  const rows = await service.getMonthlyClosePreview({ merchantId: 4, storeId: 9, month: '2026-11' });
  assert.deepEqual(calls[0].params, [4, 9, '2026-11-01 00:00:00', '2026-12-01 00:00:00']);
  assert.match(calls[0].sql, /b\.merchant_id=\? AND b\.store_id=\?/);
  assert.equal(rows[0].unresolvedCount, 2);
  assert.equal(rows[0].closeReady, false);
  assert.equal(rows[1].closeReady, true);
  assert.equal(rows[1].reviewComplete, true);
});

test('monthly close preview validates month and tenant scope', async () => {
  const service = serviceWith(async () => []);
  await assert.rejects(service.getMonthlyClosePreview({ merchantId: 4, storeId: 9, month: '2026-13' }),
    error => error.code === 'REVIEW_MONTH_INVALID');
  await assert.rejects(service.getMonthlyClosePreview({ merchantId: 4, storeId: 9, month: '2026-2' }),
    error => error.code === 'REVIEW_MONTH_INVALID');
});

test('history and monthly preview routes require tenant context and disable caching', async () => {
  const routes = routeSetup(async () => []);
  const history = routes.get('GET /api/admin/financial-reconciliation/review-history').at(-1);
  const monthly = routes.get('GET /api/admin/financial-reconciliation/monthly-close-preview').at(-1);

  const denied = response();
  await history({ merchantId: 4, storeId: null, adminId: 7, query: {} }, denied);
  assert.equal(denied.statusCode, 403);

  const historyResponse = response();
  await history({ merchantId: 4, storeId: 9, adminId: 7, query: { limit: '10', afterId: '0' } }, historyResponse);
  assert.equal(historyResponse.statusCode, 200);
  assert.equal(historyResponse.headers['Cache-Control'], 'no-store, private');

  const monthResponse = response();
  await monthly({ merchantId: 4, storeId: 9, adminId: 7, query: { month: '2026-11' } }, monthResponse);
  assert.equal(monthResponse.statusCode, 200);
  assert.equal(monthResponse.body.month, '2026-11');
  assert.equal(monthResponse.headers['Cache-Control'], 'no-store, private');

  const invalidMonth = response();
  await monthly({ merchantId: 4, storeId: 9, adminId: 7, query: { month: '2026-13' } }, invalidMonth);
  assert.equal(invalidMonth.statusCode, 400);
});


test('exception queue is tenant-scoped, category/date filtered, and cursor paginated', async () => {
  const seen = [];
  const rows = [30, 20, 10].map(id => ({
    id, batch_id: 8, row_no: id, external_reference: 'bank-' + id,
    transaction_reference: 'txn-' + id, direction: 'credit', amount_minor: 1250,
    currency_code: 'USD', occurred_at: '2026-11-11 10:00:00', description: 'Statement row',
    exception_category: 'fee', exception_note: 'Review bank fee', match_reason: 'manual_classify_exception',
    provider_code: 'GENERIC', external_batch_id: 'batch-2026-11', imported_at: '2026-11-11 11:00:00'
  }));
  const service = serviceWith(async (sql, params) => {
    seen.push({ sql, params });
    const cursor = Number(params[2]);
    return rows.filter(row => Number(row.id) < cursor).slice(0, params.at(-1));
  });
  const first = await service.listExceptions({
    merchantId: 4, storeId: 9, category: 'FEE',
    from: '2026-11-01', to: '2026-11-30', limit: 2
  });
  assert.deepEqual(first.items.map(item => item.itemId), [30, 20]);
  assert.equal(first.nextCursor, 20);
  assert.deepEqual(seen[0].params, [4, 9, Number.MAX_SAFE_INTEGER, 'fee',
    '2026-11-01 00:00:00', '2026-12-01 00:00:00', 3]);
  assert.match(seen[0].sql, /i\.merchant_id=\? AND i\.store_id=\?/);
  assert.match(seen[0].sql, /i\.match_status='exception'/);
  assert.match(seen[0].sql, /b\.merchant_id=i\.merchant_id AND b\.store_id=i\.store_id/);
  assert.equal(first.items[0].amountMinor, 1250);
  const second = await service.listExceptions({
    merchantId: 4, storeId: 9, category: 'fee', limit: 2, afterId: first.nextCursor
  });
  assert.deepEqual(second.items.map(item => item.itemId), [10]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(seen[1].params, [4, 9, 20, 'fee', 3]);
});

test('exception queue rejects invalid categories, ranges, cursors, and excessive pages', async () => {
  const service = serviceWith(async () => []);
  await assert.rejects(service.listExceptions({ merchantId: 4, storeId: 9, category: 'unknown' }),
    error => error.code === 'REVIEW_EXCEPTION_FILTER_INVALID');
  await assert.rejects(service.listExceptions({ merchantId: 4, storeId: 9, from: '2026-11-01' }),
    error => error.code === 'REVIEW_EXCEPTION_DATE_RANGE_INVALID');
  await assert.rejects(service.listExceptions({ merchantId: 4, storeId: 9, from: '2026-02-31', to: '2026-03-01' }),
    error => error.code === 'REVIEW_EXCEPTION_DATE_RANGE_INVALID');
  await assert.rejects(service.listExceptions({ merchantId: 4, storeId: 9, limit: 101 }),
    error => error.code === 'REVIEW_EXCEPTION_PAGINATION_INVALID');
  await assert.rejects(service.listExceptions({ merchantId: 4, storeId: 9, afterId: -1 }),
    error => error.code === 'REVIEW_EXCEPTION_PAGINATION_INVALID');
});

test('exception queue route enforces tenant context and private no-store response', async () => {
  const routes = routeSetup(async () => []);
  const handler = routes.get('GET /api/admin/financial-reconciliation/exceptions').at(-1);
  const denied = response();
  await handler({ merchantId: 4, storeId: null, adminId: 7, query: {} }, denied);
  assert.equal(denied.statusCode, 403);
  const ok = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 7, query: { category: 'fee', limit: '25' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Cache-Control'], 'no-store, private');
  assert.deepEqual(ok.body.items, []);
  const invalid = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 7, query: { category: 'made-up' } }, invalid);
  assert.equal(invalid.statusCode, 400);
});
