const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');

function middleware() {
  return (_req, _res, next) => next();
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function setup({ duplicateUsername = false, failOn, merchantExists = true, merchantStatus = 1 } = {}) {
  const calls = [];
  let handler;
  let transactionCount = 0;
  let rolledBack = false;
  const app = {
    post() {},
    get() {},
    delete() {},
    put(path, ...handlers) {
      if (path === '/api/super/merchants/:id') handler = handlers[handlers.length - 1];
    }
  };
  const deps = {
    getAsync: async sql => {
      calls.push({ type: 'get', sql });
      if (sql.includes('FROM merchants') && sql.includes('SELECT country')) return merchantExists ? { country: 'KH', status: merchantStatus } : null;
      if (sql.includes('SELECT id, username FROM merchant_admins')) return { id: 55, username: 'old-admin' };
      if (sql.includes('SELECT id FROM merchant_admins WHERE username')) return duplicateUsername ? { id: 66 } : null;
      if (sql.includes('SELECT name, code FROM merchants')) return { name: 'Updated Merchant', code: 'T009' };
      return null;
    },
    allAsync: async () => [],
    runAsync: async sql => {
      calls.push({ type: 'run', sql });
      if (failOn && sql.includes(failOn)) throw new Error('simulated database failure');
      return { affectedRows: 1 };
    },
    withTransaction: async fn => {
      transactionCount++;
      try {
        return await fn();
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
    requireSuperAdmin: middleware,
    logAudit: async () => { calls.push({ type: 'audit' }); },
    getClientIp: () => '127.0.0.1',
    hashPassword: value => 'hashed:' + value,
    verifyPassword: () => true,
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({})
  };
  attachSuperRoutes(app, deps);
  return { handler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('merchant update checks duplicate username before changing merchant data', async () => {
  const ctx = setup({ duplicateUsername: true });
  const res = response();
  await ctx.handler({
    params: { id: '9' },
    body: { name: 'Should Not Persist', username: 'taken-account', contact_name: 'New Contact' },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: '登录账号已被使用' });
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('UPDATE merchants')), false);
  assert.equal(ctx.calls.some(call => call.type === 'audit'), false);
});

test('merchant profile, admin credentials and audit update in one transaction', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({
    params: { id: '9' },
    body: { name: 'Updated Merchant', username: 'new-admin', password: 'new-password-123', contact_name: 'Contact' },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, false);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('UPDATE merchants')));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('UPDATE merchant_admins SET username')));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('UPDATE merchant_admins SET password_hash')));
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM admin_sessions')));
  assert.ok(ctx.calls.some(call => call.type === 'audit'));
});

test('merchant update returns not found without writes when merchant is missing', async () => {
  const ctx = setup({ merchantExists: false });
  const res = response();
  await ctx.handler({
    params: { id: '9' },
    body: { name: 'Updated Merchant' },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: '商户不存在' });
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
  assert.equal(ctx.calls.some(call => call.type === 'audit'), false);
});

test('merchant update rolls back when a later administrator write fails', async () => {
  const ctx = setup({ failOn: 'UPDATE merchant_admins SET password_hash' });
  const res = response();
  await ctx.handler({
    params: { id: '9' },
    body: { name: 'Updated Merchant', password: 'new-password-123' },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '更新商户失败，所有更改已回滚' });
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(call => call.type === 'audit'), false);
});

test('merchant password change revokes all existing administrator sessions', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({
    params: { id: '9' },
    body: { password: 'replacement-password-123' },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.ok(ctx.calls.some(call => call.type === 'run' &&
    call.sql.includes('DELETE FROM admin_sessions WHERE admin_id IN')));
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM cashier_sessions')), false);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM waiter_sessions')), false);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM scan_sessions')), false);
});

test('merchant status transition revokes all merchant-scoped sessions', async () => {
  const ctx = setup({ merchantStatus: 1 });
  const res = response();
  await ctx.handler({
    params: { id: '9' },
    body: { status: 0 },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  for (const table of ['admin_sessions', 'cashier_sessions', 'waiter_sessions', 'scan_sessions']) {
    assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM ' + table)),
      table + ' must be revoked when merchant status changes');
  }
  const waiterRevoke = ctx.calls.find(call => call.type === 'run' && call.sql.includes('DELETE FROM waiter_sessions'));
  assert.match(waiterRevoke.sql, /INNER JOIN stores st ON st.id=w.store_id WHERE st.merchant_id=/);
  const scanRevoke = ctx.calls.find(call => call.type === 'run' && call.sql.includes('DELETE FROM scan_sessions'));
  assert.match(scanRevoke.sql, /WHERE store_id IN \(SELECT id FROM stores WHERE merchant_id=/);
});

test('merchant profile-only update does not revoke active sessions', async () => {
  const ctx = setup({ merchantStatus: 1 });
  const res = response();
  await ctx.handler({
    params: { id: '9' },
    body: { name: 'Updated Merchant', contact_name: 'Contact' },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM admin_sessions')), false);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM cashier_sessions')), false);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM waiter_sessions')), false);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('DELETE FROM scan_sessions')), false);
});
