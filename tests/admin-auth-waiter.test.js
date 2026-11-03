'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let activeWaiter = null;
let lastWaiterSql = '';
const helperPath = require.resolve('../server/db/helpers');
const authPath = require.resolve('../server/middleware/admin-auth');
require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: {
    getAsync: async sql => {
      if (sql.includes('FROM admin_sessions')) return null;
      if (sql.includes("admin_access_key")) return null;
      if (sql.includes('FROM waiter_sessions')) return { waiter_id: 4, expires_at: new Date(Date.now() + 3600000).toISOString() };
      if (sql.includes('FROM waiters w JOIN stores')) {
        lastWaiterSql = sql;
        return activeWaiter;
      }
      return null;
    },
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => []
  }
};
delete require.cache[authPath];
const { requireAdminOrWaiter } = require('../server/middleware/admin-auth');

function makeRequest() {
  return { get: name => name === 'Authorization' ? 'Bearer waiter-token' : '' };
}
function makeResponse() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

test('HTTP waiter middleware rejects a session when its store is inactive', async () => {
  activeWaiter = null;
  const req = makeRequest();
  const res = makeResponse();
  let nextCalled = false;
  await requireAdminOrWaiter(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(lastWaiterSql, /JOIN stores/);
  assert.match(lastWaiterSql, /s.active=1/);
  assert.match(lastWaiterSql, /m.status=1/);
});

test('HTTP waiter middleware binds store and merchant from the active waiter record', async () => {
  activeWaiter = { id: 4, store_id: 7, merchant_id: 9, active: 1 };
  const req = makeRequest();
  const res = makeResponse();
  let nextCalled = false;
  await requireAdminOrWaiter(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.storeId, 7);
  assert.equal(req.waiterStoreId, 7);
  assert.equal(req.merchantId, 9);
  assert.equal(req.isWaiter, true);
  assert.equal(req.isAdmin, false);
});
