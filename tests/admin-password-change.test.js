'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachAdminSystemRoutes = require('../routes/admin-system');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ passwordValid = true, failAudit = false } = {}) {
  let handler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const app = {
    get() {},
    post(route, ...handlers) { if (route === '/api/admin/change-password') handler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM merchant_admins')) return { id: 9, username: 'owner', password_hash: 'old-hash' };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      transactionCount++;
      inTransaction = true;
      try { return await work(); }
      catch (error) { rolledBack = true; throw error; }
      finally { inTransaction = false; }
    },
    requireAdminKey: middleware,
    requirePermission: () => middleware,
    verifyPassword: () => passwordValid,
    hashPassword: value => 'hashed:' + value,
    getClientIp: () => '127.0.0.1',
    logAudit: async () => {}
  };
  attachAdminSystemRoutes(app, deps);
  return { handler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('administrator password change updates hash, preserves current session, and audits atomically', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({
    adminId: 9, merchantId: 5, adminSessionToken: 'current-session',
    body: { oldPassword: 'old-password', newPassword: 'new-password-123' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  const update = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('UPDATE merchant_admins'));
  const sessions = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('DELETE FROM admin_sessions'));
  const audit = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs'));
  assert.ok(update && sessions && audit);
  assert.ok(update.inTransaction && sessions.inTransaction && audit.inTransaction);
  assert.equal(sessions.params[1], 'current-session');
});

test('administrator password change rejects an incorrect old password without writes', async () => {
  const ctx = setup({ passwordValid: false });
  const res = response();
  await ctx.handler({
    adminId: 9, merchantId: 5, adminSessionToken: 'current-session',
    body: { oldPassword: 'wrong-password', newPassword: 'new-password-123' }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
  assert.equal(ctx.rolledBack, true);
});

test('administrator password change rolls back when strict audit insertion fails', async () => {
  const ctx = setup({ failAudit: true });
  const res = response();
  await ctx.handler({
    adminId: 9, merchantId: 5, adminSessionToken: 'current-session',
    body: { oldPassword: 'old-password', newPassword: 'new-password-123' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
});
