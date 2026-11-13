'use strict';

const test = require('node:test');
const registerRoutes = require('../routes/financial-reconciliation');
const assert = require('node:assert/strict');
const {
  MAX_EXPORT_ROWS,
  normalizeExportRange,
  csvCell,
  buildJournalCsv,
  createFinancialVoucherExportService
} = require('../server/services/financial-voucher-export');

function createService(rows) {
  const calls = [];
  const service = createFinancialVoucherExportService({
    allAsync: async (sql, params) => {
      calls.push({ sql, params });
      return rows;
    },
    withTransaction: async work => work()
  });
  return { service, calls };
}

test('normalizes inclusive date ranges and rejects invalid or excessive ranges', () => {
  assert.deepEqual(normalizeExportRange('2026-11-01', '2026-11-30'), {
    from: '2026-11-01', to: '2026-11-30',
    startAt: '2026-11-01 00:00:00', endExclusive: '2026-12-01 00:00:00'
  });
  for (const [from, to] of [
    ['2026-02-30', '2026-03-01'],
    ['2026-11-02', '2026-11-01'],
    ['2026-10-01', '2026-11-01'],
    ['2026-1-01', '2026-01-02']
  ]) {
    assert.throws(() => normalizeExportRange(from, to), error => error.code === 'VOUCHER_EXPORT_DATE_RANGE_INVALID');
  }
});

test('CSV escaping quotes values and neutralizes spreadsheet formula prefixes', () => {
  assert.equal(csvCell('=HYPERLINK("https://bad.example")'), '"\'=HYPERLINK(""https://bad.example"")"');
  assert.equal(csvCell('  +SUM(1,2)'), '"\'  +SUM(1,2)"');
  assert.equal(csvCell('safe, "quoted"'), '"safe, ""quoted"""');
  assert.equal(csvCell(1200, true), '"1200"');
});

test('exports only the authenticated merchant/store journal details in stable line order', async () => {
  const rows = [{
    journalTransactionId: 51, createdAt: '2026-11-12 10:00:00.000',
    currencyCode: 'USD', sourceType: 'manual_adjustment', sourceId: 'ref-51',
    description: 'Daily adjustment', createdBy: 'finance-user', lineNo: 1,
    accountCode: 'CASH', direction: 'debit', amountMinor: 1000, memo: 'Cash'
  }];
  const { service, calls } = createService(rows);
  const result = await service.exportJournalDetails({
    merchantId: 4, storeId: 9, from: '2026-11-12', to: '2026-11-12'
  });
  assert.equal(result.rowCount, 1);
  assert.match(result.csv, /Journal transaction ID/);
  assert.match(result.csv, /Daily adjustment/);
  assert.deepEqual(calls[0].params, [
    4, 9, 4, 9, '2026-11-12 00:00:00', '2026-11-13 00:00:00', MAX_EXPORT_ROWS + 1
  ]);
  assert.match(calls[0].sql, /j\.merchant_id=\? AND j\.store_id=\?/);
  assert.match(calls[0].sql, /e\.merchant_id=\? AND e\.store_id=\?/);
  assert.match(calls[0].sql, /ORDER BY j\.created_at ASC, j\.id ASC, e\.line_no ASC/);
});

test('rejects exports exceeding the bounded row count without returning partial data', async () => {
  const { service } = createService(Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, index) => ({ journalTransactionId: index + 1 })));
  await assert.rejects(service.exportJournalDetails({
    merchantId: 4, storeId: 9, from: '2026-11-01', to: '2026-11-01'
  }), error => error.code === 'VOUCHER_EXPORT_TOO_LARGE');
});

test('export rejects invalid tenant identifiers before querying', async () => {
  const { service, calls } = createService([]);
  await assert.rejects(service.exportJournalDetails({
    merchantId: 0, storeId: 9, from: '2026-11-01', to: '2026-11-01'
  }));
  assert.equal(calls.length, 0);
});

