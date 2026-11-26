'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerDeliveryRoutes = require('../routes/delivery');
const { hashSessionToken } = require('../server/services/session-token');

function setup(options = {}) {
  const routes = new Map();
  const calls = [];
  const sessions = new Map();
  const pass = (_req, _res, next) => next();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); },
    put(path, ...handlers) { routes.set('PUT ' + path, handlers); }
  };
  registerDeliveryRoutes(app, {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM delivery_riders WHERE store_id=?')) return options.rider === undefined
        ? { id: 12, merchant_id: 3, store_id: 7, username: 'rider_01', password_hash: 'stored-hash', display_name: 'Rider One', phone: '012345678' }
        : options.rider;
      if (sql.includes('FROM stores')) return options.store === undefined ? { id: 7 } : options.store;
      if (sql.includes('FROM delivery_rider_sessions')) return sessions.get(params[0]) || null;
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      if (sql.startsWith('INSERT INTO delivery_rider_sessions')) sessions.set(params[1], {
        id: 12, merchant_id: 3, store_id: 7, display_name: 'Rider One', phone: '012345678'
      });
      if (sql.startsWith('DELETE FROM delivery_rider_sessions')) sessions.delete(params[0]);
      return { affectedRows: 1, insertId: 1 };
    },
    withTransaction: async work => work(),
    requireAdminKey: pass,
    requirePermission: () => pass,
    hashPassword: value => 'hashed:' + value,
    verifyPassword: options.verifyPassword || ((value, stored) => value === 'correct-pass' && stored === 'stored-hash'),
    io: { to: () => ({ emit() {} }) },
    isLoginLocked: async () => options.locked ? { locked: true, remaining: 2 } : { locked: false, reservationId: 'attempt-1' },
    recordLoginAttempt: async (...args) => calls.push({ type: 'failed_login', args }),
    resetLoginAttempts: async (...args) => calls.push({ type: 'reset_login', args }),
    cancelLoginAttempt: async (...args) => calls.push({ type: 'cancel_login', args })
  });
  return { routes, calls, sessions };
}

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function req(body = {}, authorization = '') {
  return { body, params: { id: '99' }, get(name) { return name.toLowerCase() === 'authorization' ? authorization : ''; } };
}

test('rider login creates an opaque seven-day session and stores only its hash', async () => {
  const ctx = setup();
  const res = response();
  await ctx.routes.get('POST /api/delivery/login')[0](req({ storeId: 7, username: 'rider_01', password: 'correct-pass' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.rider.storeId, 7);
  assert.equal(res.body.token.length > 30, true);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const insert = ctx.calls.find(x => x.sql?.startsWith('INSERT INTO delivery_rider_sessions'));
  assert.equal(insert.params[1], hashSessionToken(res.body.token));
  assert.notEqual(insert.params[1], res.body.token);
});

test('invalid rider password is rate-limit recorded and does not create a session', async () => {
  const ctx = setup();
  const res = response();
  await ctx.routes.get('POST /api/delivery/login')[0](req({ storeId: 7, username: 'rider_01', password: 'wrong-pass' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.calls.some(x => x.sql?.startsWith('INSERT INTO delivery_rider_sessions')), false);
  assert.equal(ctx.calls.some(x => x.type === 'failed_login'), true);
});

test('locked rider login is rejected with Retry-After and does not query credentials', async () => {
  const ctx = setup({ locked: true });
  const res = response();
  await ctx.routes.get('POST /api/delivery/login')[0](req({ storeId: 7, username: 'rider_01', password: 'correct-pass' }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '120');
  assert.equal(ctx.calls.some(x => x.sql?.includes('FROM delivery_riders WHERE store_id=?')), false);
});

test('inactive store prevents session creation and cancels the reserved login attempt', async () => {
  const ctx = setup({ store: null });
  const res = response();
  await ctx.routes.get('POST /api/delivery/login')[0](req({ storeId: 7, username: 'rider_01', password: 'correct-pass' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(ctx.calls.some(x => x.sql?.startsWith('INSERT INTO delivery_rider_sessions')), false);
  assert.equal(ctx.calls.some(x => x.type === 'cancel_login'), true);
});

test('rider logout deletes only the presented session hash', async () => {
  const ctx = setup();
  const loginRes = response();
  await ctx.routes.get('POST /api/delivery/login')[0](req({ storeId: 7, username: 'rider_01', password: 'correct-pass' }), loginRes);
  const token = loginRes.body.token;
  const logoutHandlers = ctx.routes.get('POST /api/delivery/logout');
  const logoutRes = response();
  const authReq = req({}, 'Bearer ' + token);
  await logoutHandlers[0](authReq, logoutRes, async () => logoutHandlers[1](authReq, logoutRes));
  assert.equal(logoutRes.statusCode, 200);
  assert.deepEqual(logoutRes.body, { success: true });
  assert.equal(ctx.sessions.has(hashSessionToken(token)), false);
});
