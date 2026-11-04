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

function setup({ failAudit = false, corruptStore = null, initialCashiers = {} } = {}) {
  let createHandler;
  let updateHandler;
  let deleteHandler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const settings = new Map(Object.entries(initialCashiers).map(([id, value]) => ['cashiers_' + id, value]));
  const app = {
    get() {},
    post(route, ...handlers) { if (route === '/api/admin/cashiers') createHandler = handlers[handlers.length - 1]; },
    put(route, ...handlers) { if (route === '/api/admin/cashiers/:id') updateHandler = handlers[handlers.length - 1]; },
    delete(route, ...handlers) { if (route === '/api/admin/cashiers/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM merchants')) return { id: 5 };
      if (sql.includes('FROM stores WHERE id=? AND merchant_id=?')) return { id: Number(params[0]), name: Number(params[0]) === 2 ? 'Main' : 'Branch' };
      if (sql.includes('FROM settings')) {
        const key = params[0];
        const value = key === 'cashiers_' + corruptStore ? '{broken-json' : settings.get(key);
        return value === undefined ? null : { value };
      }
      if (sql.includes('FROM waiters')) return null;
      if (sql.includes('FROM merchant_admins')) return { username: 'owner' };
      return null;
    },
    allAsync: async sql => {
      calls.push({ type: 'all', sql, inTransaction });
      if (sql.includes('FROM stores WHERE merchant_id=?')) return [{ id: 2, name: 'Main' }, { id: 3, name: 'Branch' }];
      return [];
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (sql.startsWith('INSERT INTO settings')) settings.set(params[0], params[1]);
      if (sql.startsWith('UPDATE settings')) settings.set(params[1], params[0]);
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
  return { createHandler, updateHandler, deleteHandler, calls, settings, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('cashier creation is serialized, checks waiter usernames, and audits the settings write', async () => {
  const ctx = setup();
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2, adminId: 9,
    body: { username: 'cashier-one', password: 'secret123', display_name: 'Cashier One' }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(ctx.transactionCount, 1);
  const save = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings'));
  const audit = ctx.calls.find(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs'));
  assert.ok(save && audit && save.inTransaction && audit.inTransaction);
  assert.ok(JSON.parse(save.params[1]).some(cashier => cashier.username === 'cashier-one'));
});

test('cashier update validates passwords before opening a transaction', async () => {
  const ctx = setup({ initialCashiers: { 2: JSON.stringify([{ id: 77, username: 'cashier', display_name: 'Cashier', active: true, permissions: {} }]) } });
  const res = response();
  await ctx.updateHandler({ merchantId: 5, params: { id: '77' }, body: { display_name: 'Changed', password: '123' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /密码长度/);
  assert.equal(ctx.transactionCount, 0);
});

test('cashier credential and permission changes invalidate all sessions atomically', async () => {
  const ctx = setup({ initialCashiers: { 2: JSON.stringify([{ id: 77, username: 'cashier', display_name: 'Cashier', active: true, permissions: { can_settle: true, can_cancel: true, can_refund: false, can_view_report: true } }]) } });
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, adminId: 9, params: { id: '77' },
    body: { password: 'new-secret-123', permissions: { can_refund: true } }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM cashier_sessions') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('cashier store transfer updates both settings records in one transaction', async () => {
  const ctx = setup({ initialCashiers: { 2: JSON.stringify([{ id: 77, username: 'cashier', display_name: 'Cashier', active: true, permissions: {} }]), 3: '[]' } });
  const res = response();
  await ctx.updateHandler({ merchantId: 5, adminId: 9, params: { id: '77' }, body: { store_id: 3 } }, res);

  assert.equal(res.statusCode, 200);
  const saves = ctx.calls.filter(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings'));
  assert.equal(saves.length, 2);
  assert.ok(saves.every(call => call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM cashier_sessions') && call.inTransaction));
});

test('cashier delete removes sessions and settings atomically', async () => {
  const ctx = setup({ initialCashiers: { 2: JSON.stringify([{ id: 77, username: 'cashier', display_name: 'Cashier', active: true, permissions: {} }]) } });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, adminId: 9, params: { id: '77' } }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM cashier_sessions') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
});

test('corrupt cashier settings are not silently overwritten as an empty list', async () => {
  const ctx = setup({ corruptStore: 2 });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2,
    body: { username: 'new-cashier', password: 'secret123', display_name: 'New Cashier' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /数据损坏/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO settings')), false);
});
