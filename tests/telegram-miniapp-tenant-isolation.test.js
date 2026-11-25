'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const registerCustomerDeliveryRoutes = require('../routes/customer-delivery');

const token = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
const now = Math.floor(Date.now() / 1000);

function signedInitData() {
  const params = new Map([
    ['auth_date', String(now)],
    ['query_id', 'shared-client-test'],
    ['user', JSON.stringify({ id: 10001, first_name: 'Customer' })]
  ]);
  const data = Array.from(params.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return new URLSearchParams(params).toString();
}

function setup({ enabled = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = {
    get(path, handler) { handlers.set('GET ' + path, handler); },
    post(path, handler) { handlers.set('POST ' + path, handler); },
    delete(path, handler) { handlers.set('DELETE ' + path, handler); }
  };
  const deps = {
    getAsync: async () => null,
    allAsync: async (sql, params) => {
      calls.push([sql, params]);
      if (sql.includes('FROM settings')) return [
        { key: 'telegram_client_bot_enabled', value: enabled ? '1' : '0' },
        { key: 'telegram_client_bot_token', value: token }
      ];
      if (sql.includes('FROM stores')) return [
        { id: 11, merchant_id: 7, name: 'Tenant A store' },
        { id: 12, merchant_id: 8, name: 'Tenant B store' }
      ];
      return [];
    },
    runAsync: async () => ({ affectedRows: 1 }),
    withTransaction: async fn => fn(),
    normalizeOrderItems: async () => [],
    allocateOrderNo: async () => 'TEST',
    getOrderCooldownMs: async () => 0,
    checkAndSetCooldown: async () => true,
    getClientIp: () => '127.0.0.1',
    formatOrder: value => value,
    io: { to: () => ({ emit() {} }) }
  };
  registerCustomerDeliveryRoutes(app, deps);
  return { handler: handlers.get('GET /api/public/delivery/telegram-miniapp-stores'), calls };
}

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(initData) {
  return {
    headers: { 'x-telegram-init-data': initData },
    get(name) { return this.headers[name.toLowerCase()]; }
  };
}

test('shared Client Bot Mini App requires signed Telegram initData', async () => {
  const { handler, calls } = setup();
  const missing = response();
  await handler(request(''), missing);
  assert.equal(missing.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('shared Client Bot Mini App verifies with the single super-admin configured token', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler(request(signedInitData()), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.stores.map(store => [store.id, store.merchantId]), [[11, 7], [12, 8]]);
  assert.match(calls[0][0], /telegram_client_bot_enabled/);
  assert.deepEqual(calls[0][1], ['telegram_client_bot_enabled', 'telegram_client_bot_token']);
  assert.match(calls[1][0], /s\.merchant_id/);
  assert.doesNotMatch(calls[1][0], /WHERE s\.merchant_id=\?/);
});

test('shared Client Bot Mini App rejects disabled global Bot before listing stores', async () => {
  const { handler, calls } = setup({ enabled: false });
  const res = response();
  await handler(request(signedInitData()), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 1);
});

test('shared Client Bot Mini App rejects initData signed by a different Bot token', async () => {
  const { handler, calls } = setup();
  const other = '654321:zyxwvutsrqponmlkjihgfedcbaABCDE';
  const params = new URLSearchParams(signedInitData());
  const data = Array.from(params.entries()).filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('\\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(other).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  const res = response();
  await handler(request(params.toString()), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 1);
});
