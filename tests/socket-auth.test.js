'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSocketAuthenticator, positiveSafeInteger, scheduleSocketRevalidation } = require('../server/middleware/socket-auth');

function makeSocket(token, storeId) {
  return { handshake: { auth: { token }, query: { ...(storeId === undefined ? {} : { storeId }) } }, data: {} };
}

async function authenticate(getAsync, socket) {
  const middleware = createSocketAuthenticator({ getAsync, logger: { error() {} } });
  let error = null;
  await middleware(socket, value => { error = value || null; });
  return error;
}

test('public socket sessions require an active store and a still-existing table', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const calls = [];
  const getAsync = async (sql, params) => {
    calls.push(sql);
    if (sql.includes('FROM scan_sessions')) return { table_name: 'A01', store_id: 7, expires_at: expires };
    if (sql.includes('FROM stores')) return { id: 7 };
    if (sql.includes('FROM tables')) return { id: 3 };
    return null;
  };
  const socket = makeSocket('scan-token');
  assert.equal(await authenticate(getAsync, socket), null);
  assert.deepEqual({ role: socket.data.role, storeId: socket.data.storeId, tableName: socket.data.tableName },
    { role: 'public', storeId: 7, tableName: 'A01' });
  assert.ok(calls.some(sql => sql.includes('s.active=1') && sql.includes('m.status=1')));
});

test('public socket rejects deactivated stores and stale table sessions', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const inactiveStore = await authenticate(async sql => {
    if (sql.includes('FROM scan_sessions')) return { table_name: 'A01', store_id: 7, expires_at: expires };
    return null;
  }, makeSocket('scan-token'));
  assert.match(inactiveStore.message, /store inactive/);

  const staleTable = await authenticate(async sql => {
    if (sql.includes('FROM scan_sessions')) return { table_name: 'A01', store_id: 7, expires_at: expires };
    if (sql.includes('FROM stores')) return { id: 7 };
    return null;
  }, makeSocket('scan-token'));
  assert.match(staleTable.message, /session is stale/);
});

test('admin socket never falls back to global store 1 when merchant has no active store', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const error = await authenticate(async sql => {
    if (sql.includes('FROM scan_sessions')) return null;
    if (sql.includes('FROM waiter_sessions')) return null;
    if (sql.includes('FROM cashier_sessions')) return null;
    if (sql.includes('FROM admin_sessions')) return { admin_id: 5, expires_at: expires };
    if (sql.includes('FROM merchant_admins')) return { id: 5, merchant_id: 88 };
    if (sql.includes('FROM merchants')) return { id: 88 };
    if (sql.includes('FROM stores')) return null;
    return null;
  }, makeSocket('admin-token'));
  assert.match(error.message, /no active store/);
});

test('admin socket rejects malformed or foreign store selection', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const getAsync = async sql => {
    if (sql.includes('FROM scan_sessions') || sql.includes('FROM waiter_sessions') || sql.includes('FROM cashier_sessions')) return null;
    if (sql.includes('FROM admin_sessions')) return { admin_id: 5, expires_at: expires };
    if (sql.includes('FROM merchant_admins')) return { id: 5, merchant_id: 88 };
    if (sql.includes('FROM merchants')) return { id: 88 };
    if (sql.includes('FROM stores')) return null;
    return null;
  };
  const malformed = await authenticate(getAsync, makeSocket('admin-token', '1abc'));
  assert.match(malformed.message, /invalid store id/);
  const foreign = await authenticate(getAsync, makeSocket('admin-token', '1'));
  assert.match(foreign.message, /not owned/);
});

test('waiter and cashier sockets require active store membership', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  const waiterError = await authenticate(async sql => {
    if (sql.includes('FROM scan_sessions')) return null;
    if (sql.includes('FROM waiter_sessions')) return { waiter_id: 2, expires_at: expires };
    if (sql.includes('FROM waiters')) return null;
    return null;
  }, makeSocket('waiter-token'));
  assert.match(waiterError.message, /token invalid or expired/);

  const cashierError = await authenticate(async sql => {
    if (sql.includes('FROM scan_sessions') || sql.includes('FROM waiter_sessions')) return null;
    if (sql.includes('FROM cashier_sessions')) return { cashier_id: 3, store_id: 7, merchant_id: 9, expires_at: expires };
    if (sql.includes('FROM stores')) return null;
    return null;
  }, makeSocket('cashier-token'));
  assert.match(cashierError.message, /token invalid or expired/);
});

test('positiveSafeInteger rejects partial, zero and unsafe store identifiers', () => {
  assert.equal(positiveSafeInteger('12'), 12);
  assert.equal(positiveSafeInteger('12abc'), null);
  assert.equal(positiveSafeInteger('0'), null);
  assert.equal(positiveSafeInteger(Number.MAX_SAFE_INTEGER + 1), null);
});

test('socket auth refuses credentials supplied only in URL query strings', async () => {
  const middleware = createSocketAuthenticator({ getAsync: async () => null, logger: { error() {} } });
  const socket = { handshake: { query: { token: 'query-token' }, auth: {} }, data: {} };
  let error = null;
  await middleware(socket, value => { error = value || null; });
  assert.match(error.message, /session token required/);
});

