'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerSuperRoutes = require('../routes/super');

test('disabled super-admin accounts cannot obtain a new login session', async () => {
  const registered = new Map();
  const app = new Proxy({}, {
    get(_target, method) {
      return (path, ...handlers) => {
        if (typeof path === 'string') registered.set(method + ' ' + path, handlers);
      };
    }
  });
  const queries = [];
  const deps = {
    getAsync: async (sql) => {
      queries.push(sql);
      return null; // No active super-admin account matches.
    },
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => [],
    isLoginLocked: async () => ({ locked: false, reservationId: null }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {},
    verifyPassword: () => false,
    hashPassword: value => value,
    getClientIp: () => '127.0.0.1',
    getLocationByIp: async () => '',
    requireSuperAdmin: (_req, _res, next) => next(),
    logAudit: async () => {},
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({}),
    withTransaction: async callback => callback()
  };

  registerSuperRoutes(app, deps);
  const handlers = registered.get('post /api/super/login');
  assert.ok(handlers, 'super-admin login route must be registered');
  const handler = handlers[handlers.length - 1];

  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({
    body: { username: 'disabled-admin', password: 'correct-password' },
    get: () => '',
  }, res);

  assert.ok(queries.some(sql => /FROM super_admins WHERE username=\? AND active=1/.test(sql)));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: '用户名或密码错误' });
});

