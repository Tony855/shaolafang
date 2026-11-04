'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
const authPath = require.resolve('../server/middleware/auth');
const originalHelper = require.cache[helperPath];
const originalAuth = require.cache[authPath];

let cashierRecord = null;
require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: {
    getAsync: async sql => {
      if (sql.includes('FROM cashier_sessions')) return {
        cashier_id: 42, store_id: 2, merchant_id: 5,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      };
      if (sql.includes('FROM stores')) return { id: 2 };
      if (sql.includes('FROM settings')) return { value: JSON.stringify([cashierRecord]) };
      return null;
    },
    runAsync: async () => ({ affectedRows: 1 })
  }
};
delete require.cache[authPath];
const { requireCashier } = require('../server/middleware/auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function request() {
  return { get: name => name === 'X-Cashier-Token' ? 'session-token' : undefined, headers: {} };
}

test('cashier middleware rejects legacy string false activation values', async () => {
  cashierRecord = { id: 42, username: 'cashier', active: 'false', permissions: { can_refund: true } };
  const req = request();
  const res = response();
  let nextCalled = false;
  await requireCashier(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('cashier middleware normalizes string permission flags before exposing the account', async () => {
  cashierRecord = {
    id: 42, username: 'cashier', active: true,
    permissions: { can_settle: 'false', can_cancel: 'false', can_refund: 'false', can_view_report: 'false' }
  };
  const req = request();
  const res = response();
  let nextCalled = false;
  await requireCashier(req, res, () => { nextCalled = true; });

  assert.equal(res.statusCode, 200);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.cashier.permissions, {
    can_settle: false, can_cancel: false, can_refund: false, can_view_report: false
  });
});

test.after(() => {
  if (originalHelper) require.cache[helperPath] = originalHelper;
  else delete require.cache[helperPath];
  if (originalAuth) require.cache[authPath] = originalAuth;
  else delete require.cache[authPath];
});