test('cashier socket rejects string and numeric inactive flags consistently with HTTP auth', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  for (const active of [false, 0, '0', 'false', null]) {
    const error = await authenticate(async sql => {
      if (sql.includes('FROM scan_sessions') || sql.includes('FROM waiter_sessions')) return null;
      if (sql.includes('FROM cashier_sessions')) return { cashier_id: 3, store_id: 7, merchant_id: 9, expires_at: expires };
      if (sql.includes('FROM stores')) return { id: 7 };
      if (sql.includes('FROM settings')) return { value: JSON.stringify([{ id: 3, active }]) };
      return null;
    }, makeSocket('cashier-token'));
    assert.match(error.message, /token invalid or expired/, String(active));
  }
});

test('cashier socket accepts only the explicit active flag values used by HTTP auth', async () => {
  const expires = new Date(Date.now() + 60000).toISOString();
  for (const active of [true, 1, '1', 'true']) {
    const socket = makeSocket('cashier-token');
    const error = await authenticate(async sql => {
      if (sql.includes('FROM scan_sessions') || sql.includes('FROM waiter_sessions')) return null;
      if (sql.includes('FROM cashier_sessions')) return { cashier_id: 3, store_id: 7, merchant_id: 9, expires_at: expires };
      if (sql.includes('FROM stores')) return { id: 7 };
      if (sql.includes('FROM settings')) return { value: JSON.stringify([{ id: 3, active }]) };
      return null;
    }, socket);
    assert.equal(error, null);
    assert.equal(socket.data.role, 'cashier');
    assert.equal(socket.data.storeId, 7);
  }
});

test('live socket sessions are revalidated and disconnected after revocation', () => {
  const scheduled = [];
  let disconnected = false;
  const listeners = {};
  const socket = {
    data: { role: 'cashier', storeId: 7, merchantId: 9, cashierId: 3, expiresAt: 'later' },
    once(event, callback) { listeners[event] = callback; },
    disconnect(force) { assert.equal(force, true); disconnected = true; listeners.disconnect?.(); }
  };
  let authenticationCalls = 0;
  const authenticateSocket = (_socket, next) => {
    authenticationCalls += 1;
    next(new Error('unauthorized: token invalid or expired'));
  };
  scheduleSocketRevalidation(socket, authenticateSocket, {
    intervalMs: 1000,
    setTimeoutFn(callback, delay) { const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer; },
    clearTimeoutFn(timer) { timer.cancelled = true; }
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  scheduled[0].callback();
  assert.equal(authenticationCalls, 1);
  assert.equal(disconnected, true);
  assert.equal(scheduled.length, 1, 'revoked socket must not schedule another check');
});

test('live socket revalidation keeps the connection only when identity remains unchanged', () => {
  const scheduled = [];
  let disconnected = false;
  const listeners = {};
  const socket = {
    data: { role: 'waiter', storeId: 7, waiterId: 4, expiresAt: 'old' },
    once(event, callback) { listeners[event] = callback; },
    disconnect() { disconnected = true; listeners.disconnect?.(); }
  };
  scheduleSocketRevalidation(socket, (current, next) => {
    current.data.expiresAt = 'refreshed';
    next(null);
  }, {
    intervalMs: 1000,
    setTimeoutFn(callback) { const timer = { callback, unref() {} }; scheduled.push(timer); return timer; },
    clearTimeoutFn(timer) { timer.cancelled = true; }
  });
  scheduled[0].callback();
  assert.equal(disconnected, false);
  assert.equal(socket.data.expiresAt, 'refreshed');
  assert.equal(scheduled.length, 2, 'valid session should schedule the next revalidation');
  listeners.disconnect();
  assert.equal(scheduled[1].cancelled, true);
});

test('live socket revalidation disconnects if the authenticated identity changes', () => {
  const scheduled = [];
  let disconnected = false;
  const socket = {
    data: { role: 'admin', storeId: 7, merchantId: 9, adminId: 2 },
    once() {},
    disconnect() { disconnected = true; }
  };
  scheduleSocketRevalidation(socket, (current, next) => {
    current.data.storeId = 8;
    next(null);
  }, {
    intervalMs: 1000,
    setTimeoutFn(callback) { const timer = { callback, unref() {} }; scheduled.push(timer); return timer; },
    clearTimeoutFn() {}
  });
  scheduled[0].callback();
  assert.equal(disconnected, true);
  assert.equal(scheduled.length, 1);
});

test('socket authentication logs safe metadata without exposing database driver messages', async () => {
  const logs = [];
  const middleware = createSocketAuthenticator({
    getAsync: async () => { throw new Error('sensitive database connection details'); },
    logger: { error: (...args) => logs.push(args) }
  });
  let nextError = null;
  await middleware(makeSocket('socket-token'), error => { nextError = error || null; });
  assert.equal(nextError.message, 'auth failed');
  assert.equal(JSON.stringify(logs).includes('sensitive database connection details'), false);
  assert.deepEqual(logs[0][1], { name: 'Error' });
});
