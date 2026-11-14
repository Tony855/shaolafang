'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachAdminManageRoutes = require('../routes/admin-manage');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ passwordValid = true, failAudit = false, merchantActive = true } = {}) {
  let handler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const app = {
    get() {},
    post(route, ...handlers) { if (route === '/api/admin/reset-data') handler = handlers[handlers.length - 1]; },
    put() {}, delete() {}
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM merchants')) return merchantActive ? { id: 5 } : null;
      if (sql.includes('FROM merchant_admins')) return { id: 9, username: 'owner', password_hash: 'hash' };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('DELETE FROM orders')) return { affectedRows: 12 };
      if (sql.startsWith('DELETE FROM waiter_calls')) return { affectedRows: 2 };
      if (sql.startsWith('DELETE FROM scan_sessions')) return { affectedRows: 3 };
      if (sql.startsWith('DELETE FROM reservations')) return { affectedRows: 4 };
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
    requireAdminOrCashier: middleware,
    requireAdminOrCashierOrWaiter: middleware,
    requireAdminOrWaiter: middleware,
    hashPassword: value => value,
    verifyPassword: () => passwordValid,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) }
  };
  attachAdminManageRoutes(app, deps);
  return { handler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('merchant data reset verifies the active admin under lock and audits all deletions atomically', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ merchantId: 5, adminId: 9, body: { password: 'correct-password' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedOrders, 12);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'get' && call.sql.includes('FOR UPDATE') && call.sql.includes('FROM merchant_admins') && call.inTransaction));
  const outboxOrderDelete = ctx.calls.findIndex(call => call.type === 'run' && call.sql.includes('DELETE n FROM telegram_notification_outbox'));
  const outboxTenantDelete = ctx.calls.findIndex(call => call.type === 'run' && call.sql.includes('DELETE FROM telegram_notification_outbox WHERE'));
  const challengesDelete = ctx.calls.findIndex(call => call.type === 'run' && call.sql.includes('DELETE FROM telegram_customer_binding_challenges'));
  const bindingsDelete = ctx.calls.findIndex(call => call.type === 'run' && call.sql.includes('DELETE FROM telegram_customer_bindings'));
  const ordersDelete = ctx.calls.findIndex(call => call.type === 'run' && call.sql.startsWith('DELETE FROM orders'));
  assert.ok(outboxOrderDelete >= 0 && outboxTenantDelete > outboxOrderDelete);
  assert.ok(challengesDelete > outboxTenantDelete && bindingsDelete > challengesDelete && ordersDelete > bindingsDelete);
  assert.deepEqual(ctx.calls[outboxOrderDelete].params, [5]);
  assert.deepEqual(ctx.calls[outboxTenantDelete].params, [5, 5]);
    assert.ok(ctx.calls.filter(call => call.type === 'run' && /^(DELETE FROM|UPDATE tables|UPDATE menus)/.test(call.sql)).every(call => call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('merchant data reset rejects invalid password before destructive statements', async () => {
  const ctx = setup({ passwordValid: false });
  const res = response();
  await ctx.handler({ merchantId: 5, adminId: 9, body: { password: 'wrong-password' } }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM')), false);
});

test('merchant data reset rolls back when the audit insert fails', async () => {
  const ctx = setup({ failAudit: true });
  const res = response();
  await ctx.handler({ merchantId: 5, adminId: 9, body: { password: 'correct-password' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
});
