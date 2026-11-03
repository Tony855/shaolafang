'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSocketAuthenticator, positiveSafeInteger } = require('../server/middleware/socket-auth');

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
