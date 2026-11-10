'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const attachSuperRoutes = require('../routes/super');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('merchant deletion removes only exact merchant and store settings prefixes', async () => {
  const routes = new Map();
  const writes = [];
  const app = {
    get() {},
    post() {},
    put() {},
    delete(path, ...handlers) {
      if (path === '/api/super/merchants/:id') routes.set(path, handlers.at(-1));
    }
  };

  attachSuperRoutes(app, {
    getAsync: async sql => sql.includes('FROM merchants WHERE id=? FOR UPDATE')
      ? { id: 2, name: 'Merchant 2', code: 'm2' }
      : null,
    allAsync: async sql => sql.includes('SELECT id FROM stores WHERE merchant_id=?')
      ? [{ id: 2 }, { id: 20 }]
      : [],
    runAsync: async (sql, params = []) => {
      writes.push({ sql, params });
      return { affectedRows: 1 };
    },
    withTransaction: async work => work(),
    requireSuperAdmin: (_req, _res, next) => next(),
    getClientIp: () => '127.0.0.1',
    logAudit: async () => {},
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {},
    verifyPassword: () => true,
    hashPassword: value => value,
    getLocationByIp: async () => null,
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => {}
  });

  const res = response();
  await routes.get('/api/super/merchants/:id')({
    params: { id: '2' },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });

  const settingDeletes = writes.filter(write => write.sql.startsWith('DELETE FROM settings'));
  const exactPrefixes = settingDeletes
    .filter(write => write.sql.includes('LEFT('))
    .map(write => write.params[0]);
  assert.deepEqual(exactPrefixes, ['store_2_', 'store_20_', 'merchant_2_']);
  assert.ok(settingDeletes.every(write => !/LIKE/i.test(write.sql)));
  assert.ok(settingDeletes.some(write => write.params[0] === 'cashiers_2'));
  assert.ok(settingDeletes.some(write => write.params[0] === 'cashiers_20'));
});
