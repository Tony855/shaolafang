'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerPublicRoutes = require('../routes/public');

function buildApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(path, handler); }
  };
}

function responseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('readiness returns 200 only after the database responds', async () => {
  const app = buildApp();
  let query;
  registerPublicRoutes(app, {
    getAsync: async sql => { query = sql; return { ok: 1 }; },
    allAsync: async () => []
  });

  const handler = app.routes.get('/api/health/ready');
  assert.equal(typeof handler, 'function');
  const res = responseRecorder();
  await handler({}, res);

  assert.equal(query, 'SELECT 1 AS ok');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.checks, { database: 'ok' });
});

test('readiness fails closed and hides database error details', async () => {
  const app = buildApp();
  registerPublicRoutes(app, {
    getAsync: async () => { throw new Error('secret database host/password'); },
    allAsync: async () => []
  });

  const handler = app.routes.get('/api/health/ready');
  const res = responseRecorder();
  await handler({}, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    ok: false,
    service: 'foodflow',
    checks: { database: 'error' }
  });
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
});

test('cluster readiness fails closed when Redis or Socket.IO adapter is unavailable', async () => {
  const app = buildApp();
  registerPublicRoutes(app, {
    getAsync: async () => ({ ok: 1 }),
    allAsync: async () => [],
    getClusterReadiness: () => ({ required: true, ready: false, redis: 'unavailable', socketIo: 'ok' })
  });
  const res = responseRecorder();
  await app.routes.get('/api/health/ready')({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body.checks, { database: 'ok', redis: 'unavailable', socketIo: 'ok' });
});

test('cluster readiness returns 200 after Redis and Socket.IO adapter recover', async () => {
  const app = buildApp();
  registerPublicRoutes(app, {
    getAsync: async () => ({ ok: 1 }),
    allAsync: async () => [],
    getClusterReadiness: () => ({ required: true, ready: true, redis: 'ok', socketIo: 'ok' })
  });
  const res = responseRecorder();
  await app.routes.get('/api/health/ready')({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.checks, { database: 'ok', redis: 'ok', socketIo: 'ok' });
});
