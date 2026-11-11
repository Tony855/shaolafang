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
    statusCode: 200,
    body: null,
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
