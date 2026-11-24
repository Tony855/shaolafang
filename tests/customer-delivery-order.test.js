'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/customer-delivery');

function setup() {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const transactions = [];
  let orderRow = null;
  const app = {
    post(path, ...handlersForRoute) { handlers.set('POST ' + path, handlersForRoute[handlersForRoute.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM stores s JOIN merchants')) return { id: 7, name: 'Test Store', merchant_id: 3 };
      if (sql.includes('FROM stores WHERE id=? AND merchant_id=?')) return { id: 7 };
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=?')) return orderRow;
      return null;
    },
    allAsync: async (sql, params = []) => { calls.push({ type: 'all', sql, params }); return []; },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params });
      if (sql.includes('INSERT INTO orders')) {
        orderRow = { id: 33, store_id: 7, merchant_id: 3, table_name: null, fulfillment_type: 'delivery', status: 'pending', total: 12.5, order_no: '11GL00001', customer_token: params[4], items: '[]' };
        return { insertId: 33, lastID: 33, affectedRows: 1 };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      transactions.push('begin');
      try { const result = await work(); transactions.push('commit'); return result; }
      catch (error) { transactions.push('rollback'); throw error; }
    },
    normalizeOrderItems: async items => items.map(item => ({ id: item.id, name: 'Noodle', price: 12.5, base_price: 12.5, quantity: item.quantity })),
    allocateOrderNo: async prefix => prefix + '00001',
    getOrderCooldownMs: async () => 1000,
    checkAndSetCooldown: async () => true,
    getClientIp: () => '127.0.0.1',
    formatOrder: row => ({ ...row, sessionToken: '', customerToken: 'should-not-leak' }),
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } }
  };
  registerRoutes(app, deps);
  return { handler: handlers.get('POST /api/public/delivery/orders'), khqrHandler: handlers.get('POST /api/public/delivery/orders/:orderId/khqr'), notifyHandler: handlers.get('POST /api/public/delivery/orders/:orderId/payment-notify'), calls, events, transactions, get orderRow() { return orderRow; } };
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

test('customer delivery order creates a tableless order and unassigned delivery job atomically', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ body: {
    store_id: 7, recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }], note: 'No chili'
  } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.orderId, 33);
  assert.equal(res.body.customerToken.length, 64);
  assert.equal(res.body.trackingUrl.includes('#token='), true);
  const orderInsert = ctx.calls.find(x => x.type === 'run' && x.sql.includes('INSERT INTO orders'));
  assert.ok(orderInsert);
  assert.ok(orderInsert.sql.includes('VALUES (?, NULL,'));
  assert.equal(orderInsert.params[4].length, 64);
  assert.notEqual(orderInsert.params[4], res.body.customerToken);
  const jobInsert = ctx.calls.find(x => x.type === 'run' && x.sql.includes('INSERT INTO delivery_jobs'));
  assert.ok(jobInsert);
  assert.ok(jobInsert.sql.includes("NULL, ?, ?, ?, 'pending_assignment'"));
  assert.ok(ctx.calls.some(x => x.type === 'run' && x.sql.includes('UPDATE menus SET sales_count = sales_count + ?')));
  assert.deepEqual(ctx.transactions, ['begin', 'commit']);
  assert.ok(ctx.events.some(x => x.room === 'kitchen-7' && x.event === 'order:new'));
});

test('customer delivery order rejects missing recipient and address before database writes', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ body: { store_id: 7, items: [{ id: 5, quantity: 1 }] } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /收件人/);
  assert.equal(ctx.calls.some(x => x.type === 'run'), false);
  assert.deepEqual(ctx.transactions, []);
});

test('customer delivery order rejects unsupported payment methods', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler({ body: {
    store_id: 7, recipient_name: 'Alex', recipient_phone: '12345678',
    delivery_address: 'Street 123', payment_method: 'bitcoin', items: [{ id: 5, quantity: 1 }]
  } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /支付方式/);
  assert.equal(ctx.calls.some(x => x.type === 'run'), false);
});

test('customer KHQR generation and payment notification require the order bearer token', async () => {
  const ctx = setup();
  const req = { params: { orderId: '33' }, body: {}, get: () => '' };
  const qrRes = response();
  await ctx.khqrHandler(req, qrRes);
  assert.equal(qrRes.statusCode, 401);
  const notifyRes = response();
  await ctx.notifyHandler(req, notifyRes);
  assert.equal(notifyRes.statusCode, 401);
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(ctx.transactions, []);
});

test('customer delivery order reuses the durable browser customer token without storing it in plaintext', async () => {
  const ctx = setup();
  const token = 'b'.repeat(64);
  const res = response();
  await ctx.handler({ body: {
    store_id: 7, customer_token: token,
    recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }]
  } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.customerToken, token);
  const orderInsert = ctx.calls.find(x => x.type === 'run' && x.sql.includes('INSERT INTO orders'));
  assert.equal(orderInsert.params[4], require('../server/services/session-token').hashSessionToken(token));
  assert.notEqual(orderInsert.params[4], token);
});
