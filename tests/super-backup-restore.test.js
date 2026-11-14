'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');
const { BACKUP_TABLES, FINANCIAL_BACKUP_TABLES } = require('../server/services/backup-schema');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

const tableNames = [...BACKUP_TABLES];

function backup({ superAdmins = [{ id: 1, username: 'root', password_hash: 'hash' }] } = {}) {
  const tables = Object.fromEntries(tableNames.map(name => [name, []]));
  tables.super_admins = superAdmins;
  return { exportedAt: new Date().toISOString(), tables };
}

function setup({ failAudit = false } = {}) {
  let handler;
  const handlers = new Map();
  const allCalls = [];
  let inTransaction = false;
  let rolledBack = false;
  const calls = [];
  const app = {
    post(path, ...callbacks) {
      if (path === '/api/super/backup/import') handler = callbacks[callbacks.length - 1];
    },
    get(path, ...callbacks) { handlers.set(path, callbacks[callbacks.length - 1]); },
    put() {}, delete() {}
  };
  attachSuperRoutes(app, {
    getAsync: async sql => sql.includes('FROM stores') ? { id: 9, name: 'Test Store', merchant_name: 'Test Merchant' } : null,
    allAsync: async (sql, params) => {
      allCalls.push({ sql, params, inTransaction });
      if (sql.startsWith('SHOW COLUMNS')) assert.equal(inTransaction, true);
      if (sql.startsWith('SHOW COLUMNS')) {
        const table = sql.match(/SHOW COLUMNS FROM `([^\`]+)`/)[1];
        const fields = ['id', 'username', 'password_hash'];
        if (table === 'financial_reconciliation_review_events') fields.push('before_json', 'after_json');
        if (table === 'provider_webhook_events') fields.push('normalized_event_json');
        return fields.map(Field => ({ Field }));
      }
      return [];
    },
    runAsync: async (sql, params) => {
      calls.push({ sql, params, inTransaction });
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      inTransaction = true;
      try { return await work(); }
      catch (error) { rolledBack = true; throw error; }
      finally { inTransaction = false; }
    },
    requireSuperAdmin: middleware,
    logAudit: async (...args) => {
      calls.push({ audit: args, inTransaction });
      if (failAudit) throw new Error('audit write failed');
    },
    logAuditStrict: async (...args) => {
      calls.push({ audit: args, inTransaction, strict: true });
      if (failAudit) throw new Error('strict audit write failed');
    },
    getClientIp: () => '127.0.0.1',
    collectBackupData: async () => backup(),
    autoBackupDatabase: async () => ({})
  });
  return { handler, handlers, calls, allCalls, get inTransaction() { return inTransaction; }, get rolledBack() { return rolledBack; } };
}

