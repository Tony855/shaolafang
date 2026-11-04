'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader() {}
  };
}

const tableNames = [
  'merchants', 'stores', 'tables', 'menu_categories', 'menus', 'currencies',
  'order_sequences', 'orders', 'settings', 'login_logs', 'audit_logs', 'waiters',
  'waiter_calls', 'reservations', 'printers', 'merchant_admins', 'super_admins'
];

function backup({ superAdmins = [{ id: 1, username: 'root', password_hash: 'hash' }] } = {}) {
  const tables = Object.fromEntries(tableNames.map(name => [name, []]));
  tables.super_admins = superAdmins;
  return { exportedAt: new Date().toISOString(), tables };
}

function setup({ failAudit = false } = {}) {
  let handler;
  let inTransaction = false;
  let rolledBack = false;
  const calls = [];
  const app = {
    post(path, ...handlers) {
      if (path === '/api/super/backup/import') handler = handlers[handlers.length - 1];
    },
    get() {}, put() {}, delete() {}
  };
  attachSuperRoutes(app, {
    getAsync: async () => null,
    allAsync: async sql => {
      assert.equal(inTransaction, true);
      if (sql.startsWith('SHOW COLUMNS')) {
        return [{ Field: 'id' }, { Field: 'username' }, { Field: 'password_hash' }];
      }
      return [];
    },
    runAsync: async sql => {
      calls.push({ sql, inTransaction });
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
    getClientIp: () => '127.0.0.1',
    collectBackupData: async () => backup(),
    autoBackupDatabase: async () => ({})
  });
  return { handler, calls, get inTransaction() { return inTransaction; }, get rolledBack() { return rolledBack; } };
}

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
  assert.ok(ctx.calls.filter(call => call.sql?.startsWith('DELETE FROM')).every(call => call.inTransaction));
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
