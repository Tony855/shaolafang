const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');

function middleware() {
  return (_req, _res, next) => next();
}

function setup({ failOn } = {}) {
  const calls = [];
  let handler;
  let transactionCount = 0;
  let rolledBack = false;
  const app = {
    post() {},
    get() {},
    delete() {},
    put(path, ...handlers) {
      if (path === '/api/super/settings') handler = handlers[handlers.length - 1];
    }
  };
  const deps = {
    getAsync: async () => null,
    allAsync: async () => [],
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      if (failOn && sql.includes(failOn)) throw new Error('simulated settings write failure');
      return { affectedRows: 1 };
    },
    withTransaction: async fn => {
      transactionCount++;
      try { return await fn(); }
      catch (error) { rolledBack = true; throw error; }
    },
    requireSuperAdmin: middleware,
    logAudit: async () => { calls.push({ type: 'audit' }); },
    getClientIp: () => '127.0.0.1',
    hashPassword: value => value,
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

test('super settings writes and audit record share one transaction', async () => {
  const ctx = setup();
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
  await ctx.handler({
    body: { super_idle_timeout: 90, admin_idle_timeout: 45, login_max_attempts: 8 },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, false);
  assert.equal(ctx.calls.filter(call => call.type === 'run').length, 3);
  assert.ok(ctx.calls.filter(call => call.type === 'run').every(call => call.sql.includes('INSERT INTO settings')));
  assert.equal(ctx.calls.filter(call => call.type === 'audit').length, 1);
});

test('super settings rolls back all writes and audit if a later setting fails', async () => {
  const ctx = setup({ failOn: 'login_max_attempts' });
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
  await ctx.handler({
    body: { super_idle_timeout: 90, admin_idle_timeout: 45, login_max_attempts: 8 },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(ctx.transactionCount, 1);
  assert.equal(ctx.rolledBack, true);
  assert.equal(ctx.calls.filter(call => call.type === 'audit').length, 0);
});
