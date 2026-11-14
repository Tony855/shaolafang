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

function setup({ failOn, merchantExists = true } = {}) {
  const calls = [];
  const writes = [];
  let transactionCount = 0;
  let rolledBack = false;
  let handler;
  const app = {
    post() {},
    get() {},
    put() {},
    delete(path, ...handlers) {
      if (path === '/api/super/merchants/:id') handler = handlers[handlers.length - 1];
    }
  };
  const deps = {
    getAsync: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM merchants')) return merchantExists ? { id: 9, name: 'Test Merchant', code: 'T009' } : null;
      return null;
    },
    allAsync: async () => [{ id: 91 }, { id: 92 }],
    runAsync: async (sql, params = []) => {
      calls.push(sql);
      writes.push({ sql, params });
      if (failOn && sql.includes(failOn)) throw new Error('simulated database failure');
      return { affectedRows: 1 };
    },
    withTransaction: async (fn) => {
      transactionCount++;
      try {
        return await fn();
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
    requireSuperAdmin: middleware,
    logAudit: async () => { calls.push('AUDIT'); },
    getClientIp: () => '127.0.0.1',
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    verifyPassword() { return true; },
    hashPassword(value) { return value; },
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({})
  };
  attachSuperRoutes(app, deps);
  return { handler, calls, writes, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('merchant deletion is one transaction and deletes child rows before parent rows', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ params: { id: '9' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, false);
  const waiterSessionDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM waiter_sessions'));
  const waiterDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM `waiters`'));
  const telegramOutboxOrderDelete = ctx.calls.findIndex(sql => sql.includes('DELETE n FROM telegram_notification_outbox'));
  const telegramOutboxTenantDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM telegram_notification_outbox WHERE'));
  const telegramChallengesDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM telegram_customer_binding_challenges'));
  const telegramBindingsDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM telegram_customer_bindings'));
  const telegramRecipientsDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM telegram_store_admin_recipients'));
  const refundDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM `refund_requests`'));
  const orderDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM `orders`'));
  const storesDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM stores'));
  const merchantDelete = ctx.calls.findIndex(sql => sql.includes('DELETE FROM merchants'));
  assert.ok(waiterSessionDelete >= 0 && waiterDelete > waiterSessionDelete,
    'waiter sessions must be revoked before waiter accounts are deleted');
  assert.ok(telegramOutboxOrderDelete >= 0 && telegramOutboxTenantDelete > telegramOutboxOrderDelete);
  assert.ok(telegramChallengesDelete > telegramOutboxTenantDelete);
  assert.ok(telegramBindingsDelete > telegramChallengesDelete);
  assert.ok(telegramRecipientsDelete > telegramBindingsDelete);
  assert.ok(refundDelete > telegramRecipientsDelete && orderDelete > refundDelete && storesDelete > orderDelete && merchantDelete > storesDelete);
  assert.deepEqual(ctx.writes.find(write => write.sql.includes('DELETE n FROM telegram_notification_outbox')).params, [9]);
  assert.deepEqual(ctx.writes.find(write => write.sql.includes('DELETE FROM telegram_notification_outbox WHERE')).params, [9, 9]);
  assert.deepEqual(ctx.writes.find(write => write.sql.includes('DELETE FROM telegram_customer_bindings')).params, [9, 9]);
  assert.ok(ctx.calls.indexOf('AUDIT') > merchantDelete);
});

test('merchant deletion reports missing merchant without deleting data', async () => {
  const ctx = setup({ merchantExists: false });
  const res = response();
  await ctx.handler({ params: { id: '9' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.calls.some(sql => typeof sql === 'string' && sql.startsWith('DELETE')), false);
});

test('merchant deletion rolls back when a child-table deletion fails', async () => {
  const ctx = setup({ failOn: 'DELETE FROM `orders`' });
  const res = response();
  await ctx.handler({ params: { id: '9' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '删除商户失败，所有更改已回滚' });
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(sql => typeof sql === 'string' && sql.includes('DELETE FROM merchants')), false);
});

test('default merchant cannot be deleted', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ params: { id: '1' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(ctx.transactionCount, 0);
  assert.equal(ctx.calls.length, 0);
});

test('merchant deletion rolls back when Telegram outbox cleanup fails', async () => {
  const ctx = setup({ failOn: 'DELETE n FROM telegram_notification_outbox' });
  const res = response();
  await ctx.handler({ params: { id: '9' }, superAdmin: { id: 1, username: 'root' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(sql => typeof sql === 'string' && sql.includes('DELETE FROM merchants')), false);
});