test('backup export is audited and sends no-store security headers', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handlers.get('/api/super/backup/export')({
    superAdmin: { id: 7, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.tables);
  assert.equal(res.headers['Cache-Control'], 'no-store, no-cache, must-revalidate, private');
  assert.equal(res.headers.Pragma, 'no-cache');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  const audit = ctx.calls.find(call => call.audit?.[3] === 'export_backup');
  assert.ok(audit);
  assert.equal(audit.inTransaction, false);
  assert.equal(audit.strict, true);
});


test('online session details never select or expose the bearer token', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handlers.get('/api/super/online-sessions/:storeId')({ params: { storeId: '9' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.sessions, []);
  const query = ctx.allCalls.find(call => call.sql.includes('FROM scan_sessions ss'));
  assert.ok(query);
  assert.doesNotMatch(query.sql, /ss\.token/);
});

test('backup restore rejects an empty super-admin table before deleting live data', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ body: backup({ superAdmins: [] }), superAdmin: { id: 7, username: 'root' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /没有超级管理员账号/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.rolledBack, false);
});

test('backup restore writes its audit event and invalidates sessions in the same transaction', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ body: backup(), superAdmin: { id: 7, username: 'root' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const audit = ctx.calls.find(call => call.audit);
  assert.ok(audit);
  assert.equal(audit.inTransaction, true);
  assert.equal(audit.strict, true);
  assert.ok(ctx.calls.filter(call => call.sql?.startsWith('DELETE FROM')).every(call => call.inTransaction));
  assert.ok(ctx.calls.some(call => call.sql?.includes('UPDATE orders SET pay_qr_generation_id=SHA2')));
  const staleCustomerNotices = ctx.calls.find(call => call.sql?.includes("recipient_scope='customer' AND state IN ('pending','processing')"));
  assert.ok(staleCustomerNotices);
  assert.equal(staleCustomerNotices.inTransaction, true);
  assert.ok(ctx.calls.some(call => call.sql === 'DELETE FROM telegram_customer_bindings'));
  assert.ok(ctx.calls.some(call => call.sql === 'DELETE FROM telegram_customer_binding_challenges'));
  assert.equal(ctx.rolledBack, false);
});

test('backup restore rolls back when its audit event cannot be written', async () => {
  const ctx = setup({ failAudit: true });
  const res = response();
  await ctx.handler({ body: backup(), superAdmin: { id: 7, username: 'root' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
  assert.equal(ctx.inTransaction, false);
});

test('backup restore accepts legacy backups without the refund request ledger', async () => {
  const ctx = setup();
  const legacy = backup();
  delete legacy.tables.refund_requests;
  delete legacy.tables.financial_journal_transactions;
  delete legacy.tables.financial_journal_entries;
  delete legacy.tables.provider_webhook_events;
  for (const table of ['telegram_notification_outbox', 'telegram_customer_binding_challenges', 'telegram_customer_bindings', 'telegram_webhook_updates', 'telegram_store_admin_recipients']) delete legacy.tables[table];
  for (const table of FINANCIAL_BACKUP_TABLES) delete legacy.tables[table];
  const res = response();
  await ctx.handler({ body: legacy, superAdmin: { id: 7, username: 'root' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(ctx.calls.some(call => call.sql === 'DELETE FROM `refund_requests`'));
  assert.ok(ctx.calls.some(call => call.sql === 'DELETE FROM `financial_journal_transactions`'));
  assert.ok(ctx.calls.some(call => call.sql === 'DELETE FROM `financial_journal_entries`'));
  assert.ok(ctx.calls.some(call => call.sql === 'DELETE FROM `provider_webhook_events`'));
  for (const table of FINANCIAL_BACKUP_TABLES) {
    assert.ok(ctx.calls.some(call => call.sql === 'DELETE FROM `' + table + '`'));
  }
});

test('backup restore deletes finance dependents before parents and inserts parents before dependents', async () => {
  const ctx = setup();
  const payload = backup();
  FINANCIAL_BACKUP_TABLES.forEach((table, index) => { payload.tables[table] = [{ id: index + 1 }]; });
  payload.tables.financial_reconciliation_review_events = [{
    id: 5, before_json: { status: 'pending' }, after_json: { status: 'matched' }
  }];
  payload.tables.provider_webhook_events = [{
    id: 12, normalized_event_json: { orderReference: 'order-1', paymentStatus: 'paid' }
  }];
  const res = response();
  await ctx.handler({ body: payload, superAdmin: { id: 7, username: 'root' } }, res);

  assert.equal(res.statusCode, 200);
  const quote = String.fromCharCode(96);
  const deleteOrder = ctx.calls.filter(call => call.sql?.startsWith('DELETE FROM '))
    .map(call => call.sql.split(quote)[1])
    .filter(table => FINANCIAL_BACKUP_TABLES.includes(table));
  const insertOrder = ctx.calls.filter(call => call.sql?.startsWith('INSERT INTO '))
    .map(call => call.sql.split(quote)[1])
    .filter(table => FINANCIAL_BACKUP_TABLES.includes(table));
  assert.deepEqual(deleteOrder, [...FINANCIAL_BACKUP_TABLES].reverse());
  assert.deepEqual(insertOrder, [...FINANCIAL_BACKUP_TABLES]);
  const reviewInsert = ctx.calls.find(call => call.sql?.startsWith('INSERT INTO `financial_reconciliation_review_events`'));
  const providerInsert = ctx.calls.find(call => call.sql?.startsWith('INSERT INTO `provider_webhook_events`'));
  assert.ok(reviewInsert);
  assert.ok(providerInsert);
  assert.equal(reviewInsert.params[1], JSON.stringify({ status: 'pending' }));
  assert.equal(reviewInsert.params[2], JSON.stringify({ status: 'matched' }));
  assert.equal(providerInsert.params[1], JSON.stringify({ orderReference: 'order-1', paymentStatus: 'paid' }));
});


test('super-admin login and audit log endpoints cap requested rows at 1000', async () => {
  const ctx = setup();
  for (const path of ['/api/super/login-logs', '/api/super/audit-logs']) {
    const res = response();
    await ctx.handlers.get(path)({ query: { limit: '999999999999' } }, res);
    assert.equal(res.statusCode, 200);
    const call = ctx.allCalls.at(-1);
    assert.match(call.sql, /LIMIT \?/);
    assert.deepEqual(call.params, [1000]);
  }
});

test('super-admin log endpoints clamp non-positive limits and reject numeric coercion', async () => {
  const ctx = setup();
  const loginRes = response();
  await ctx.handlers.get('/api/super/login-logs')({ query: { limit: '-5' } }, loginRes);
  assert.deepEqual(ctx.allCalls.at(-1).params, [1]);

  const auditRes = response();
  await ctx.handlers.get('/api/super/audit-logs')({ query: { limit: '2.5' } }, auditRes);
  assert.deepEqual(ctx.allCalls.at(-1).params, [200]);
});
