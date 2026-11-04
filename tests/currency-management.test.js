'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachSettingsRoutes = require('../routes/admin-settings');

function middleware() { return (_req, _res, next) => next(); }
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ currencyCount = 1, menuReferences = 0, otherCurrency = null, failAudit = false, currentIsDefault = 1 } = {}) {
  let createHandler;
  let updateHandler;
  let deleteHandler;
  let displayHandler;
  let notificationHandler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const app = {
    get() {},
    post(route, ...handlers) {
      if (route === '/api/currencies') createHandler = handlers[handlers.length - 1];
      if (route === '/api/admin/display-settings') displayHandler = handlers[handlers.length - 1];
      if (route === '/api/admin/notification-settings') notificationHandler = handlers[handlers.length - 1];
    },
    put(route, ...handlers) { if (route === '/api/currencies/:id') updateHandler = handlers[handlers.length - 1]; },
    delete(route, ...handlers) { if (route === '/api/currencies/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM merchants')) return { id: 5 };
      if (sql.includes('COUNT(*) AS count FROM currencies')) return { count: currencyCount };
      if (sql.includes('SELECT * FROM currencies WHERE id=? AND merchant_id=?')) {
        return { id: Number(params[0]), merchant_id: 5, code: 'USD', symbol: '$', name: 'US Dollar', rate: 1, is_default: currentIsDefault };
      }
      if (sql.includes('SELECT id FROM currencies WHERE merchant_id=? AND id<>?')) return otherCurrency;
      if (sql.includes('SELECT code FROM currencies')) return { code: params[0] };
      if (sql.includes('COUNT(*) AS count FROM menus')) return { count: menuReferences };
      if (sql.includes('FROM stores WHERE id=? AND merchant_id=?')) return { id: Number(params[0]) };
      if (sql.includes('FROM merchant_admins')) return { username: 'owner' };
      return null;
    },
    allAsync: async sql => {
      calls.push({ type: 'all', sql, inTransaction });
      if (sql.includes('FROM stores WHERE merchant_id=?')) return [{ id: 2 }, { id: 3 }];
      return [];
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('INSERT INTO currencies')) return { lastID: 50, affectedRows: 1 };
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
    getClientIp: () => '127.0.0.1'
  };
  attachSettingsRoutes(app, deps);
  return {
    createHandler, updateHandler, deleteHandler, displayHandler, calls,
    get transactionCount() { return transactionCount; },
    get rolledBack() { return rolledBack; }
  };
}

test('first currency is promoted to default and audit is in the transaction', async () => {
  const ctx = setup({ currencyCount: 0 });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, adminId: 9,
    body: { code: 'USD', symbol: '$', name: 'US Dollar', rate: 1, is_default: false }
  }, res);

  assert.equal(res.statusCode, 201);
  const insert = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO currencies'));
  assert.equal(insert.params[5], 1);
  assert.ok(insert.inTransaction);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('last default currency cannot be unset', async () => {
  const ctx = setup({ otherCurrency: null });
  const res = response();
  await ctx.updateHandler({ merchantId: 5, params: { id: '10' }, body: { is_default: false } }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /至少保留一个默认货币/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE currencies')), false);
});

test('currency deletion is blocked while a menu references it', async () => {
  const ctx = setup({ menuReferences: 3, currentIsDefault: 0 });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, params: { id: '10' } }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /菜品使用/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM currencies')), false);
});

test('display settings reject truthy string false for applyAll', async () => {
  const ctx = setup();
  const res = response();
  await ctx.displayHandler({
    merchantId: 5, storeId: 2,
    body: { primaryCurrencyCode: 'USD', secondaryCurrencyCode: '', applyAll: 'false' }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(ctx.transactionCount, 0);
});

test('display settings apply to all stores in one transaction with audit', async () => {
  const ctx = setup();
  const res = response();
  await ctx.displayHandler({
    merchantId: 5, storeId: 2, adminId: 9,
    body: { primaryCurrencyCode: 'USD', secondaryCurrencyCode: '', applyAll: true }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.calls.filter(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings')).length, 4);
  assert.ok(ctx.calls.filter(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings')).every(call => call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('currency creation rolls back when audit insertion fails', async () => {
  const ctx = setup({ currencyCount: 1, failAudit: true });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, adminId: 9,
    body: { code: 'EUR', symbol: '€', name: 'Euro', rate: 0.9, is_default: true }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.match(res.body.error, /所有更改已回滚/);
});

test('notification settings reject truthy string false', async () => {
  const ctx = setup();
  const res = response();
  await ctx.notificationHandler({ merchantId: 5, storeId: 2, body: { enabled: 'false' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(ctx.transactionCount, 0);
});

test('notification settings write false explicitly and audit in one transaction', async () => {
  const ctx = setup();
  const res = response();
  await ctx.notificationHandler({ merchantId: 5, storeId: 2, adminId: 9, body: { enabled: false } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(ctx.transactionCount, 1);
  const setting = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings'));
  const audit = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs'));
  assert.equal(setting.params[1], '0');
  assert.ok(setting.inTransaction && audit.inTransaction);
});
