'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function response() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
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
      if (sql.includes('JOIN merchants')) return { id: 7 };
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
      if (sql.includes('JOIN merchants')) return { id: 7 };
      if (sql.includes('FROM scan_sessions') && sql.includes('FOR UPDATE')) {
        return { table_name: 'A1', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
      }
      if (sql.includes('FROM scan_sessions')) {
        return { table_name: 'A1', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
      }
      if (sql.includes('FROM tables')) return { id: 1, store_id: 7 };
      if (sql.includes('FROM stores')) return { id: 7 };
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
    allAsync: async sql => sql.includes('FROM reservations') ? [{ id: 1 }] : [],
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
  listHandlers[1]({ isAdmin: true, adminId: 55, isPrimaryAdmin: false, adminPermissions: { can_manage_table: 0 } }, listRes, () => { listNextCalled = true; });
  assert.equal(listRes.statusCode, 403);
  assert.equal(listNextCalled, false);

  const moveHandlers = routes.get('POST /api/tables/move');
  const moveRes = response();
  let moveNextCalled = false;
  moveHandlers[1]({ isAdmin: true, adminId: 55, isPrimaryAdmin: false, adminPermissions: { can_manage_table: 0 } }, moveRes, () => { moveNextCalled = true; });
  assert.equal(moveRes.statusCode, 403);
  assert.equal(moveNextCalled, false);
  assert.equal(databaseTouched, false);
});


test('waiter-call cooldown remains active after older calls leave the rolling count window', async () => {
  const { app, routes } = routeHarness();
  const now = Date.now();
  const recentCalls = [
    { created_at: new Date(now - 5 * 60000).toISOString() },
    { created_at: new Date(now - 5.5 * 60000).toISOString() },
    { created_at: new Date(now - 6 * 60000).toISOString() }
  ];
  let inserted = false;
  require('../routes/calls')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async sql => {
      if (sql.includes('JOIN merchants')) return { id: 7 };
      if (sql.includes('FROM scan_sessions')) {
        return { table_name: 'A1', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
      }
      if (sql.includes('FROM tables')) return { id: 1, store_id: 7 };
      if (sql.includes('FROM stores')) return { id: 7 };
      return null;
    },
    allAsync: async sql => {
      if (sql.includes('call_limit_enabled')) {
        return [
          { key: 'call_limit_enabled', value: '1' },
          { key: 'call_limit_max', value: '3' },
          { key: 'call_limit_window_minutes', value: '5' },
          { key: 'call_limit_cooldown_minutes', value: '10' }
        ];
      }
      if (sql.includes('FROM waiter_calls')) return recentCalls;
      return [];
    },
    runAsync: async () => { inserted = true; return { affectedRows: 1 }; },
    withTransaction: async fn => fn()
  });
  const handler = routes.get('POST /api/public/call-waiter').at(-1);
  const res = response();
  await handler({ body: { table: 'A1', sessionToken: 'valid-token' } }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.cooldownMinutes, 5);
  assert.equal(inserted, false);
});


