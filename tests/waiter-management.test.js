'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachWaiterRoutes = require('../routes/waiters');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ failAudit = false } = {}) {
  let createHandler;
  let updateHandler;
  let deleteHandler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const app = {
    get() {},
    post(path, ...handlers) { if (path === '/api/admin/waiters') createHandler = handlers[handlers.length - 1]; },
    put(path, ...handlers) { if (path === '/api/admin/waiters/:id') updateHandler = handlers[handlers.length - 1]; },
    delete(path, ...handlers) { if (path === '/api/admin/waiters/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM merchants')) return { id: 5 };
      if (sql.includes('FROM stores')) return { id: Number(params[0]) };
      if (sql.includes('FROM waiters')) return {
        id: Number(params[0]), merchant_id: 5, username: 'server', display_name: 'Server',
        store_id: 1, active: 1, can_order: 1, can_mark_item: 1, can_complete_order: 1
      };
      if (sql.includes('FROM merchant_admins')) return { username: 'owner' };
      return null;
    },
    allAsync: async sql => {
      calls.push({ type: 'all', sql, inTransaction });
      return [];
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('INSERT INTO waiters')) return { lastID: 77, affectedRows: 1 };
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
    requireAdminOrWaiter: middleware,
    getClientIp: () => '127.0.0.1',
    logAudit: async () => {},
    hashPassword: value => 'hashed:' + value,
    verifyPassword: () => true,
    authenticateAdmin: middleware,
    UPLOAD_DIR: '/tmp',
    path: require('path'),
    fs: require('fs')
  };
  attachWaiterRoutes(app, deps);
  return {
    createHandler, updateHandler, deleteHandler, calls,
    get transactionCount() { return transactionCount; },
    get rolledBack() { return rolledBack; }
  };
}

test('waiter creation checks cashier names and writes waiter plus audit in one transaction', async () => {
  const ctx = setup();
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 1, adminId: 9,
    body: { username: 'server-one', password: 'secret123', display_name: 'Server One' }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'all' && call.sql.includes('cashiers_%') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO waiters') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('waiter update validates password before any database writes', async () => {
  const ctx = setup();
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, params: { id: '77' },
    body: { display_name: 'Changed Name', password: '123' }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /密码长度/);
  assert.equal(ctx.transactionCount, 0);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
});

test('waiter update invalidates old sessions when access credentials change', async () => {
  const ctx = setup();
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, adminId: 9, params: { id: '77' },
    body: { password: 'new-secret-123', can_order: 0 }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM waiter_sessions') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('waiter deletion removes sessions and waiter atomically', async () => {
  const ctx = setup();
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, adminId: 9, params: { id: '77' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  const sessionDelete = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('DELETE FROM waiter_sessions'));
  const waiterDelete = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('DELETE FROM waiters'));
  const audit = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs'));
  assert.ok(sessionDelete && waiterDelete && audit);
  assert.ok(sessionDelete.inTransaction && waiterDelete.inTransaction && audit.inTransaction);
});

test('waiter update rolls back when its audit write fails', async () => {
  const ctx = setup({ failAudit: true });
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, adminId: 9, params: { id: '77' },
    body: { display_name: 'Changed Name' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
});
