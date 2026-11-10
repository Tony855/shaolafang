'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');
const { hashSessionToken } = require('../server/services/session-token');

function middleware(_req, _res, next) {
  if (next) next();
}

function createApp() {
  const routes = { get: [], post: [], put: [], delete: [] };
  return {
    routes,
    get(path, ...handlers) { routes.get.push({ path, handlers }); },
    post(path, ...handlers) { routes.post.push({ path, handlers }); },
    put(path, ...handlers) { routes.put.push({ path, handlers }); },
    delete(path, ...handlers) { routes.delete.push({ path, handlers }); }
  };
}

test('super-admin password change preserves current session using its digest and revokes others', async () => {
  const app = createApp();
  const calls = [];
  const deps = {
    getAsync: async () => null,
    runAsync: async (sql, params = []) => { calls.push({ sql, params }); return { affectedRows: 1 }; },
    allAsync: async () => [],
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {},
    verifyPassword: () => true,
    hashPassword: () => 'new-password-hash',
    getClientIp: () => '127.0.0.1',
    getLocationByIp: async () => '',
    requireSuperAdmin: middleware,
    logAudit: async () => {},
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => {},
    withTransaction: async callback => callback()
  };
  attachSuperRoutes(app, deps);

  const route = app.routes.post.find(item => item.path === '/api/super/change-password');
  assert.ok(route);
  const handler = route.handlers[route.handlers.length - 1];
  const req = {
    body: { oldPassword: 'old-password', newPassword: 'new-password-long-enough' },
    superAdmin: { id: 9, username: 'root', password_hash: 'old-hash' },
    superSessionToken: 'current-super-session-token'
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };

  await handler(req, res);

  const revoke = calls.find(call => call.sql.includes('DELETE FROM super_sessions'));
  assert.ok(revoke);
  assert.match(revoke.sql, /super_admin_id=\? AND token_hash<>\?/);
  assert.deepEqual(revoke.params, [9, hashSessionToken(req.superSessionToken)]);
  assert.equal(revoke.params.includes(req.superSessionToken), false);
  assert.deepEqual(res.body, { success: true });
});
