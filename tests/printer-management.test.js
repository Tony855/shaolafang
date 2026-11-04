'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachPrinterRoutes = require('../routes/admin-printers');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ printerCount = 0, currentDefault = 1, replacement = { id: 22 }, failAudit = false } = {}) {
  let createHandler;
  let updateHandler;
  let deleteHandler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const app = {
    get() {},
    post(route, ...handlers) { if (route === '/api/admin/printers') createHandler = handlers[handlers.length - 1]; },
    put(route, ...handlers) { if (route === '/api/admin/printers/:id') updateHandler = handlers[handlers.length - 1]; },
    delete(route, ...handlers) { if (route === '/api/admin/printers/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM stores')) return { id: Number(params[0]) };
      if (sql.includes('COUNT(*) AS count FROM printers')) return { count: printerCount };
      if (sql.includes('FROM printers WHERE id=? AND store_id=? AND merchant_id=?')) {
        return { id: Number(params[0]), name: 'Kitchen Printer', type: 'network', ip_address: '192.0.2.1',
          port: 9100, paper_width: 58, brand: 'generic', is_default: currentDefault, active: 1 };
      }
      if (sql.includes('FROM printers WHERE store_id=? AND merchant_id=? AND id<>?')) return replacement;
      if (sql.includes('FROM printers WHERE id=? AND store_id=?')) return { id: Number(params[0]), name: 'New Printer', is_default: 1 };
      if (sql.includes('FROM merchant_admins')) return { username: 'owner' };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('INSERT INTO printers')) return { lastID: 44, affectedRows: 1 };
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
    getClientIp: () => '127.0.0.1'
  };
  attachPrinterRoutes(app, deps);
  return { createHandler, updateHandler, deleteHandler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('first printer becomes default and audit is part of the transaction', async () => {
  const ctx = setup({ printerCount: 0 });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2, adminId: 9,
    body: { name: 'Kitchen', ip_address: '192.0.2.10' }
  }, res);

  assert.equal(res.statusCode, 201);
  const insert = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO printers'));
  assert.equal(insert.params[6], 1);
  assert.ok(insert.inTransaction);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('printer flags reject truthy strings instead of coercing them', async () => {
  const ctx = setup();
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2,
    body: { name: 'Kitchen', is_default: 'false' }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(ctx.transactionCount, 0);
});

test('default printer cannot be disabled without transferring the default', async () => {
  const ctx = setup({ currentDefault: 1, replacement: null });
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, storeId: 2, params: { id: '11' }, body: { active: false }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /默认打印机/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE printers')), false);
});

test('deleting the default printer promotes another active printer in the same transaction', async () => {
  const ctx = setup({ currentDefault: 1, replacement: { id: 22 } });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, storeId: 2, adminId: 9, params: { id: '11' } }, res);

  assert.equal(res.statusCode, 200);
  const promote = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('UPDATE printers SET is_default=1'));
  const remove = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('DELETE FROM printers'));
  const audit = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs'));
  assert.ok(promote && remove && audit);
  assert.ok(promote.inTransaction && remove.inTransaction && audit.inTransaction);
});

test('printer create rolls back if audit insertion fails', async () => {
  const ctx = setup({ printerCount: 0, failAudit: true });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2, adminId: 9,
    body: { name: 'Kitchen' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
});
