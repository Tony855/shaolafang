'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
const authPath = require.resolve('../server/middleware/auth');
const originalHelper = require.cache[helperPath];
const originalAuth = require.cache[authPath];

let settingsValue = null;
let failDatabase = false;
require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: {
    getAsync: async sql => {
      if (failDatabase) throw new Error('sensitive database connection details');
      if (sql.includes('FROM cashier_sessions')) return {
        cashier_id: 42, store_id: 2, merchant_id: 5,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      };
      if (sql.includes('FROM stores')) return { id: 2 };
      if (sql.includes('FROM settings')) return { value: settingsValue };
      return null;
    },
    runAsync: async () => ({ affectedRows: 1 })
  }
};
delete require.cache[authPath];
const { requireCashier } = require('../server/middleware/auth');

function request() {
  return { get: name => name === 'X-Cashier-Token' ? 'session-token' : undefined, headers: {} };
}
function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}
async function invoke() {
  const req = request();
  const res = response();
  let nextCalled = false;
  await requireCashier(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('rejects cashier whose active flag is the string false', async () => {
  settingsValue = JSON.stringify([{ id: 42, active: 'false', permissions: { can_refund: true } }]);
  const { res, nextCalled } = await invoke();
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('rejects malformed non-array cashier settings', async () => {
  settingsValue = JSON.stringify({ id: 42, active: true });
  const { res, nextCalled } = await invoke();
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('normalizes permission strings before exposing cashier identity', async () => {
  settingsValue = JSON.stringify([{
    id: 42, active: true,
    permissions: {
      can_settle: 'false', can_cancel: '0',
      can_refund: 'true', can_view_report: 1
    }
  }]);
  const { req, res, nextCalled } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.cashier.permissions, {
    can_settle: false, can_cancel: false, can_refund: true, can_view_report: true
  });
});

test('does not expose database error details to clients', async () => {
  failDatabase = true;
  const { res } = await invoke();
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: '认证服务暂时不可用' });
  failDatabase = false;
});

test.after(() => {
  if (originalHelper) require.cache[helperPath] = originalHelper;
  else delete require.cache[helperPath];
  if (originalAuth) require.cache[authPath] = originalAuth;
  else delete require.cache[authPath];
});
