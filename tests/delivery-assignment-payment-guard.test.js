'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerDeliveryRoutes = require('../routes/delivery');

function setup(order) {
  const handlers = new Map(), calls = [], transactions = [], events = [];
  const pass = (_req, _res, next) => next();
  const app = {
    get(path, ...handlersForRoute) { handlers.set('GET ' + path, handlersForRoute[handlersForRoute.length - 1]); },
    post(path, ...handlersForRoute) { handlers.set('POST ' + path, handlersForRoute[handlersForRoute.length - 1]); },
    put(path, ...handlersForRoute) { handlers.set('PUT ' + path, handlersForRoute[handlersForRoute.length - 1]); }
  };
  registerDeliveryRoutes(app, {
    getAsync: async sql => { calls.push({ type: 'get', sql }); if (sql.includes('FROM orders')) return order; if (sql.includes('FROM delivery_riders')) return { id: 9 }; if (sql.includes('SELECT id, order_id, rider_id')) return { id: 1, order_id: 5, rider_id: 9, status: 'assigned' }; return null; },
    allAsync: async () => [],
    runAsync: async (sql, params) => { calls.push({ type: 'run', sql, params }); return { affectedRows: 1 }; },
    withTransaction: async work => { transactions.push('begin'); try { const result = await work(); transactions.push('commit'); return result; } catch (error) { transactions.push('rollback'); throw error; } },
    requireAdminKey: pass, requirePermission: () => pass,
    hashPassword: value => value, verifyPassword: () => true,
    io: { to: room => ({ emit(event, payload) { events.push({ room, event, payload }); } }) },
    isLoginLocked: async () => ({ locked: false }), recordLoginAttempt() {}, resetLoginAttempts() {}, cancelLoginAttempt() {}
  });
  return { handler: handlers.get('POST /api/admin/delivery/orders/:id/assign'), calls, transactions, events };
}
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

test('unpaid KHQR delivery orders cannot be dispatched to a rider', async () => {
  const ctx = setup({ id: 5, status: 'pending', merchant_id: 3, fulfillment_type: 'delivery', pay_method: 'khqr' });
  const res = response();
  await ctx.handler({
    storeId: 7, merchantId: 3, params: { id: '5' },
    body: { riderId: 9, address: 'Street 123', recipientName: 'Alex', recipientPhone: '12345678' }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /尚未确认收款/);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
  assert.deepEqual(ctx.transactions, ['begin', 'rollback']);
});

test('settled KHQR delivery orders can proceed to dispatch', async () => {
  const ctx = setup({ id: 5, status: 'done', merchant_id: 3, fulfillment_type: 'delivery', pay_method: 'khqr' });
  const res = response();
  await ctx.handler({
    storeId: 7, merchantId: 3, params: { id: '5' },
    body: { riderId: 9, address: 'Street 123', recipientName: 'Alex', recipientPhone: '12345678' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO delivery_jobs')));
  assert.ok(ctx.events.some(event => event.room === 'delivery-riders-store-7' && event.event === 'delivery:rider-refresh'));
  assert.deepEqual(ctx.transactions, ['begin', 'commit']);
});

test('refunded delivery orders cannot be dispatched', async () => {
  const ctx = setup({ id: 5, status: 'refunded', merchant_id: 3, fulfillment_type: 'delivery', pay_method: 'cash' });
  const res = response();
  await ctx.handler({
    storeId: 7, merchantId: 3, params: { id: '5' },
    body: { riderId: 9, address: 'Street 123', recipientName: 'Alex', recipientPhone: '12345678' }
  }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /已退款/);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
  assert.deepEqual(ctx.transactions, ['begin', 'rollback']);
});
