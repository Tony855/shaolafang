'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const registerCustomerDeliveryRoutes = require('../routes/customer-delivery');

const tokenA = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
const tokenB = '654321:zyxwvutsrqponmlkjihgfedcbaABCDE';
const now = Math.floor(Date.now() / 1000);

function signedInitData(token, userId = 10001) {
  const params = new Map([
    ['auth_date', String(now)],
    ['query_id', 'tenant-test-query'],
    ['user', JSON.stringify({ id: userId, first_name: 'Tenant' })]
  ]);
  const data = Array.from(params.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return new URLSearchParams(params).toString();
}

function setup({ botToken = tokenA, enabled = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = {
    get(path, handler) { handlers.set('GET ' + path, handler); },
    post(path, handler) { handlers.set('POST ' + path, handler); },
    delete(path, handler) { handlers.set('DELETE ' + path, handler); }
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push(['get', sql, params]);
      if (sql.includes('telegram_tenant_client_bots')) return enabled ? { bot_token: Number(params?.[0]) === 8 ? tokenB : botToken } : null;
      return null;
    },
    allAsync: async (sql, params) => {
      calls.push(['all', sql, params]);
      if (sql.includes('FROM stores')) return [
        { id: 11, name: 'Tenant store' },
        { id: 12, name: 'Another tenant store' }
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

function request(merchantId, initData) {
  return {
    query: { merchant_id: merchantId },
    headers: { 'x-telegram-init-data': initData },
    get(name) { return this.headers[name.toLowerCase()]; }
  };
}

test('Mini App store listing requires tenant selector and signed Telegram identity', async () => {
  const { handler, calls } = setup();
  const missing = response();
  await handler(request('', signedInitData(tokenA)), missing);
  assert.equal(missing.statusCode, 401);
  assert.equal(calls.length, 0);

  const unsigned = response();
  await handler(request('7', ''), unsigned);
  assert.equal(unsigned.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('Mini App store listing returns only stores belonging to verified merchant', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler(request('7', signedInitData(tokenA)), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.merchantId, 7);
  assert.deepEqual(res.body.stores.map(store => store.id), [11, 12]);
  const query = calls.find(call => call[0] === 'all');
  assert.match(query[1], /s\.merchant_id=\?/);
  assert.deepEqual(query[2], [7]);
  const botLookup = calls.find(call => call[0] === 'get');
  assert.match(botLookup[1], /merchant_id=\?/);
  assert.deepEqual(botLookup[2], [7]);
});

test('Mini App rejects initData signed by another tenant bot', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler(request('7', signedInitData(tokenB)), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some(call => call[0] === 'all'), false);
});

test('Mini App rejects disabled tenant bot before querying stores', async () => {
  const { handler, calls } = setup({ enabled: false });
  const res = response();
  await handler(request('7', signedInitData(tokenA)), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some(call => call[0] === 'all'), false);
});

test('changing merchant_id to another tenant cannot reuse the first tenant signature', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler(request('8', signedInitData(tokenA)), res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some(call => call[0] === 'all'), false);
  const botLookup = calls.find(call => call[0] === 'get');
  assert.deepEqual(botLookup[2], [8]);
});
