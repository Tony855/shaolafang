'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
const waiterAuthPath = require.resolve('../server/services/waiter-auth');
const authPath = require.resolve('../server/middleware/admin-auth');
const originalHelper = require.cache[helperPath];
const originalWaiterAuth = require.cache[waiterAuthPath];
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
      if (sql.includes('FROM settings')) return { value: JSON.stringify(cashierRecord) };
      return null;
    },
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => []
  }
};
require.cache[waiterAuthPath] = {
  id: waiterAuthPath,
  filename: waiterAuthPath,
  loaded: true,
  exports: { getActiveWaiter: async () => null }
};
delete require.cache[authPath];
const { getCashierFromRequest } = require('../server/middleware/admin-auth');

function request() {
  return { get: name => name === 'X-Cashier-Token' ? 'session-token' : undefined };
}

test('getCashierFromRequest rejects legacy string false activation values', async () => {
  cashierRecord = [{ id: 42, username: 'cashier', active: 'false', permissions: { can_refund: true } }];
  assert.equal(await getCashierFromRequest(request()), null);
});

test('getCashierFromRequest rejects malformed non-array cashier settings', async () => {
  cashierRecord = { id: 42, active: true };
  assert.equal(await getCashierFromRequest(request()), null);
});

test('getCashierFromRequest normalizes legacy string permission flags', async () => {
  cashierRecord = [{
    id: 42, username: 'cashier', active: true,
    permissions: { can_settle: 'false', can_cancel: 'false', can_refund: 'false', can_view_report: 'false' }
  }];
  const cashier = await getCashierFromRequest(request());
  assert.ok(cashier);
  assert.deepEqual(cashier.permissions, {
    can_settle: false, can_cancel: false, can_refund: false, can_view_report: false
  });
});

test.after(() => {
  if (originalHelper) require.cache[helperPath] = originalHelper;
  else delete require.cache[helperPath];
  if (originalWaiterAuth) require.cache[waiterAuthPath] = originalWaiterAuth;
  else delete require.cache[waiterAuthPath];
  if (originalAuth) require.cache[authPath] = originalAuth;
  else delete require.cache[authPath];
});