test('order creation rechecks the QR session after locking the table', async () => {
  const { app, routes } = routeHarness();
  const queries = [];
  const writes = [];
  let sessionReads = 0;
  const validSession = {
    table_name: 'A1',
    store_id: 7,
    expires_at: new Date(Date.now() + 60000).toISOString()
  };
  require('../routes/orders')(app, {
    authenticateAdmin: async () => null,
    getWaiterFromRequest: async () => null,
    getAsync: async (sql) => {
      queries.push(sql);
      if (sql.includes('JOIN merchants')) return { id: 7 };
      if (sql.includes('FROM scan_sessions') && sql.includes('FOR UPDATE')) {
        sessionReads++;
        return null; // Session was removed by a concurrent table move after the first read.
      }
      if (sql.includes('FROM scan_sessions')) return validSession;
      if (sql.includes('FROM tables')) return { store_id: 7, id: 1 };
      if (sql.includes('FROM stores')) return { id: 7 };
      if (sql.includes('max_order_items')) return { value: '50' };
      if (sql.includes('max_item_quantity')) return { value: '100' };
      if (sql.includes('max_order_note_length')) return { value: '200' };
      if (sql.includes('SELECT merchant_id FROM stores')) return { merchant_id: 7 };
      if (sql.includes('order_prefix_normal')) return { value: '11' };
      if (sql.includes('order_no_reset_period')) return { value: 'never' };
      return null;
    },
    runAsync: async (sql, params) => { writes.push({ sql, params }); return { lastID: 99, affectedRows: 1 }; },
    allAsync: async () => [],
    requireAdminKey: pass,
    requirePermission: () => pass,
    requireAdminOrWaiter: pass,
    getWaiterFromRequest: async () => null,
    formatOrder: value => value,
    normalizeOrderItems: async () => [{ id: 1, name: 'Tea', quantity: 1, base_price: 2, itemStatus: 'done' }],
    assertTableExists: async () => 'A1',
    syncTableStatus: async () => {},
    ensureOrderTables: async () => {},
    io: { to: () => ({ emit() {} }) },
    getClientIp: () => '127.0.0.1',
    logAudit: async () => {},
    upload: {},
    UPLOAD_DIR: '/tmp',
    path: require('node:path'),
    allocateOrderNo: async () => '11000001',
    getOrderCooldownMs: async () => 0,
    createTableToken: () => 'unused',
    buildReceipt: () => Buffer.from(''),
    buildKitchenTicket: () => Buffer.from(''),
    printToNetworkPrinter: async () => {},
    dispatchPrint: async () => ({ printed: false }),
    verifyPassword: () => true,
    checkAndSetCooldown: async () => true,
    withTransaction: async fn => fn()
  });

  const handler = routes.get('POST /api/orders').at(-1);
  const res = response();
  await handler({
    body: { table: 'A1', sessionToken: 'qr-session', customerToken: 'customer-token', items: [{ id: 1, quantity: 1 }] },
    get: () => ''
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(sessionReads, 1);
  const lockIndex = queries.findIndex(sql => sql.includes('FROM tables') && sql.includes('FOR UPDATE'));
  const sessionLockIndex = queries.findIndex(sql => sql.includes('FROM scan_sessions') && sql.includes('FOR UPDATE'));
  assert.ok(lockIndex >= 0);
  assert.ok(sessionLockIndex > lockIndex);
  assert.equal(writes.some(write => write.sql.includes('INSERT INTO orders')), false);
});


test('QR credential generation requires table-management permission', () => {
  const { app, routes } = routeHarness();
  const auth = () => {};
  const permission = () => {};
  require('../routes/public-session')(app, {
    requireAdminKey: auth,
    requirePermission: key => {
      assert.equal(key, 'can_manage_table');
      return permission;
    },
    getAsync: async () => null,
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => [],
    formatOrder: value => value
  });
  const handlers = routes.get('GET /api/tables/:id/qrcode');
  assert.equal(handlers[0], auth);
  assert.equal(handlers[1], permission);
});


test('QR print page is authenticated and scoped to the active store', async () => {
  const { app, routes } = routeHarness();
  const queries = [];
  const auth = () => {};
  const permission = () => {};
  require('../routes/pages')(app, {
    requireAdminKey: auth,
    requirePermission: key => {
      assert.equal(key, 'can_manage_table');
      return permission;
    },
    getAsync: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('FROM tables')) return { name: 'A1', qr_token: 'secret-qr-token', store_id: 7 };
      if (sql.includes('FROM stores')) return { name: 'Store A', qr_languages: 'en' };
      return null;
    },
    fs: {
      existsSync: () => true,
      readFileSync: () => '<html><head></head><body>{{table}} {{storeName}} {{qrDataUrl}} {{url}}</body></html>'
    },
    path: require('node:path'),
    QRCode: { toDataURL: async url => 'data:image/png;base64,' + Buffer.from(url).toString('base64') }
  });

  const handlers = routes.get('GET /qr-print');
  assert.equal(handlers[0], auth);
  assert.equal(handlers[1], permission);
  const res = {
    statusCode: 200,
    body: '',
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(value) { this.body = value; return this; }
  };
  await handlers.at(-1)({
    query: { tableId: '5', lang: 'en' },
    storeId: 7,
    merchantId: 2,
    protocol: 'https',
    get: () => 'foodflow.example'
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(queries[0].params, [5, 7]);
  assert.deepEqual(queries[1].params, [7, 2]);
  assert.match(res.body, /secret-qr-token/);
  assert.match(res.headers['Cache-Control'] || '', /no-store/);
});


test('customer order lookup accepts bearer tokens in headers and disables caching', async () => {
  const { app, routes } = routeHarness();
  const sqlCalls = [];
  require('../routes/public-session')(app, {
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async (sql, params) => {
      sqlCalls.push({ sql, params });
      if (sql.includes('FROM scan_sessions')) {
        return { table_name: 'A1', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
      }
      if (sql.includes('FROM stores')) return { id: 7 };
      return null;
    },
    allAsync: async (sql, params) => {
      sqlCalls.push({ sql, params });
      return [{ id: 99, customer_token: 'private-customer-token' }];
    },
    runAsync: async () => ({ affectedRows: 1 }),
    formatOrder: row => row
  });

  const headers = { 'X-Scan-Session': 'private-scan-session', 'X-Customer-Token': 'private-customer-token' };
  const res = {
    ...response(),
    headers: {},
    setHeader(name, value) { this.headers[name] = value; }
  };
  await routes.get('GET /api/public/table-session/orders').at(-1)({
    get: name => headers[name] || '',
    query: {},
    params: {}
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orders[0].id, 99);
  assert.deepEqual(sqlCalls[0].params, ['private-scan-session']);
  assert.match(sqlCalls[2].sql, /table_name=\? AND session_token=\? AND customer_token=\?/);
  assert.deepEqual(sqlCalls[2].params.slice(0, 4), [7, 'A1', 'private-scan-session', 'private-customer-token']);
  assert.match(res.headers['Cache-Control'], /no-store/);
});

test('public order lookup never returns scan or customer bearer tokens', async () => {
  const { app, routes } = routeHarness();
  const sourceOrder = {
    id: 99, session_token: 'private-session-token', customer_token: 'private-customer-token'
  };
  require('../routes/public-session')(app, {
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async (sql) => {
      if (sql.includes('FROM scan_sessions')) {
        return { table_name: 'A1', store_id: 7, expires_at: new Date(Date.now() + 60000).toISOString() };
      }
      if (sql.includes('FROM stores')) return { id: 7 };
      return null;
    },
    allAsync: async () => [sourceOrder],
    runAsync: async () => ({ affectedRows: 1 }),
    formatOrder: row => ({
      id: row.id,
      sessionToken: row.session_token,
      customerToken: row.customer_token,
      status: 'pending'
    })
  });

  const handler = routes.get('GET /api/public/table-session/orders').at(-1);
  const res = response();
  await handler({
    get: name => ({ 'X-Scan-Session': 'private-session-token', 'X-Customer-Token': 'private-customer-token' }[name] || ''),
    query: {}, params: {}
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.orders, [{ id: 99, status: 'pending' }]);
  assert.equal(JSON.stringify(res.body).includes('private-session-token'), false);
  assert.equal(JSON.stringify(res.body).includes('private-customer-token'), false);
});

test('public QR scan credentials are never cacheable', async () => {
  const { app, routes } = routeHarness();
  require('../routes/public-session')(app, {
    getAsync: async sql => {
      if (sql.includes('FROM tables WHERE qr_token')) return { name: 'A1', store_id: 7 };
      if (sql.includes('FROM stores')) return { id: 7 };
      return null;
    },
    runAsync: async () => ({ affectedRows: 1, lastID: 1 }),
    allAsync: async () => [],
    requireAdminKey: pass,
    requirePermission: () => pass,
    formatOrder: row => row
  });
  const handler = routes.get('GET /api/public/table-token/:token').at(-1);
  const res = response();
  await handler({ params: { token: 'qr-token' }, protocol: 'https', get: name => name === 'host' ? 'foodflow.example' : '' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.headers.Pragma, 'no-cache');
  assert.ok(res.body.sessionToken);
  assert.ok(res.body.customerToken);
});

test('table QR code route rejects malformed table IDs before database access', async () => {
  const { app, routes } = routeHarness();
  let queries = 0;
  require('../routes/public-session')(app, {
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async () => { queries++; return null; },
    runAsync: async () => ({ affectedRows: 0 }),
    allAsync: async () => [],
    formatOrder: row => row
  });
  const handler = routes.get('GET /api/tables/:id/qrcode').at(-1);
  const res = response();
  await handler({ params: { id: '42junk' }, storeId: 7, protocol: 'https', get: () => 'foodflow.example' }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(queries, 0);
});


test('whole-table move refuses to move orders with an active KHQR payload', async () => {
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
      if (sql.includes('FROM orders') && sql.includes('FOR UPDATE')) {
        return [{ id: 11, awaiting_confirm: 0, pay_khqr_ref: 'active-qr', pay_expires_at: new Date(Date.now() + 60000).toISOString() }];
      }
      return [];
    },
    getAsync: async () => null,
    runAsync: async (sql, params) => { writes.push({ sql, params }); return { affectedRows: 1 }; },
    withTransaction: async fn => { transactionCalls++; return fn(); },
    syncTableStatus: async () => {},
    io: { to: room => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) },
    createTableToken: () => 'unused'
  });

  const res = response();
  await routes.get('POST /api/tables/move').at(-1)({
    isAdmin: true, isPrimaryAdmin: true, storeId: 7,
    body: { from_table: 'A1', target_table: 'A2' }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(writes.some(x => x.sql.includes('UPDATE orders SET table_name=')), false);
  assert.deepEqual(emitted, []);
  assert.equal(transactionCalls, 1);
});

test('renaming a table refuses to move pending orders with an active KHQR payload', async () => {
  const { app, routes } = routeHarness();
  const writes = [];
  let transactionCalls = 0;
  require('../routes/tables')(app, {
    requireAdminOrWaiter: pass,
    requireAdminKey: pass,
    requirePermission: () => pass,
    getAsync: async sql => {
      if (sql.includes('FROM tables WHERE id=? AND store_id=? FOR UPDATE')) return { id: 1, name: 'A1', status: 'occupied' };
      return null;
    },
    allAsync: async sql => sql.includes('FROM orders') && sql.includes('FOR UPDATE')
      ? [{ id: 11, awaiting_confirm: 0, pay_khqr_ref: 'active-qr', pay_expires_at: new Date(Date.now() + 60000).toISOString() }]
      : [],
    runAsync: async (sql, params) => { writes.push({ sql, params }); return { affectedRows: 1 }; },
    withTransaction: async fn => { transactionCalls++; return fn(); },
    syncTableStatus: async () => {},
    io: { to: () => ({ emit() {} }) },
    createTableToken: () => 'unused'
  });

  const res = response();
  await routes.get('PUT /api/tables/:id').at(-1)({
    storeId: 7, params: { id: '1' }, body: { name: 'A1-renamed' }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHQR/);
  assert.equal(writes.some(x => x.sql.startsWith('UPDATE tables SET name=')), false);
  assert.equal(transactionCalls, 1);
});
