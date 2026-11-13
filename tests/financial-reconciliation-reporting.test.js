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
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  };
}

function routeSetup(allAsync, getAsync = async () => null, runAsync = async () => ({ affectedRows: 1 })) {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync,
    getAsync,
    allAsync,
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  return routes;
}


test('period summary supports daily, weekly, and monthly aggregation without currency conversion', async () => {
  const calls = [];
  const service = serviceWith(async (sql, params) => {
    calls.push({ sql, params });
    return [{ period_start: '2026-11-12', period_end: '2026-11-12', currency_code: 'KHR',
      batch_count: 2, statement_row_count: 7, total_debit_minor: 9000, total_credit_minor: 9000,
      matched_count: 5, pending_count: 1, unmatched_count: 0, ambiguous_count: 0, exception_count: 1 }];
  });
  for (const period of ['day', 'week', 'month']) {
    const result = await service.getPeriodSummary({ merchantId: 4, storeId: 9, from: '2026-11-01', to: '2026-11-30', period });
    assert.equal(result.period, period);
    assert.equal(result.rows[0].currencyCode, 'KHR');
    assert.equal(result.rows[0].totalDebitMinor, 9000);
    assert.deepEqual(calls.at(-1).params, [4, 9, '2026-11-01 00:00:00', '2026-12-01 00:00:00']);
    if (period === 'day') assert.match(calls.at(-1).sql, /DATE\(b\.imported_at\)/);
    if (period === 'week') assert.match(calls.at(-1).sql, /WEEKDAY\(b\.imported_at\)/);
    if (period === 'month') assert.match(calls.at(-1).sql, /DATE_FORMAT\(b\.imported_at/);
  }
  await assert.rejects(service.getPeriodSummary({ merchantId: 4, storeId: 9, from: '2026-11-01', to: '2026-11-30', period: 'quarter' }),
    error => error.code === 'REVIEW_PERIOD_INVALID');
});

test('period report CSV is audited before response and fails closed when audit write fails', async () => {
  const auditWrites = [];
  const rows = [{ period_start: '2026-11-01', period_end: '2026-11-30', currency_code: 'USD',
    batch_count: 1, statement_row_count: 2, total_debit_minor: 1200, total_credit_minor: 1200,
    matched_count: 2, pending_count: 0, unmatched_count: 0, ambiguous_count: 0, exception_count: 0 }];
  const routes = routeSetup(async () => rows,
    async () => ({ username: 'finance-admin' }),
    async (sql, params) => { auditWrites.push({ sql, params }); return { affectedRows: 1 }; });
  const handler = routes.get('GET /api/admin/financial-reconciliation/period-report-export').at(-1);
  const ok = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 7, ip: '127.0.0.1',
    query: { period: 'month', from: '2026-11-01', to: '2026-11-30' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Cache-Control'], 'no-store, private');
  assert.match(ok.headers['Content-Type'], /text\/csv/);
  assert.ok(String(ok.body).startsWith('\uFEFF'));
  assert.match(ok.body, /USD/);
  assert.equal(auditWrites.length, 1);
  assert.equal(auditWrites[0].params[3], 'export_financial_reconciliation_period_report');
  assert.match(auditWrites[0].params[4], /"merchant_id":4,"store_id":9/);

  const failedRoutes = routeSetup(async () => rows,
    async () => ({ username: 'finance-admin' }),
    async () => { throw new Error('audit storage unavailable'); });
  const failed = response();
  await failedRoutes.get('GET /api/admin/financial-reconciliation/period-report-export').at(-1)(
    { merchantId: 4, storeId: 9, adminId: 7, query: { period: 'day', from: '2026-11-12', to: '2026-11-12' } }, failed);
  assert.equal(failed.statusCode, 500);
  assert.match(failed.body.error, /导出失败/);
});

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


test('period summaries keep each currency separate and never combine minor-unit totals', async () => {
  const seen = [];
  const rows = [
    { period_start: '2026-11-12', period_end: '2026-11-12', currency_code: 'KHR',
      batch_count: 2, statement_row_count: 7, total_debit_minor: 9000, total_credit_minor: 9000,
      matched_count: 5, pending_count: 1, unmatched_count: 0, ambiguous_count: 0, exception_count: 1 },
    { period_start: '2026-11-12', period_end: '2026-11-12', currency_code: 'USD',
      batch_count: 1, statement_row_count: 2, total_debit_minor: 1200, total_credit_minor: 1200,
      matched_count: 2, pending_count: 0, unmatched_count: 0, ambiguous_count: 0, exception_count: 0 }
  ];
  const service = serviceWith(async (sql, params) => { seen.push({ sql, params }); return rows; });
  const result = await service.getPeriodSummary({
    merchantId: 4, storeId: 9, from: '2026-11-12', to: '2026-11-12', period: 'day'
  });
  assert.deepEqual(result.rows.map(row => row.currencyCode), ['KHR', 'USD']);
  assert.deepEqual(result.rows.map(row => row.totalDebitMinor), [9000, 1200]);
  assert.match(seen[0].sql, /GROUP BY period_start,period_end,b\.currency_code/);
  assert.doesNotMatch(seen[0].sql, /exchange_rate|currency_conversion|CONVERT\s*\(/i);
  assert.deepEqual(seen[0].params.slice(0, 2), [4, 9]);
});

test('period summary accepts at most 366 inclusive dates and rejects invalid calendar dates', async () => {
  const service = serviceWith(async () => []);
  const maximum = await service.getPeriodSummary({
    merchantId: 4, storeId: 9, from: '2025-11-01', to: '2026-11-01', period: 'day'
  });
  assert.deepEqual(maximum.rows, []);
  await assert.rejects(service.getPeriodSummary({
    merchantId: 4, storeId: 9, from: '2025-10-31', to: '2026-11-01', period: 'day'
  }), error => error.code === 'REVIEW_DATE_RANGE_INVALID');
  await assert.rejects(service.getPeriodSummary({
    merchantId: 4, storeId: 9, from: '2026-02-31', to: '2026-03-01', period: 'day'
  }), error => error.code === 'REVIEW_DATE_RANGE_INVALID');
  await assert.rejects(service.getPeriodSummary({
    merchantId: 0, storeId: 9, from: '2026-11-01', to: '2026-11-01', period: 'day'
  }));
});



test('exception queue cursor pagination walks 2,500 rows without duplicates or gaps', async () => {
  const allRows = Array.from({ length: 2500 }, (_, index) => {
    const id = 2500 - index;
    return {
      id, batch_id: 77, row_no: id, external_reference: 'ref-' + id,
      transaction_reference: 'txn-' + id, direction: 'credit', amount_minor: 1000 + id,
      currency_code: 'USD', occurred_at: '2026-11-11 10:00:00', description: 'Synthetic high-volume row',
      exception_category: 'fee', exception_note: null, match_reason: null,
      provider_code: 'GENERIC', external_batch_id: 'batch-high-volume',
      imported_at: '2026-11-11 11:00:00', case_id: null, case_status: null,
      assigned_admin_id: null, assigned_admin_username: null, resolution_note: null,
      case_updated_at: null
    };
  });
  const calls = [];
  const service = serviceWith(async (sql, params) => {
    calls.push({ sql, params });
    const cursor = Number(params[2]);
    return allRows.filter(row => row.id < cursor).slice(0, params.at(-1));
  });

  const received = [];
  let afterId = 0;
  let pages = 0;
  do {
    const page = await service.listExceptions({ merchantId: 4, storeId: 9, limit: 100, afterId });
    received.push(...page.items.map(row => row.itemId));
    afterId = page.nextCursor || 0;
    pages += 1;
    if (!page.nextCursor) break;
  } while (pages <= 30);

  assert.equal(pages, 25);
  assert.equal(received.length, 2500);
  assert.equal(new Set(received).size, 2500);
  assert.deepEqual(received, allRows.map(row => row.id));
  assert.ok(calls.every(call => /i\.merchant_id=\? AND i\.store_id=\?/.test(call.sql)));
  assert.ok(calls.every(call => /ORDER BY i\.id DESC LIMIT \?/.test(call.sql)));
  assert.ok(calls.every(call => call.params[0] === 4 && call.params[1] === 9 && call.params.at(-1) === 101));
});


test('period report CSV export binds authenticated tenant despite spoofed query IDs', async () => {
  const reads = [], queries = [], writes = [];
  const rows = [{ period_start:'2026-11-12',period_end:'2026-11-12',currency_code:'USD',batch_count:1,statement_row_count:2,total_debit_minor:1200,total_credit_minor:1200,matched_count:2,pending_count:0,unmatched_count:0,ambiguous_count:0,exception_count:0 }];
  const routes = routeSetup(
    async (sql,params=[])=>{queries.push({sql,params});return rows;},
    async (sql,params=[])=>{reads.push({sql,params});return sql.includes('SELECT username FROM merchant_admins')?{username:'tenant-a-finance'}:null;},
    async (sql,params=[])=>{writes.push({sql,params});return {affectedRows:1};}
  );
  const res=response();
  await routes.get('GET /api/admin/financial-reconciliation/period-report-export').at(-1)({
    merchantId:4,storeId:9,adminId:7,ip:'192.0.2.11',
    query:{merchantId:'999',storeId:'888',adminId:'777',period:'day',from:'2026-11-12',to:'2026-11-12'}
  },res);
  assert.equal(res.statusCode,200);
  assert.equal(res.headers['Cache-Control'],'no-store, private');
  assert.match(res.body,/USD/);
  assert.equal(queries.length,1);
  assert.match(queries[0].sql,/b\.merchant_id=\? AND b\.store_id=\?/);
  assert.deepEqual(queries[0].params,[4,9,'2026-11-12 00:00:00','2026-11-13 00:00:00']);
  assert.equal(queries[0].params.some(v=>[999,888,777,'999','888','777'].includes(v)),false);
  const actor=reads.find(x=>x.sql.includes('SELECT username FROM merchant_admins'));
  assert.deepEqual(actor.params,[7,4]);
  const audit=writes.find(x=>x.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.deepEqual(audit.params.slice(0,4),['merchant_admin',7,'tenant-a-finance','export_financial_reconciliation_period_report']);
  const details=JSON.parse(audit.params[4]);
  assert.deepEqual({merchant_id:details.merchant_id,store_id:details.store_id,row_count:details.row_count,scope:details.scope},{merchant_id:4,store_id:9,row_count:1,scope:'financial_reconciliation_period_report'});
  assert.equal(audit.params.some(v=>[999,888,777,'999','888','777'].includes(v)),false);
});


test('period report rejects aggregate minor-unit totals above JavaScript safe integer precision', async () => {
  const service = serviceWith(async () => [{
    period_start: '2026-11-01', period_end: '2026-11-30', currency_code: 'USD',
    batch_count: 2, statement_row_count: 4,
    total_debit_minor: '9007199254740992', total_credit_minor: '9007199254740992',
    matched_count: 4, pending_count: 0, unmatched_count: 0, ambiguous_count: 0, exception_count: 0
  }]);
  await assert.rejects(
    service.getPeriodSummary({ merchantId: 4, storeId: 9, from: '2026-11-01', to: '2026-11-30', period: 'month' }),
    error => error.code === 'REVIEW_TOTAL_PRECISION_UNSAFE'
  );
});

test('monthly close preview rejects aggregate minor-unit totals above JavaScript safe integer precision', async () => {
  const service = serviceWith(async () => [{
    currency_code: 'USD', batch_count: 2, statement_row_count: 4,
    total_debit_minor: '9007199254740992', total_credit_minor: '9007199254740992',
    closed_batch_count: 1, open_batch_count: 1, matched_count: 4,
    pending_count: 0, unmatched_count: 0, ambiguous_count: 0, exception_count: 0, unresolved_count: 0
  }]);
  await assert.rejects(
    service.getMonthlyClosePreview({ merchantId: 4, storeId: 9, month: '2026-11' }),
    error => error.code === 'REVIEW_TOTAL_PRECISION_UNSAFE'
  );
});

test('report and month-close minor-unit totals preserve exact safe integer boundaries', async () => {
  const exact = '9007199254740991';
  const service = serviceWith(async () => [{
    period_start: '2026-11-01', period_end: '2026-11-30', currency_code: 'USD',
    batch_count: 1, statement_row_count: 1,
    total_debit_minor: exact, total_credit_minor: exact,
    matched_count: 1, pending_count: 0, unmatched_count: 0, ambiguous_count: 0, exception_count: 0,
    closed_batch_count: 1, open_batch_count: 0, unresolved_count: 0
  }]);
  const report = await service.getPeriodSummary({
    merchantId: 4, storeId: 9, from: '2026-11-01', to: '2026-11-30', period: 'month'
  });
  const close = await service.getMonthlyClosePreview({ merchantId: 4, storeId: 9, month: '2026-11' });
  assert.equal(report.rows[0].totalDebitMinor, Number.MAX_SAFE_INTEGER);
  assert.equal(close[0].totalDebitMinor, Number.MAX_SAFE_INTEGER);
});


test('exception queue and SLA alert list reject unsafe persisted row amounts', async () => {
  const unsafe = '9007199254740992';
  const exceptionService = serviceWith(async () => [{
    id: 1, batch_id: 2, row_no: 1, external_reference: 'bank-ref', direction: 'credit',
    amount_minor: unsafe, currency_code: 'USD', match_status: 'exception',
    exception_category: 'fee', provider_code: 'GENERIC', external_batch_id: 'batch-1',
    imported_at: '2026-11-12 00:00:00', case_id: null, case_status: null,
    assigned_admin_id: null, assigned_admin_username: null, resolution_note: null, case_updated_at: null
  }]);
  await assert.rejects(
    exceptionService.listExceptions({ merchantId: 4, storeId: 9 }),
    error => error.code === 'REVIEW_TOTAL_PRECISION_UNSAFE'
  );

  const alertService = serviceWith(async () => [{
    id: 10, batch_id: 2, item_id: 1, alert_type: 'sla_overdue', sla_hours: 24,
    status: 'pending', generated_at: '2026-11-12 00:00:00', acknowledged_by_admin_id: null,
    acknowledged_by_username: null, acknowledged_at: null, acknowledgement_reason: null,
    exception_category: 'fee', currency_code: 'USD', amount_minor: unsafe,
    external_reference: 'bank-ref', assigned_admin_username: null, age_seconds: 90000
  }]);
  await assert.rejects(
    alertService.listSlaAlerts({ merchantId: 4, storeId: 9 }),
    error => error.code === 'REVIEW_TOTAL_PRECISION_UNSAFE'
  );
});

test('overdue exception operations reject unsafe persisted statement amounts', async () => {
  const service = serviceWith(async sql => sql.includes('SELECT i.id AS item_id') ? [{
    item_id: 1, batch_id: 2, exception_category: 'fee', currency_code: 'USD',
    amount_minor: '9007199254740992', external_reference: 'bank-ref',
    assigned_admin_id: null, assigned_admin_username: null,
    imported_at: '2026-11-12 00:00:00', age_seconds: 90000
  }] : []);
  await assert.rejects(
    service.getExceptionOperationsSummary({ merchantId: 4, storeId: 9 }),
    error => error.code === 'REVIEW_TOTAL_PRECISION_UNSAFE'
  );
});
