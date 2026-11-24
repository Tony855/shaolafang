'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerDeliveryRoutes = require('../routes/delivery');

function setup({ currentStatus = 'assigned', affectedRows = 1 } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const app = {
    get(path, ...routeHandlers) { handlers.set('GET ' + path, routeHandlers[routeHandlers.length - 1]); },
    post(path, ...routeHandlers) { handlers.set('POST ' + path, routeHandlers[routeHandlers.length - 1]); }
  };
  registerDeliveryRoutes(app, {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM delivery_jobs')) return { id: 41, order_id: 9001, status: currentStatus };
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params });
      return { affectedRows };
    },
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    hashPassword: value => value,
    verifyPassword: () => true,
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } },
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {}
  });
  return {
    handler: handlers.get('POST /api/delivery/jobs/:id/status'),
    calls,
    events
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

function request(status) {
  return {
    params: { id: '41' },
    body: { status },
    deliveryRider: { id: 12, merchant_id: 3, store_id: 7 }
  };
}

test('delivery status compare-and-set rejects a concurrent stale update without emitting events', async () => {
  const ctx = setup({ currentStatus: 'assigned', affectedRows: 0 });
  const res = response();

  await ctx.handler(request('accepted'), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /其他操作更新/);
  const update = ctx.calls.find(call => call.type === 'run');
  assert.ok(update, 'the conditional update must be attempted');
  assert.match(update.sql, /AND status=\?/);
  assert.deepEqual(update.params, ['accepted', 41, 12, 3, 7, 'assigned']);
  assert.deepEqual(ctx.events, [], 'stale writes must not broadcast a false status');
});

test('delivery status transition emits events only after the conditional update succeeds', async () => {
  const ctx = setup({ currentStatus: 'assigned', affectedRows: 1 });
  const res = response();

  await ctx.handler(request('accepted'), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, status: 'accepted' });
  assert.equal(ctx.events.length, 2);
  assert.ok(ctx.events.some(event => event.room === 'delivery-order-9001' && event.event === 'delivery:status'));
  assert.ok(ctx.events.some(event => event.room === 'delivery-store-7' && event.event === 'delivery:status'));
});

test('delivery status transition rejects an invalid or already-advanced state before writing', async () => {
  const ctx = setup({ currentStatus: 'picked_up', affectedRows: 1 });
  const res = response();

  await ctx.handler(request('accepted'), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /状态已变化/);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
  assert.deepEqual(ctx.events, []);
});

test('delivery status endpoint rejects an unsupported next status', async () => {
  const ctx = setup();
  const res = response();

  await ctx.handler(request('cancelled'), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /配送状态无效/);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.events, []);
});