test('CSV export is deterministic for empty journal periods', async () => {
  const { service } = createService([]);
  const result = await service.exportJournalDetails({
    merchantId: 4, storeId: 9, from: '2026-11-01', to: '2026-11-01'
  });
  assert.equal(result.rowCount, 0);
  assert.match(result.csv, /^\uFEFF"Journal transaction ID"/);
  assert.ok(result.csv.endsWith('\r\n'));
});

test('journal export route enforces tenant context and returns a private CSV attachment', async () => {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async (sql, params) => { calls.push({ type: 'run', sql, params }); return { affectedRows: 1 }; },
    getAsync: async (sql, params) => {
      if (sql.includes('FROM merchant_admins')) return { username: 'finance-auditor' };
      return null;
    },
    allAsync: async () => [{
      journalTransactionId: 7, createdAt: '2026-11-12 10:00:00.000',
      currencyCode: 'KHR', sourceType: 'manual_adjustment', sourceId: 'x-7',
      description: 'Adjustment', createdBy: 'finance', lineNo: 1,
      accountCode: 'CASH', direction: 'debit', amountMinor: 500, memo: ''
    }],
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  const handler = routes.get('GET /api/admin/financial-reconciliation/journal-export').at(-1);
  const response = () => ({
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; }
  });
  const denied = response();
  await handler({ merchantId: 4, storeId: null, adminId: 8, query: {} }, denied);
  assert.equal(denied.statusCode, 403);

  const ok = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 8, query: { from: '2026-11-12', to: '2026-11-12' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Cache-Control'], 'no-store, private');
  assert.match(ok.headers['Content-Type'], /text\/csv/);
  assert.match(ok.headers['Content-Disposition'], /financial-journal-2026-11-12-to-2026-11-12\.csv/);
  assert.match(ok.body, /Adjustment/);
  const audit = calls.find(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit, 'successful CSV download must have a durable audit record');
  assert.deepEqual(audit.params.slice(0, 4), ['merchant_admin', 8, 'finance-auditor', 'export_financial_journal']);
  const auditDetails = JSON.parse(audit.params[4]);
  assert.deepEqual(auditDetails, {
    merchant_id: 4, store_id: 9, from: '2026-11-12', to: '2026-11-12',
    row_count: 1, format: 'csv', scope: 'financial_journal'
  });
});


test('journal CSV export rejects unsafe persisted BIGINT amounts before returning a file', async () => {
  for (const amountMinor of ['9007199254740992', 9007199254740992]) {
    const { service, calls } = createService([{
      journalTransactionId: 51, createdAt: '2026-11-12 10:00:00.000',
      currencyCode: 'USD', sourceType: 'manual_adjustment', sourceId: 'ref-51',
      description: 'Daily adjustment', createdBy: 'finance-user', lineNo: 1,
      accountCode: 'CASH', direction: 'debit', amountMinor, memo: 'Cash'
    }]);
    await assert.rejects(service.exportJournalDetails({
      merchantId: 4, storeId: 9, from: '2026-11-12', to: '2026-11-12'
    }), error => error.code === 'JOURNAL_AMOUNT_PRECISION_UNSAFE');
    assert.equal(calls.length, 1);
  }
});

test('batch list route fails closed when a persisted BIGINT total is unsafe', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async () => ({ affectedRows: 1 }),
    getAsync: async () => null,
    allAsync: async () => [{
      id: 1, provider_code: 'GENERIC', external_batch_id: 'batch-1',
      currency_code: 'USD', row_count: 1,
      total_debit_minor: '9007199254740992', total_credit_minor: '100',
      status: 'imported', imported_at: '2026-11-12 00:00:00',
      matched_count: 0, pending_count: 1, unmatched_count: 0,
      ambiguous_count: 0, exception_count: 0
    }],
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  const handler = routes.get('GET /api/admin/financial-reconciliation/batches').at(-1);
  const res = {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(body) { this.body = body; return this; }
  };
  await handler({ merchantId: 4, storeId: 9, adminId: 7, query: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '获取对账批次列表失败' });
});
