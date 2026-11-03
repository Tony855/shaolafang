'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function routeHarness() {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); },
    put(path, ...handlers) { routes.set('PUT ' + path, handlers); },
    delete(path, ...handlers) { routes.set('DELETE ' + path, handlers); }
  };
  return { app, routes };
}

const pass = (req, res, next) => next && next();

test('table listing is authenticated, store-scoped and never selects QR credentials', async () => {
  const { app, routes } = routeHarness();
  let query;
  const auth = () => {};
  require('../routes/tables')(app, {
    requireAdminOrWaiter: auth,
    requireAdminKey: pass,
    requirePermission: () => pass,
    allAsync: async (sql, params) => { query = { sql, params }; return [{ id: 1, name: 'A1', status: 'available' }]; },
    getAsync: async () => null,
    runAsync: async () => ({ affectedRows: 0, lastID: 1 }),
    withTransaction: async fn => fn(),
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) },
    createTableToken: () => 'unused'
  });

  const handlers = routes.get('GET /api/tables');
  assert.equal(handlers[0], auth);
  const res = response();
  await handlers.at(-1)({ isAdmin: false, waiterStoreId: 4, query: { store_id: '99' } }, res);
  assert.deepEqual(query.params, [4]);
  assert.match(query.sql, /SELECT id, name, status, store_id/);
  assert.doesNotMatch(query.sql, /SELECT \*/i);
  assert.doesNotMatch(query.sql, /qr_token/i);
  assert.equal(res.statusCode, 200);
});

test('table move runs under one transaction and uses a cryptographically random session token', async () => {
  const { app, routes } = routeHarness();
  const writes = [];
  let transactionCalls = 0;
  const emitted = [];
  require('../routes/tables')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    allAsync: async sql => {
      if (sql.includes('FROM tables') && sql.includes('FOR UPDATE')) {
        return [{ id: 1, name: 'A1', status: 'occupied' }, { id: 2, name: 'A2', status: 'available' }];
      }
      return [];
    },
    getAsync: async () => null,
    runAsync: async (sql, params) => {
      writes.push({ sql, params });
      return { affectedRows: sql.includes('UPDATE orders') ? 2 : 1, lastID: 1 };
    },
    withTransaction: async fn => { transactionCalls++; return fn(); },
    syncTableStatus: async () => {},
    io: { to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) },
    createTableToken: () => 'unused'
  });

  const handlers = routes.get('POST /api/tables/move');
  const res = response();
  await handlers.at(-1)({ isAdmin: true, isPrimaryAdmin: true, storeId: 7, body: { from_table: 'A1', target_table: 'A2' } }, res);
  assert.equal(transactionCalls, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
  const sessionInsert = writes.find(x => x.sql.includes('INSERT INTO scan_sessions'));
  assert.ok(sessionInsert);
  assert.match(sessionInsert.params[1], /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(emitted.length, 3);
});

test('waiter call requires a valid, matching and unexpired QR session', async t => {
  const { app, routes } = routeHarness();
  let transactionCalls = 0;
  let session = null;
  require('../routes/calls')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async sql => {
      if (sql.includes('FROM scan_sessions')) return session;
      return null;
    },
    allAsync: async () => [],
    runAsync: async () => ({ affectedRows: 1 }),
    withTransaction: async fn => { transactionCalls++; return fn(); }
  });
  const handler = routes.get('POST /api/public/call-waiter').at(-1);

  const missing = response();
  await handler({ body: { table: 'A1' } }, missing);
  assert.equal(missing.statusCode, 401);

  session = { table_name: 'A2', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
  const mismatch = response();
  await handler({ body: { table: 'A1', sessionToken: 'token' } }, mismatch);
  assert.equal(mismatch.statusCode, 403);

  session = { table_name: 'A1', store_id: 7, expires_at: 'not-a-date' };
  const invalidExpiry = response();
  await handler({ body: { table: 'A1', sessionToken: 'token' } }, invalidExpiry);
  assert.equal(invalidExpiry.statusCode, 410);
  assert.equal(transactionCalls, 0);
});

