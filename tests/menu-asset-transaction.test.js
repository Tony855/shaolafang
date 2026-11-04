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

function setup({ failAudit = false, failDelete = false, failMenuInsert = false, uploadDir } = {}) {
  let createHandler;
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
    post(route, ...handlers) { if (route === '/api/menu') createHandler = handlers[handlers.length - 1]; },
    put(route, ...handlers) { if (route === '/api/menu/:id') updateHandler = handlers[handlers.length - 1]; },
    delete(route, ...handlers) { if (route === '/api/menu/:id') deleteHandler = handlers[handlers.length - 1]; }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params, inTransaction });
      if (sql.includes('FROM menus WHERE id=? AND store_id=?')) return { ...currentMenu, id: Number(params[0]) };
      if (sql.includes('FROM stores')) return { id: Number(params[0]) };
      if (sql.includes('FROM currencies')) return { code: 'USD' };
      if (sql.includes('FROM currencies')) return { code: 'USD' };
      if (sql.includes('FROM merchant_admins')) return { username: 'owner' };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params, inTransaction });
      if (failAudit && sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit failure');
      if (failDelete && sql.startsWith('DELETE FROM menus')) throw new Error('delete failure');
      if (failMenuInsert && sql.startsWith('INSERT INTO menus')) throw new Error('menu insert failure');
      if (sql.startsWith('INSERT INTO menus')) return { lastID: 5, affectedRows: 1 };
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
  return { createHandler, updateHandler, deleteHandler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
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

test('menu creation validates and inserts the item with audit in one transaction', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-menu-create-'));
  const ctx = setup({ uploadDir });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2, adminId: 9,
    body: { name: 'New Dish', price: '12.5', currency_code: 'USD', show_dual: false },
    files: {}
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(ctx.transactionCount, 1);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO menus') && call.inTransaction));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO audit_logs') && call.inTransaction));
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('menu creation rejects ambiguous boolean flags and cleans uploaded assets', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-menu-create-invalid-'));
  fs.writeFileSync(path.join(uploadDir, 'upload.jpg'), 'not-an-image');
  const ctx = setup({ uploadDir });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2, params: {},
    body: { name: 'New Dish', price: 12, show_dual: 'false' },
    files: { image: [{ filename: 'upload.jpg' }] }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(fs.existsSync(path.join(uploadDir, 'upload.jpg')), false);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.startsWith('INSERT INTO menus')), false);
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

test('menu creation removes newly uploaded media when audit insertion fails', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-menu-create-audit-'));
  fs.writeFileSync(path.join(uploadDir, 'upload.jpg'), 'not-an-image');
  const ctx = setup({ failAudit: true, uploadDir });
  const res = response();
  await ctx.createHandler({
    merchantId: 5, storeId: 2, adminId: 9,
    body: { name: 'New Dish', price: 12 },
    files: { image: [{ filename: 'upload.jpg' }] }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.equal(fs.existsSync(path.join(uploadDir, 'upload.jpg')), false);
  fs.rmSync(uploadDir, { recursive: true, force: true });
});
