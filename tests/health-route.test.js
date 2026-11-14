'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerHealthRoute = require('../routes/health');

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('health route reports ready only when the database query succeeds', async () => {
  const handlers = {};
  const app = { get(path, callback) { handlers[path] = callback; } };
  registerHealthRoute(app, { getPool: () => ({ query: async () => [[{ ready: 1 }], []] }) });
  const response = createResponse();
  await handlers['/health']({}, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: 'ok', database: 'ok' });
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('health route returns a generic 503 without leaking database errors', async () => {
  const handlers = {};
  const app = { get(path, callback) { handlers[path] = callback; } };
  registerHealthRoute(app, { getPool: () => ({ query: async () => { throw new Error('secret database password'); } }) });
  const response = createResponse();
  await handlers['/health']({}, response);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { status: 'degraded', database: 'unavailable' });
  assert.equal(JSON.stringify(response.body).includes('secret'), false);
});
