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

function setup({ storeCount = 1, currentStoreId = 2, firstStoreId = 1, dependentTable = null, failAudit = false, sourceMenus = [], existingMenus = [], failMenuInsert = false } = {}) {
  let createHandler;
  let deleteHandler;
  let updateHandler;
  let copyHandler;
  let transactionCount = 0;
  let rolledBack = false;
  let inTransaction = false;
  const calls = [];
  const app = {
    get() {},
    put(path, ...handlers) {
      if (path === '/api/admin/stores/:id') updateHandler = handlers[handlers.length - 1];
    },
    post(path, ...handlers) {
      if (path === '/api/admin/stores') createHandler = handlers[handlers.length - 1];
      if (path === '/api/admin/stores/:id/copy-menu') copyHandler = handlers[handlers.length - 1];
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
      if (sql.includes('FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1')) return { id: firstStoreId };
      if (sql.includes('FROM merchant_admins WHERE id=? AND merchant_id=?')) return { username: 'owner' };
      if (sql.includes('FROM stores WHERE code=? AND id<>?')) return null;
      if (sql.includes('FROM stores WHERE id=? AND merchant_id=?')) {
        return { id: Number(params[0]), merchant_id: 5, name: 'Branch', code: 'branch-2' };
      }
      if (sql.includes('COUNT(*) AS count FROM')) {
        const table = sql.match(/FROM\s+`?([a-z_]+)/i)?.[1];
        return { count: table === dependentTable ? 1 : 0 };
      }
      return null;
    },
    allAsync: async (sql) => {
      calls.push({ type: 'all', sql, inTransaction });
      if (sql.includes('FROM menus WHERE store_id=? AND merchant_id=?')) return sourceMenus;
      if (sql.includes('FROM menus WHERE store_id=?')) return existingMenus;
      if (sql.includes('FROM stores WHERE merchant_id=?')) {
        return Array.from({ length: storeCount }, (_, i) => ({ id: i === 0 ? firstStoreId : currentStoreId + i - 1 }));
      }
      return [];
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (failMenuInsert && sql.startsWith('INSERT INTO menus')) throw new Error('menu insert failure');
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
  return { createHandler, deleteHandler, updateHandler, copyHandler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
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
  const insertStore = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO stores'));
  assert.match(insertStore.params[1], /^m5-[a-f0-9]{12}$/);
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
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('store deletion refuses to orphan active cashier sessions', async () => {
  const ctx = setup({ storeCount: 2, currentStoreId: 2, firstStoreId: 1, dependentTable: 'cashier_sessions' });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, params: { id: '2' }, adminId: 7, username: 'owner' }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /cashier_sessions/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM stores')), false);
});

test('store update rejects ambiguous active values before starting a transaction', async () => {
  const ctx = setup({ storeCount: 2 });
  const res = response();
  await ctx.updateHandler({ merchantId: 5, params: { id: '2' }, body: { active: 'false' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /门店状态/);
  assert.equal(ctx.transactionCount, 0);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE stores')), false);
});

test('store update and audit are committed in the same transaction', async () => {
  const ctx = setup({ storeCount: 2 });
  const res = response();
  await ctx.updateHandler({ merchantId: 5, adminId: 7, params: { id: '2' }, body: { name: 'Renamed Branch', active: 0 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, false);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE stores') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('menu copy inserts all rows in one transaction and audits the copy', async () => {
  const ctx = setup({ storeCount: 2, sourceMenus: [{ id: 1, name: 'Roast Duck', price: 10, image: '' }] });
  const res = response();
  await ctx.copyHandler({ merchantId: 5, adminId: 7, params: { id: '2' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.copied, 1);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO menus') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('menu copy rolls back when a later menu insert fails', async () => {
  const ctx = setup({
    storeCount: 2,
    sourceMenus: [
      { id: 1, name: 'Roast Duck', price: 10, image: '' },
      { id: 2, name: 'Char Siu', price: 8, image: '' }
    ],
    failMenuInsert: true
  });
  const res = response();
  await ctx.copyHandler({ merchantId: 5, adminId: 7, params: { id: '2' } }, res);

  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /所有更改已回滚/);
  assert.equal(ctx.rolledBack, true);
});
