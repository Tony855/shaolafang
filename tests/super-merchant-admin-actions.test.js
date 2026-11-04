const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ merchantExists = true, admins = [{ id: 11 }], failOn } = {}) {
  const calls = [];
  const handlers = {};
  let transactionCount = 0;
  let rolledBack = false;
  const app = {
    post(path, ...stack) {
      if (path === '/api/super/merchants/:id/reset-password') handlers.reset = stack[stack.length - 1];
    },
    put(path, ...stack) {
      if (path === '/api/super/merchants/:id/payment-methods') handlers.payment = stack[stack.length - 1];
    },
    get() {},
    delete() {}
  };
  const deps = {
    getAsync: async sql => {
      calls.push({ type: 'get', sql });
      if (sql.includes('FROM merchants')) return merchantExists ? { id: 9, name: 'Test Merchant' } : null;
      if (sql.includes('store_')) return null;
      return null;
    },
    allAsync: async sql => {
      calls.push({ type: 'all', sql });
      if (sql.includes('FROM merchant_admins')) return admins;
      if (sql.includes('FROM stores')) return [];
      return [];
    },
    runAsync: async sql => {
      calls.push({ type: 'run', sql });
      if (failOn && sql.includes(failOn)) throw new Error('simulated database failure');
      return { affectedRows: 1 };
    },
    withTransaction: async fn => {
      transactionCount++;
      try { return await fn(); }
      catch (error) { rolledBack = true; throw error; }
    },
    requireSuperAdmin: (_req, _res, next) => next(),
    logAudit: async (...args) => {
      calls.push({ type: 'audit', args });
      if (failOn === 'AUDIT') throw new Error('simulated audit failure');
    },
    getClientIp: () => '127.0.0.1',
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    verifyPassword: () => true,
    hashPassword: value => 'hashed:' + value,
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({})
  };
  attachSuperRoutes(app, deps);
  return { ...handlers, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('merchant password reset and audit are atomic and invalidate sessions', async () => {
  const ctx = setup();
  const res = response();
  await ctx.reset({ params: { id: '9' }, body: { password: 'LongSecurePass123' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, false);
  assert.ok(ctx.calls.some(call => call.type === 'get' && call.sql.includes('FOR UPDATE')));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('UPDATE merchant_admins')));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM admin_sessions')));
  assert.equal(ctx.calls.filter(call => call.type === 'audit').length, 1);
});

test('merchant password reset rolls back when audit logging fails', async () => {
  const ctx = setup({ failOn: 'AUDIT' });
  const res = response();
  await ctx.reset({ params: { id: '9' }, body: { password: 'LongSecurePass123' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.deepEqual(res.body, { error: '重置商户密码失败，所有更改已回滚' });
});

test('merchant password reset rejects merchants without admin accounts', async () => {
  const ctx = setup({ admins: [] });
  const res = response();
  await ctx.reset({ params: { id: '9' }, body: { password: 'LongSecurePass123' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
});

test('payment method update and audit share a transaction', async () => {
  const ctx = setup();
  const res = response();
  await ctx.payment({ params: { id: '9' }, body: { methods: { cash: true, card: false } }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, false);
  assert.deepEqual(res.body.methods, { cash: true, wechat: true, alipay: true, card: false });
  assert.equal(ctx.calls.filter(call => call.type === 'audit').length, 1);
});

test('payment method update rolls back when audit logging fails', async () => {
  const ctx = setup({ failOn: 'AUDIT' });
  const res = response();
  await ctx.payment({ params: { id: '9' }, body: { methods: { cash: false } }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.deepEqual(res.body, { error: '更新支付方式失败，所有更改已回滚' });
});

test('payment method update rejects invalid merchant IDs and missing merchants', async () => {
  const invalid = setup();
  const invalidRes = response();
  await invalid.payment({ params: { id: '0' }, body: { methods: {} }, superAdmin: { id: 1, username: 'root' } }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(invalid.transactionCount, 0);

  const missing = setup({ merchantExists: false });
  const missingRes = response();
  await missing.payment({ params: { id: '99' }, body: { methods: {} }, superAdmin: { id: 1, username: 'root' } }, missingRes);
  assert.equal(missingRes.statusCode, 404);
  assert.equal(missing.rolledBack, true);
});
