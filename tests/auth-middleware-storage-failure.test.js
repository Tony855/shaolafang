'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
const waiterAuthPath = require.resolve('../server/services/waiter-auth');
const adminAuthPath = require.resolve('../server/middleware/admin-auth');
const authPath = require.resolve('../server/middleware/auth');
const originals = new Map(
  [helperPath, waiterAuthPath, adminAuthPath, authPath].map(path => [path, require.cache[path]])
);

let failWhen = null;
require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: {
    getAsync: async sql => {
      if (failWhen && failWhen(sql)) throw new Error('sensitive database connection details');
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
delete require.cache[adminAuthPath];
delete require.cache[authPath];

const adminAuth = require('../server/middleware/admin-auth');
const auth = require('../server/middleware/auth');

function request(headers = {}) {
  return {
    headers,
    get(name) {
      const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
      return key ? headers[key] : undefined;
    }
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

async function invoke(middleware, req) {
  const res = response();
  let nextCalled = false;
  let thrown = null;
  try {
    await middleware(req, res, () => { nextCalled = true; });
  } catch (error) {
    thrown = error;
  }
  return { res, nextCalled, thrown };
}

function assertUnavailable(result) {
  assert.equal(result.thrown, null, 'middleware must not leak a rejected promise to Express 4');
  assert.equal(result.nextCalled, false, 'middleware must fail closed');
  assert.equal(result.res.statusCode, 503);
  assert.deepEqual(result.res.body, { error: '认证服务暂时不可用，请稍后重试' });
}

test('requireAdminKey returns a generic 503 when authentication storage fails', async () => {
  failWhen = sql => sql.includes('admin_access_key');
  const result = await invoke(adminAuth.requireAdminKey, request());
  assertUnavailable(result);
  failWhen = null;
});

test('requireAdminOrWaiter returns 503 instead of rejecting when waiter session storage fails', async () => {
  failWhen = sql => sql.includes('FROM waiter_sessions');
  const result = await invoke(adminAuth.requireAdminOrWaiter, request({ 'X-Waiter-Token': 'waiter-token' }));
  assertUnavailable(result);
  failWhen = null;
});

test('requireAdminOrCashier responds instead of silently returning when cashier session storage fails', async () => {
  failWhen = sql => sql.includes('FROM cashier_sessions');
  const result = await invoke(auth.requireAdminOrCashier, request({ 'X-Cashier-Token': 'cashier-token' }));
  assertUnavailable(result);
  failWhen = null;
});

test('requireAdminOrCashierOrWaiter catches admin authentication storage failures', async () => {
  failWhen = sql => sql.includes('admin_access_key');
  const result = await invoke(auth.requireAdminOrCashierOrWaiter, request());
  assertUnavailable(result);
  failWhen = null;
});

test('requireAdminOrCashierOrWaiter does not downgrade cashier database failures to anonymous 401', async () => {
  failWhen = sql => sql.includes('FROM cashier_sessions');
  const result = await invoke(auth.requireAdminOrCashierOrWaiter, request({ 'X-Cashier-Token': 'cashier-token' }));
  assertUnavailable(result);
  failWhen = null;
});

test.after(() => {
  for (const [path, original] of originals) {
    if (original) require.cache[path] = original;
    else delete require.cache[path];
  }
});
