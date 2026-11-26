'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerDeliveryRoutes = require('../routes/delivery');

function setup(options = {}) {
  const handlers = new Map();
  const calls = [];
  const pass = (_req, _res, next) => next();
  const app = {
    get(path, ...routeHandlers) { handlers.set('GET ' + path, routeHandlers.at(-1)); },
    post(path, ...routeHandlers) { handlers.set('POST ' + path, routeHandlers.at(-1)); },
    put(path, ...routeHandlers) { handlers.set('PUT ' + path, routeHandlers.at(-1)); }
  };
  registerDeliveryRoutes(app, {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM stores')) return options.store === undefined ? { id: 7, merchant_id: 3 } : options.store;
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      if (options.insertError) throw options.insertError;
      return { insertId: 41 };
    },
    withTransaction: async work => work(),
    requireAdminKey: pass,
    requirePermission: () => pass,
    hashPassword: value => 'hashed:' + value,
    verifyPassword: () => true,
    io: { to: () => ({ emit() {} }) },
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {}
  });
  return { handler: handlers.get('POST /api/admin/delivery/riders'), calls };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

const request = (overrides = {}) => ({
  merchantId: 3,
  storeId: 7,
  body: { username: 'rider_01', password: 'secret-pass-123', displayName: 'Rider One', phone: '012345678' },
  ...overrides
});

test('creating a rider hashes the password and binds the authenticated merchant and store', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    success: true,
    rider: { id: 41, username: 'rider_01', displayName: 'Rider One', phone: '012345678' }
  });
  const insert = ctx.calls.find(call => call.type === 'run');
  assert.deepEqual(insert.params, [3, 7, 'rider_01', 'hashed:secret-pass-123', 'Rider One', '012345678']);
  assert.doesNotMatch(JSON.stringify(res.body), /secret-pass-123|hashed:/);
});

test('invalid rider credentials are rejected before database insertion', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(request({ body: { username: 'ab', password: 'short', displayName: '', phone: '' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
});

test('rider creation rejects a store outside the authenticated merchant', async () => {
  const ctx = setup({ store: null });
  const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
});

test('duplicate rider usernames return a safe conflict response', async () => {
  const ctx = setup({ insertError: Object.assign(new Error('duplicate secret database details'), { code: 'ER_DUP_ENTRY' }) });
  const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: '该门店已存在相同骑手账号' });
  assert.doesNotMatch(JSON.stringify(res.body), /duplicate|database details/i);
});

test('unexpected rider creation failures do not expose database errors', async () => {
  const ctx = setup({ insertError: new Error('db.internal password=do-not-leak') });
  const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '创建骑手失败' });
  assert.doesNotMatch(JSON.stringify(res.body), /db\.internal|do-not-leak|password=/i);
});
