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

function setup({ failOn, validPassword = true, failSequenceReset = false } = {}) {
  const calls = [];
  let handler;
  let transactionCount = 0;
  let inTransaction = false;
  let rolledBack = false;
  const app = {
    post(path, ...handlers) {
      if (path === '/api/super/reset-data') handler = handlers[handlers.length - 1];
    },
    get() {},
    put() {},
    delete() {}
  };
  const deps = {
    getAsync: async () => null,
    allAsync: async (sql, params = []) => { calls.push({ sql, params, inTransaction, type: 'all' }); return []; },
    runAsync: async (sql, params = []) => {
      calls.push({ sql, params, inTransaction });
      if (failOn && sql.includes(failOn)) throw new Error('simulated delete failure');
      if (failSequenceReset && sql.startsWith('ALTER TABLE')) throw new Error('simulated DDL failure');
      return { affectedRows: 1 };
    },
    withTransaction: async fn => {
      transactionCount++;
      inTransaction = true;
      try {
        return await fn();
      } catch (error) {
        rolledBack = true;
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    requireSuperAdmin: middleware,
    logAudit: async (...args) => { calls.push({ audit: args, inTransaction }); },
    getClientIp: () => '127.0.0.1',
    verifyPassword: () => validPassword,
    hashPassword: value => value,
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({})
  };
  attachSuperRoutes(app, deps);
  return { handler, calls, get transactionCount() { return transactionCount; }, get rolledBack() { return rolledBack; } };
}

test('super data reset groups all deletes and audit in one transaction, then resets sequences', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ body: { password: 'correct' }, superAdmin: { id: 1, username: 'root', password_hash: 'hash' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.sequenceReset, true);
  assert.equal(ctx.transactionCount, 1);
  const dml = ctx.calls.filter(call => call.sql && call.sql.startsWith('DELETE'));
  assert.deepEqual(dml.map(call => call.sql), [
    'DELETE FROM telegram_customer_binding_challenges',
    'DELETE FROM telegram_customer_bindings',
    'DELETE FROM telegram_notification_outbox',
    'DELETE FROM refund_requests',
    'DELETE FROM orders',
    'DELETE FROM waiter_calls',
    'DELETE FROM scan_sessions'
  ]);
  assert.ok(dml.every(call => call.inTransaction));
  const locks = ctx.calls.filter(call => call.type === 'all');
  assert.deepEqual(locks.map(call => call.sql), [
    'SELECT `key` FROM settings WHERE `key` IN (?, ?) FOR UPDATE',
    'SELECT id FROM merchants ORDER BY id FOR UPDATE',
    'SELECT id FROM stores ORDER BY id FOR UPDATE',
    'SELECT id FROM telegram_customer_binding_challenges ORDER BY id FOR UPDATE',
    'SELECT id FROM telegram_customer_bindings ORDER BY id FOR UPDATE'
  ]);
  assert.ok(locks.every(call => call.inTransaction));
  const audit = ctx.calls.find(call => call.audit);
  assert.equal(audit.inTransaction, true);
  const ddl = ctx.calls.filter(call => call.sql && call.sql.startsWith('ALTER TABLE'));
  assert.equal(ddl.length, 2);
  assert.ok(ddl.every(call => !call.inTransaction));
});

test('super data reset rolls back all deletes if a delete fails and skips DDL', async () => {
  const ctx = setup({ failOn: 'DELETE FROM waiter_calls' });
  const res = response();
  await ctx.handler({ body: { password: 'correct' }, superAdmin: { id: 1, username: 'root', password_hash: 'hash' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(call => call.sql && call.sql.startsWith('ALTER TABLE')), false);
  assert.equal(ctx.calls.some(call => call.audit), false);
});

test('sequence reset failure does not misreport committed data deletion as failed', async () => {
  const ctx = setup({ failSequenceReset: true });
  const res = response();
  await ctx.handler({ body: { password: 'correct' }, superAdmin: { id: 1, username: 'root', password_hash: 'hash' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.sequenceReset, false);
  assert.match(res.body.message, /自增序号未能重置/);
});

test('super data reset rejects an incorrect password before starting a transaction', async () => {
  const ctx = setup({ validPassword: false });
  const res = response();
  await ctx.handler({ body: { password: 'wrong' }, superAdmin: { id: 1, username: 'root', password_hash: 'hash' } }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(ctx.transactionCount, 0);
  assert.equal(ctx.calls.length, 0);
});

test('super data reset rolls back if Telegram notification cleanup fails', async () => {
  const ctx = setup({ failOn: 'DELETE FROM telegram_notification_outbox' });
  const res = response();
  await ctx.handler({ body: { password: 'correct' }, superAdmin: { id: 1, username: 'root', password_hash: 'hash' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.some(call => call.sql === 'DELETE FROM orders'), false);
  assert.equal(ctx.calls.some(call => call.audit), false);
});
