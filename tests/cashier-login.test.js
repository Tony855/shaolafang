'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerCashierRoutes = require('../routes/cashier');
const { hashPassword, verifyPassword } = require('../server/middleware/password');
const { hashSessionToken } = require('../server/services/session-token');

function setup({ cashierRows = null, lockedCashierRows = null } = {}) {
  const handlers = new Map();
  const app = {
    post(path, ...callbacks) { handlers.set('POST ' + path, callbacks[callbacks.length - 1]); },
    get(path, ...callbacks) { handlers.set('GET ' + path, callbacks[callbacks.length - 1]); },
    put(path, ...callbacks) { handlers.set('PUT ' + path, callbacks[callbacks.length - 1]); }
  };
  const calls = [];
  const cashier = {
    id: 42, username: 'qa-cashier', display_name: 'QA Cashier',
    password_hash: hashPassword('qa-password-2026'), active: true,
    permissions: { can_settle: true }
  };
  const waiter = {
    id: 7, username: 'qa-waiter', display_name: 'QA Waiter',
    password_hash: hashPassword('qa-password-2026'), active: 1,
    merchant_id: 1, store_id: 1, can_order: 1, can_mark_item: 1, can_complete_order: 1
  };
  const deps = {
    getAsync: async (sql) => {
      if (sql.includes('waiter_session_timeout') || sql.includes('cashier_session_timeout')) return { value: '12' };
      if (sql.includes('FROM merchants')) return { id: 1 };
      if (sql.includes('SELECT s.id, s.merchant_id, s.name FROM stores')) return { id: 1, merchant_id: 1, name: 'QA Store' };
      if (sql.includes('SELECT value FROM settings') && sql.includes('FOR UPDATE')) return { value: JSON.stringify(lockedCashierRows || [cashier]) };
      if (sql.includes('SELECT name FROM stores')) return { name: 'QA Store' };
      return null;
    },
    allAsync: async (sql) => {
      if (sql.includes('FROM waiters w JOIN stores s')) return [waiter];
      if (sql.includes("LIKE 'cashiers_%'")) return cashierRows || [{ key: 'cashiers_1', value: JSON.stringify([cashier]) }];
      return [];
    },
    runAsync: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 1 }; },
    withTransaction: async (work) => work(),
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    cancelLoginAttempt() {},
    verifyPassword,
    getClientIp: () => '127.0.0.1',
    requireCashier: (_req, _res, next) => next(),
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    formatOrder: x => x,
    syncTableStatus: async () => {},
    buildBatchReceipt: () => '',
    buildReceipt: () => '',
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => {},
    io: { to: () => ({ emit() {} }) }
  };
  registerCashierRoutes(app, deps);
  return { handlers, calls };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('waiter login completes and creates a session using imported password migration helpers', async () => {
  const { handlers, calls } = setup();
  const res = response();
  await handlers.get('POST /api/waiter/login')({ body: { username: 'qa-waiter', password: 'qa-password-2026' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.waiter.id, 7);
  const sessionInsert = calls.find(call => call.sql.includes('INSERT INTO waiter_sessions'));
  assert.ok(sessionInsert);
  assert.equal(sessionInsert.params[1], hashSessionToken(res.body.token));
});

test('cashier login completes and creates a session using imported password migration helpers', async () => {
  const { handlers, calls } = setup();
  const res = response();
  await handlers.get('POST /api/cashier/login')({ body: { username: 'qa-cashier', password: 'qa-password-2026' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.cashier.id, 42);
  const sessionInsert = calls.find(call => call.sql.includes('INSERT INTO cashier_sessions'));
  assert.ok(sessionInsert);
  assert.equal(sessionInsert.params[3], hashSessionToken(res.body.token));
});

test('cashier login rejects ambiguous matching accounts when no store is selected', async () => {
  const second = {
    id: 43, username: 'qa-cashier', display_name: 'Other Store Cashier',
    password_hash: hashPassword('qa-password-2026'), active: true, permissions: {}
  };
  const { handlers, calls } = setup({
    cashierRows: [
      { key: 'cashiers_1', value: JSON.stringify([{
        id: 42, username: 'qa-cashier', display_name: 'QA Cashier',
        password_hash: hashPassword('qa-password-2026'), active: true, permissions: {}
      }]) },
      { key: 'cashiers_2', value: JSON.stringify([second]) }
    ]
  });
  const res = response();
  await handlers.get('POST /api/cashier/login')({
    body: { username: 'qa-cashier', password: 'qa-password-2026' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /多个门店/);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO cashier_sessions')), false);
});

test('cashier login rechecks the current password hash under the settings row lock', async () => {
  const updatedCashier = {
    id: 42, username: 'qa-cashier', display_name: 'QA Cashier',
    password_hash: hashPassword('new-password-after-reset'), active: true,
    permissions: { can_settle: true }
  };
  const { handlers, calls } = setup({ lockedCashierRows: [updatedCashier] });
  const res = response();
  await handlers.get('POST /api/cashier/login')({
    body: { username: 'qa-cashier', password: 'qa-password-2026' }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /账号或密码错误/);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO cashier_sessions')), false);
});


test('cashier login rejects non-canonical store identifiers before reading cashier settings', async () => {
  for (const storeId of ['1.0', '1e0', ' 1 ', '1abc', '0', '-1', '9007199254740992', true, [], {}]) {
    const { handlers, calls } = setup();
    const res = response();
    await handlers.get('POST /api/cashier/login')({
      body: { username: 'qa-cashier', password: 'qa-password-2026', storeId }
    }, res);
    assert.equal(res.statusCode, 400, String(storeId));
    assert.match(res.body.error, /门店编号无效/);
    assert.equal(calls.some(call => call.sql.includes("LIKE 'cashiers_%'")), false);
    assert.equal(calls.some(call => call.sql.includes('INSERT INTO cashier_sessions')), false);
  }
});

test('cashier login accepts canonical positive store identifiers', async () => {
  const { handlers, calls } = setup();
  const res = response();
  await handlers.get('POST /api/cashier/login')({
    body: { username: 'qa-cashier', password: 'qa-password-2026', storeId: '1' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.storeId, 1);
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO cashier_sessions')));
});
