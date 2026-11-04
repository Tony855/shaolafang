'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachStoreRoutes = require('../routes/stores');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ storeCount = 1, currentStoreId = 2, firstStoreId = 1, dependentTable = null, failAudit = false } = {}) {
  let createHandler;
  let deleteHandler;
  let transactionCount = 0;
  let rolledBack = false;
  let inTransaction = false;
  const calls = [];
  const app = {
    get() {}, put() {},
    post(path, ...handlers) {
      if (path === '/api/admin/stores') createHandler = handlers[handlers.length - 1];
    },
    delete(path, ...handlers) {
      if (path === '/api/admin/stores/:id') deleteHandler = handlers[handlers.length - 1];
    }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM merchants')) return { id: 5, max_stores: 2, status: 1 };
      if (sql.includes('COUNT(*) AS count FROM stores')) return { count: storeCount };
      if (sql.includes('FROM stores WHERE id=? AND merchant_id=?')) {
        return { id: Number(params[0]), merchant_id: 5, name: 'Branch', code: 'branch-2' };
      }
      if (sql.includes('COUNT(*) AS count FROM')) {
        const table = sql.match(/FROM\s+([a-z_]+)/i)?.[1];
        return { count: table === dependentTable ? 1 : 0 };
      }
      return null;
    },
    allAsync: async (sql) => {
      calls.push({ type: 'all', sql, inTransaction });
      if (sql.includes('FROM stores WHERE merchant_id=?')) {
        return Array.from({ length: storeCount }, (_, i) => ({ id: i === 0 ? firstStoreId : currentStoreId + i - 1 }));
      }
      return [];
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('INSERT INTO stores')) return { lastID: 99, affectedRows: 1 };
      if (sql.startsWith('DELETE FROM stores')) return { affectedRows: 1 };
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
    getClientIp: () => '127.0.0.1',
    logAudit: async (...args) => {
      calls.push({ type: 'audit', args, inTransaction });
      if (failAudit) throw new Error('audit failure');
    },
    UPLOAD_DIR: '/tmp/foodflow-test-uploads',
    path: require('path'),
    fs: require('fs'),
    hashPassword: value => value,
    verifyPassword: () => true,
    authenticateAdmin: middleware,
    requireAdminOrWaiter: middleware
  };
  attachStoreRoutes(app, deps);
  return { createHandler, deleteHandler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('store creation locks merchant and checks limit inside the transaction', async () => {
  const ctx = setup({ storeCount: 2 });
  const res = response();
  await ctx.createHandler({ merchantId: 5, adminId: 7, username: 'owner', body: { name: 'Too many' } }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO stores')), false);
});

test('store creation and settings initialization roll back if audit fails', async () => {
  const ctx = setup({ storeCount: 1, failAudit: true });
  const res = response();
  await ctx.createHandler({ merchantId: 5, adminId: 7, username: 'owner', body: { name: 'Branch' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.ok(ctx.calls.filter(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings')).every(call => call.inTransaction));
});

test('store deletion rejects the merchant primary or last store', async () => {
  const ctx = setup({ storeCount: 1, currentStoreId: 1, firstStoreId: 1 });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, params: { id: '1' }, adminId: 7, username: 'owner' }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /默认总店或最后一家门店/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM stores')), false);
});

test('store deletion refuses to orphan existing order history', async () => {
  const ctx = setup({ storeCount: 2, currentStoreId: 2, firstStoreId: 1, dependentTable: 'orders' });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, params: { id: '2' }, adminId: 7, username: 'owner' }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /orders/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM stores')), false);
});

test('empty non-primary store is deleted with settings cleanup and audit in one transaction', async () => {
  const ctx = setup({ storeCount: 2, currentStoreId: 2, firstStoreId: 1 });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, params: { id: '2' }, adminId: 7, username: 'owner' }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(ctx.rolledBack, false);
  assert.ok(ctx.calls.filter(call => call.type === 'run' && call.sql.startsWith('DELETE FROM')).every(call => call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'audit' && call.inTransaction));
});
