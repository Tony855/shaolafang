'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerDeliveryRoutes = require('../routes/delivery');

function setup() {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers[handlers.length - 1]); },
    post() {},
    delete() {}
  };
  registerDeliveryRoutes(app, {});
  return routes;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('non-numeric delivery path segments fall through to later static routes', async () => {
  const handler = setup().get('GET /api/public/delivery/:orderId');
  let continued = false;
  await handler(
    { params: { orderId: 'telegram-miniapp-stores' }, get: () => '' },
    response(),
    () => { continued = true; }
  );
  assert.equal(continued, true);
});

test('numeric delivery order IDs still require a customer token', async () => {
  const handler = setup().get('GET /api/public/delivery/:orderId');
  const res = response();
  let continued = false;
  await handler(
    { params: { orderId: '123' }, get: () => '' },
    res,
    () => { continued = true; }
  );
  assert.equal(continued, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: '订单或顾客凭证无效' });
});
