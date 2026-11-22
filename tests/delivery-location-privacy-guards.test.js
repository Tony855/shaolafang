'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerDeliveryRoutes = require('../routes/delivery');

function setup({ job = { id: 41, order_id: 9001 } } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const app = {
    get(path, ...handlersForRoute) { handlers.set('GET ' + path, handlersForRoute.at(-1)); },
    post(path, ...handlersForRoute) { handlers.set('POST ' + path, handlersForRoute.at(-1)); }
  };
  registerDeliveryRoutes(app, {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM delivery_rider_sessions')) {
        return { id: 12, merchant_id: 3, store_id: 7, display_name: 'Rider', phone: '' };
      }
      if (sql.includes('FROM delivery_jobs')) return job;
      return null;
    },
    allAsync: async () => [],
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params });
      return { affectedRows: 1 };
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
  return { handler: handlers.get('POST /api/delivery/jobs/:id/location'), calls, events };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function request(latitude = 11.5564, longitude = 104.9282, accuracy = 12) {
  return {
    params: { id: '41' },
    body: { latitude, longitude, accuracy },
    get(name) { return name.toLowerCase() === 'authorization' ? 'Bearer test-rider-session-token' : ''; }
  };
}

test('location endpoint rejects out-of-range and non-finite coordinates before any write', async () => {
  for (const body of [
    { latitude: 91, longitude: 104 },
    { latitude: 11, longitude: -181 },
    { latitude: 'not-a-number', longitude: 104 },
    { latitude: 11, longitude: 104, accuracy: -1 },
    { latitude: 11, longitude: 104, accuracy: 10001 }
  ]) {
    const ctx = setup();
    const res = response();
    await ctx.handler({ ...request(), body, get: request().get }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(ctx.calls.some(call => call.type === 'run'), false);
    assert.deepEqual(ctx.events, []);
  }
});

test('location lookup is scoped to rider, merchant and store and locks an active delivery job', async () => {
  const ctx = setup();
  const res = response();

  await ctx.handler(request(), res);

  const lookup = ctx.calls.find(call => call.type === 'get' && call.sql.includes('FROM delivery_jobs'));
  assert.ok(lookup);
  assert.match(lookup.sql, /rider_id=\?/);
  assert.match(lookup.sql, /merchant_id=\?/);
  assert.match(lookup.sql, /store_id=\?/);
  assert.match(lookup.sql, /status IN \('accepted','picked_up','delivering'\)/);
  assert.match(lookup.sql, /FOR UPDATE/);
  assert.deepEqual(lookup.params, [41, 12, 3, 7]);
  assert.equal(res.statusCode, 200);
});

test('location is not persisted or broadcast when the job is inactive or reassigned', async () => {
  const ctx = setup({ job: null });
  const res = response();

  await ctx.handler(request(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(ctx.calls.some(call => call.type === 'run'), false);
  assert.deepEqual(ctx.events, []);
});
