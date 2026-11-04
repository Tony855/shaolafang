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

function setup({ failAudit = false, primaryId = 1 } = {}) {
  let createHandler;
  let updateHandler;
  let deleteHandler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const app = {
    get() {},
    post(path, ...handlers) { if (path === '/api/admin/admins') createHandler = handlers[handlers.length - 1]; },
    put(path, ...handlers) { if (path === '/api/admin/admins/:id') updateHandler = handlers[handlers.length - 1]; },
    delete(path, ...handlers) { if (path === '/api/admin/admins/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM merchants')) return { id: 5 };
      if (sql.includes('SELECT id FROM merchant_admins WHERE username')) return null;
      if (sql.includes('SELECT MIN(id) AS min_id')) return { min_id: primaryId };
      if (sql.includes('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?')) {
        return { id: Number(params[0]), merchant_id: 5, username: 'secondary', display_name: 'Secondary',
          active: 1, can_manage_menu: 0, can_manage_table: 0, can_manage_order: 0, can_delete_order: 0,
          can_edit_order: 0, can_manage_store: 0, can_manage_waiter: 0, can_manage_currency: 0,
          can_manage_printer: 0, can_manage_admin: 0, can_view_logs: 0, can_manage_cashier: 0 };
      }
      if (sql.includes('SELECT username FROM merchant_admins')) return { username: 'owner' };
      if (sql.includes('SELECT id, username, display_name, active')) return { id: Number(params[0]), username: 'secondary', active: 1 };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('INSERT INTO merchant_admins')) return { lastID: 88, affectedRows: 1 };
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
    hashPassword: value => 'hashed:' + value,
    verifyPassword: () => true,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) }
  };
  attachAdminManageRoutes(app, deps);
  return { createHandler, updateHandler, deleteHandler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('admin creation and audit are atomic and defaults the account to active', async () => {
  const ctx = setup();
  const res = response();
  await ctx.createHandler({
    merchantId: 5, adminId: 9,
    body: { username: 'new-admin', password: 'long-password-123', display_name: 'New Admin' }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(ctx.transactionCount, 1);
  const insert = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO merchant_admins'));
  assert.ok(insert);
  assert.equal(insert.params[4], 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('admin update validates password before opening a transaction', async () => {
  const ctx = setup();
  const res = response();
  await ctx.updateHandler({ merchantId: 5, params: { id: '88' }, body: { display_name: 'Changed', password: 'short' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /密码长度/);
  assert.equal(ctx.transactionCount, 0);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
});

test('admin credential and permission changes invalidate existing sessions atomically', async () => {
  const ctx = setup();
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, adminId: 9, params: { id: '88' },
    body: { password: 'replacement-password-123', can_manage_menu: true, permissions: { can_manage_menu: true } }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM admin_sessions') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('admin deletion removes sessions before deleting the account', async () => {
  const ctx = setup();
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, adminId: 9, params: { id: '88' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  const sessionDelete = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('DELETE FROM admin_sessions'));
  const adminDelete = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('DELETE FROM merchant_admins'));
  const audit = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs'));
  assert.ok(sessionDelete && adminDelete && audit);
  assert.ok(sessionDelete.inTransaction && adminDelete.inTransaction && audit.inTransaction);
});

test('admin update rolls back when audit insertion fails', async () => {
  const ctx = setup({ failAudit: true });
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, adminId: 9, params: { id: '88' },
    body: { display_name: 'Changed' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
});

test('primary admin cannot be deleted', async () => {
  const ctx = setup({ primaryId: 88 });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, adminId: 9, params: { id: '88' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /主管理员不可删除/);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
});
