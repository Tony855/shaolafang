'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerDeliveryRoutes = require('../routes/delivery');
const { hashSessionToken } = require('../server/services/session-token');

const token = 'customer-tracking-token';

function setup({ order = {
  id: 44, customer_token: hashSessionToken(token), order_no: 'D-44',
  status: 'pending', total: 12.5, pay_method: 'cash', awaiting_confirm: 0,
  settled_at: null, merchant_id: 9, store_id: 7
}, job = {
  id: 51, order_id: 44, status: 'delivering', recipient_name: 'Recipient',
  recipient_phone: '+85512345678', delivery_address: 'Address',
  rider_name: 'Rider', rider_phone: '+85598765432',
  latitude: 11.5564, longitude: 104.9282, accuracy_m: 12,
  location_updated_at: '2026-11-23T01:00:00.000Z'
} } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = {
    get(path, ...routeHandlers) { handlers.set('GET ' + path, routeHandlers.at(-1)); },
    post(path, ...routeHandlers) { handlers.set('POST ' + path, routeHandlers.at(-1)); }
  };
  registerDeliveryRoutes(app, {
    getAsync: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM orders o')) return order;
      if (sql.includes('FROM delivery_jobs j')) return job;
      return null;
    },
    allAsync: async () => [],
    runAsync: async () => ({ affectedRows: 1 }),
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    hashPassword: value => value,
    verifyPassword: () => true,
    io: { to() { return { emit() {} }; } },
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {}
  });
  return { handler: handlers.get('GET /api/public/delivery/:orderId'), calls };
}

function request(orderId = '44', customerToken = token) {
  return {
    params: { orderId },
    get(name) { return name === 'X-Customer-Token' ? customerToken : ''; }
  };
}

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('public tracking rejects invalid order IDs and missing tokens before querying the database', async () => {
  for (const [orderId, customerToken] of [['0', token], ['44', ''], ['44', 'x'.repeat(129)]]) {
    const ctx = setup();
    const res = response();
    await ctx.handler(request(orderId, customerToken), res);
    assert.equal(res.statusCode, 401);
    assert.equal(ctx.calls.length, 0);
  }
});

test('public tracking does not query the delivery job when the order token does not match', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(request('44', 'wrong-token'), res);
  assert.equal(res.statusCode, 404);
  assert.equal(ctx.calls.length, 1);
  assert.ok(ctx.calls[0].sql.includes("o.fulfillment_type='delivery'"));
  assert.ok(ctx.calls[0].sql.includes('JOIN stores s'));
  assert.ok(ctx.calls[0].sql.includes('JOIN merchants m'));
  assert.deepEqual(ctx.calls[0].params, [44]);
  assert.equal(ctx.calls.some(call => call.sql.includes('FROM delivery_jobs j')), false);
});

test('valid public tracking is order-token scoped and only exposes current delivery location', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.body.order.id, 44);
  assert.equal(res.body.job.order_id, 44);

  const orderLookup = ctx.calls.find(call => call.sql.includes('FROM orders o'));
  assert.ok(orderLookup);
  assert.ok(orderLookup.sql.includes("o.fulfillment_type='delivery'"));
  assert.deepEqual(orderLookup.params, [44]);

  const jobLookup = ctx.calls.find(call => call.sql.includes('FROM delivery_jobs j'));
  assert.ok(jobLookup);
  assert.match(jobLookup.sql, /j\.merchant_id=\(SELECT merchant_id FROM orders WHERE id=\?\)/);
  assert.match(jobLookup.sql, /j\.store_id=\(SELECT store_id FROM orders WHERE id=\?\)/);
  assert.match(jobLookup.sql, /l\.updated_at>=j\.assigned_at/);
  assert.match(jobLookup.sql, /j\.status IN \('accepted','picked_up','delivering'\)/);
  assert.deepEqual(jobLookup.params, [44, 44, 44]);
});

test('public tracking returns not-found when active merchant/store/order lookup fails', async () => {
  const ctx = setup({ order: null });
  const res = response();
  await ctx.handler(request(), res);
  assert.equal(res.statusCode, 404);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls.some(call => call.sql.includes('FROM delivery_jobs j')), false);
});


test('public tracking SQL excludes coordinates older than two minutes', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(request(), res);
  const jobLookup = ctx.calls.find(call => call.sql.includes('FROM delivery_jobs j'));
  assert.ok(jobLookup);
  assert.ok(jobLookup.sql.includes('l.updated_at>=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)'));
});
