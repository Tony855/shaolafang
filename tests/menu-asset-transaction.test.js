'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

function setup({ failAudit = false, failDelete = false, uploadDir } = {}) {
  let updateHandler;
  let deleteHandler;
  let inTransaction = false;
  let rolledBack = false;
  let transactionCount = 0;
  const calls = [];
  const currentMenu = {
    id: 4, store_id: 2, merchant_id: 5, name: 'Roast Duck', emoji: '🍗',
    price: 10, category: 'Main', desc: '', image: 'old-image.jpg', video: '',
    currency_code: 'USD', name_en: '', desc_en: '', unit: '份', show_dual: 0,
    secondary_currency_code: ''
  };
  const app = {
    get() {},
    post() {},
    put(route, ...handlers) { if (route === '/api/menu/:id') updateHandler = handlers[handlers.length - 1]; },
    delete(route, ...handlers) { if (route === '/api/menu/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM menus WHERE id=? AND store_id=?')) return { ...currentMenu, id: Number(params[0]) };
      if (sql.includes('FROM currencies')) return { code: 'USD' };
      if (sql.includes('FROM merchant_admins')) return { username: 'owner' };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (failDelete && sql.startsWith('DELETE FROM menus')) throw new Error('delete failure');
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
    upload: { fields: () => middleware, single: () => middleware },
    UPLOAD_DIR: uploadDir,
    path,
    fs,
    compressImage: async () => ({ skipped: true }),
    hashPassword: value => value,
    verifyPassword: () => true,
    authenticateAdmin: middleware
  };
  attachMenuRoutes(app, deps);
  return { updateHandler, deleteHandler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('menu update and audit execute in one transaction', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-menu-update-'));
  fs.writeFileSync(path.join(uploadDir, 'old-image.jpg'), 'old');
  const ctx = setup({ uploadDir });
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, storeId: 2, adminId: 9, params: { id: '4' },
    body: { name: 'Roast Duck Updated', show_dual: false }, files: {}
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('UPDATE menus') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
  assert.equal(fs.existsSync(path.join(uploadDir, 'old-image.jpg')), true);
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('menu update keeps old media when the database transaction rolls back', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-menu-rollback-'));
  fs.writeFileSync(path.join(uploadDir, 'old-image.jpg'), 'old');
  const ctx = setup({ failAudit: true, uploadDir });
  const res = response();
  await ctx.updateHandler({
    merchantId: 5, storeId: 2, adminId: 9, params: { id: '4' },
    body: { name: 'Changed' }, files: {}
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.equal(fs.existsSync(path.join(uploadDir, 'old-image.jpg')), true);
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('menu deletion commits database and audit before removing media', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-menu-delete-'));
  fs.writeFileSync(path.join(uploadDir, 'old-image.jpg'), 'old');
  const ctx = setup({ uploadDir });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, storeId: 2, adminId: 9, params: { id: '4' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('DELETE FROM menus') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
  assert.equal(fs.existsSync(path.join(uploadDir, 'old-image.jpg')), false);
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('menu deletion preserves media if the database delete fails', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-menu-delete-fail-'));
  fs.writeFileSync(path.join(uploadDir, 'old-image.jpg'), 'old');
  const ctx = setup({ failDelete: true, uploadDir });
  const res = response();
  await ctx.deleteHandler({ merchantId: 5, storeId: 2, params: { id: '4' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.equal(fs.existsSync(path.join(uploadDir, 'old-image.jpg')), true);
  fs.rmSync(uploadDir, { recursive: true, force: true });
});
