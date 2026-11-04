'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachMenuRoutes = require('../routes/menu');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ categoryName = 'Hot Dishes', remainingCategory = { id: 2, name: 'Drinks' }, categoryRows = [{ id: 1 }, { id: 2 }], failAudit = false } = {}) {
  let statusHandler;
  let createHandler;
  let updateHandler;
  let deleteHandler;
  let sortHandler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const app = {
    get() {},
    post(route, ...handlers) {
      if (route === '/api/menu-categories') createHandler = handlers[handlers.length - 1];
      if (route === '/api/menu-categories/sort') sortHandler = handlers[handlers.length - 1];
    },
    put(route, ...handlers) {
      if (route === '/api/menu/:id/status') statusHandler = handlers[handlers.length - 1];
      if (route === '/api/menu-categories/:id') updateHandler = handlers[handlers.length - 1];
    },
    delete(route, ...handlers) { if (route === '/api/menu-categories/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM stores')) return { id: Number(params[0]) };
      if (sql.includes('FROM menus WHERE id=? AND store_id=?')) return { id: Number(params[0]), name: 'Dish', active: 1 };
      if (sql.includes('FROM menu_categories WHERE name=?')) return null;
      if (sql.includes('MAX(sort)')) return { max: 2 };
      if (sql.includes('FROM menu_categories WHERE id<>?')) return remainingCategory;
      if (sql.includes('FROM menu_categories WHERE id=?')) return { id: Number(params[0]), name: categoryName };
      if (sql.includes('FROM merchant_admins')) return { username: 'owner' };
      return null;
    },
    allAsync: async sql => {
      calls.push({ type: 'all', sql, inTransaction });
      if (sql.includes('FROM menu_categories WHERE store_id=?')) return categoryRows;
      return [];
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('INSERT INTO menu_categories')) return { lastID: 88, affectedRows: 1 };
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
    upload: { fields: () => middleware, single: () => middleware },
    UPLOAD_DIR: '/tmp',
    path: require('path'),
    fs: require('fs'),
    getClientIp: () => '127.0.0.1',
    logAudit: async () => {},
    compressImage: async () => ({ skipped: true }),
    hashPassword: value => value,
    verifyPassword: () => true
  };
  attachMenuRoutes(app, deps);
  return {
    statusHandler, createHandler, updateHandler, deleteHandler, sortHandler, calls,
    get transactionCount() { return transactionCount; },
    get rolledBack() { return rolledBack; }
  };
}

test('menu status rejects string false rather than enabling the item', async () => {
  const ctx = setup();
  const res = response();
  await ctx.statusHandler({ merchantId: 5, storeId: 2, params: { id: '4' }, body: { active: 'false' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(ctx.transactionCount, 0);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE menus')), false);
});

test('category rename and menu reassignment are audited in one transaction', async () => {
  const ctx = setup();
  const res = response();
  await ctx.updateHandler({ merchantId: 5, storeId: 2, adminId: 9, params: { id: '1' }, body: { name: 'New Category' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE menu_categories') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE menus SET category') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('the only Other category cannot be deleted', async () => {
  const ctx = setup({ categoryName: '其他', remainingCategory: null });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, storeId: 2, params: { id: '1' } }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /唯一的“其他”分类/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM menu_categories')), false);
});

test('category sort requires the complete current category ID set', async () => {
  const ctx = setup({ categoryRows: [{ id: 1 }, { id: 2 }] });
  const res = response();
  await ctx.sortHandler({ merchantId: 5, storeId: 2, body: { ids: [1] } }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /分类列表已变化/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE menu_categories')), false);
});

test('category creation rolls back if its audit insert fails', async () => {
  const ctx = setup({ failAudit: true });
  const res = response();
  await ctx.createHandler({ merchantId: 5, storeId: 2, adminId: 9, body: { name: 'Desserts' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
});