test('waiter-call throttling and insert are serialized in a transaction', async () => {
  const { app, routes } = routeHarness();
  const calls = [];
  let transactionCalls = 0;
  require('../routes/calls')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async (sql) => {
      if (sql.includes('FROM scan_sessions') && sql.includes('FOR UPDATE')) {
        return { table_name: 'A1', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
      }
      if (sql.includes('FROM scan_sessions')) {
        return { table_name: 'A1', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
      }
      if (sql.includes('FROM tables')) return { id: 1, store_id: 7 };
      if (sql.includes('COUNT(*)')) return { cnt: 0 };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 1 }; },
    withTransaction: async fn => { transactionCalls++; return fn(); }
  });
  const handler = routes.get('POST /api/public/call-waiter').at(-1);
  const res = response();
  await handler({ body: { table: 'A1', sessionToken: 'valid-token' } }, res);
  assert.equal(transactionCalls, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(calls.some(x => x.sql.includes('INSERT INTO waiter_calls')));
});


test('renaming a table updates pending orders, active QR sessions, calls and reservations atomically', async () => {
  const { app, routes } = routeHarness();
  const writes = [];
  let transactions = 0;
  require('../routes/tables')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async sql => {
      if (sql.includes('FOR UPDATE')) return { id: 9, name: 'A1', status: 'available' };
      return { id: 9, name: 'A1-new', status: 'available', store_id: 7 };
    },
    allAsync: async () => [],
    runAsync: async sql => { writes.push(sql); return { affectedRows: 1 }; },
    withTransaction: async fn => { transactions++; return fn(); },
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) }
  });
  const handler = routes.get('PUT /api/tables/:id').at(-1);
  const res = response();
  await handler({ params: { id: '9' }, storeId: 7, body: { name: 'A1-new' } }, res);
  assert.equal(transactions, 1);
  assert.equal(res.statusCode, 200);
  assert.ok(writes.some(sql => sql.includes('UPDATE orders SET table_name')));
  assert.ok(writes.some(sql => sql.includes('UPDATE scan_sessions SET table_name')));
  assert.ok(writes.some(sql => sql.includes('UPDATE waiter_calls SET table_name')));
  assert.ok(writes.some(sql => sql.includes('UPDATE reservations SET table_name')));
});

test('table deletion is blocked while pending orders or active reservations remain', async () => {
  const { app, routes } = routeHarness();
  const writes = [];
  require('../routes/tables')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async sql => {
      if (sql.includes('FOR UPDATE')) return { id: 9, name: 'A1' };
      if (sql.includes('FROM orders')) return { count: 0 };
      if (sql.includes('FROM waiter_calls')) return { count: 0 };
      if (sql.includes('FROM reservations')) return { count: 1 };
      return null;
    },
    allAsync: async () => [],
    runAsync: async sql => { writes.push(sql); return { affectedRows: 1 }; },
    withTransaction: async fn => fn(),
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) }
  });
  const handler = routes.get('DELETE /api/tables/:id').at(-1);
  const res = response();
  await handler({ params: { id: '9' }, storeId: 7 }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(writes.length, 0);
});


test('sub-admin without table permission cannot list or move tables', async () => {
  const { app, routes } = routeHarness();
  let databaseTouched = false;
  require('../routes/tables')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async () => { databaseTouched = true; return null; },
    allAsync: async () => { databaseTouched = true; return []; },
    runAsync: async () => { databaseTouched = true; return { affectedRows: 0 }; },
    withTransaction: async fn => fn(),
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) }
  });

  const listHandlers = routes.get('GET /api/tables');
  const listRes = response();
  let listNextCalled = false;
  listHandlers[1]({ isAdmin: true, isPrimaryAdmin: false, adminPermissions: { can_manage_table: 0 } }, listRes, () => { listNextCalled = true; });
  assert.equal(listRes.statusCode, 403);
  assert.equal(listNextCalled, false);

  const moveHandlers = routes.get('POST /api/tables/move');
  const moveRes = response();
  let moveNextCalled = false;
  moveHandlers[1]({ isAdmin: true, isPrimaryAdmin: false, adminPermissions: { can_manage_table: 0 } }, moveRes, () => { moveNextCalled = true; });
  assert.equal(moveRes.statusCode, 403);
  assert.equal(moveNextCalled, false);
  assert.equal(databaseTouched, false);
});
