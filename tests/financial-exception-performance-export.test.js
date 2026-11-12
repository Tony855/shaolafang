'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExceptionPerformanceCsv, csvCell } = require('../server/services/financial-exception-performance-export');

test('exception performance CSV groups currencies, assignees and categories and neutralizes formulas', () => {
  const csv = buildExceptionPerformanceCsv({
    byCurrency: [{ currencyCode: 'USD', activeCount: 2 }],
    byAssignee: [{ currencyCode: 'USD', username: '=HYPERLINK("x")', activeCount: 1 }],
    byCategory: [{ currencyCode: 'KHR', category: 'fee', activeCount: 3 }]
  });
  assert.match(csv, /"currency","USD"/);
  assert.match(csv, /"assignee","USD","'=HYPERLINK/);
  assert.match(csv, /"category","KHR","fee"/);
  assert.ok(csv.startsWith('\uFEFF"group"'));
  assert.equal(csvCell('+SUM(1,2)'), "\"'+SUM(1,2)\"");
});

test('empty exception performance CSV has stable header and newline', () => {
  const csv = buildExceptionPerformanceCsv({});
  assert.ok(csv.startsWith('\uFEFF"group"'));
  assert.ok(csv.endsWith('\r\n'));
});


const registerRoutes = require('../routes/financial-reconciliation');

test('performance CSV route requires tenant context and audits before sending', async () => {
  const routes = new Map(), writes = [];
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async (sql, params) => { writes.push({ sql, params }); return { affectedRows: 1 }; },
    getAsync: async sql => sql.includes('FROM merchant_admins') ? { username: 'finance-auditor' } : null,
    allAsync: async () => [],
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  const handler = routes.get('GET /api/admin/financial-reconciliation/exceptions/performance-export').at(-1);
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
  const invalid = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 8, query: { slaHours: 721 } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const ok = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 8, ip: '127.0.0.1', query: { slaHours: 24 } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Cache-Control'], 'no-store, private');
  assert.match(ok.headers['Content-Type'], /text\/csv/);
  assert.ok(ok.body.startsWith('\\uFEFF'));
  const audit = writes.find(row => row.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(audit.params[3], 'export_financial_exception_performance');
  assert.deepEqual(JSON.parse(audit.params[4]), {
    merchant_id: 4, store_id: 9, sla_hours: 24, row_count: 0,
    format: 'csv', scope: 'financial_exception_performance'
  });
});
