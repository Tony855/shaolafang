'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const registerCustomerDeliveryRoutes = require('../routes/customer-delivery');
const { createStoreEntrySignature } = require('../server/services/telegram-store-entry');

const token = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
const secret = 's'.repeat(40);

function signedInitData() {
  const now = Math.floor(Date.now() / 1000);
  const params = new Map([
    ['auth_date', String(now)], ['query_id', 'shared-client-test'],
    ['user', JSON.stringify({ id: 10001, first_name: 'Customer' })]
  ]);
  const data = Array.from(params.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const webAppSecret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', webAppSecret).update(data).digest('hex'));
  return new URLSearchParams(Array.from(params.entries()).sort(([a], [b]) => a < b ? -1 : 1)).toString();
}

function setup({ recipient = { id: 11, merchant_id: 7, name: 'Tenant A store', chat_id: '-100111' }, enabled = true, logger = { error() {} }, failSettings = false } = {}) {
  const handlers = new Map(), calls = [];
  const app = { get(path, handler) { handlers.set('GET ' + path, handler); }, post() {}, delete() {} };
  registerCustomerDeliveryRoutes(app, {
    getAsync: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('telegram_store_admin_recipients')) return recipient && Number(params[0]) === Number(recipient.id) ? recipient : null;
      return null;
    },
    allAsync: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM settings')) {
        if (failSettings) throw Object.assign(new Error('DO_NOT_LOG_THIS_SECRET'), { code: 'ER_ACCESS_DENIED' });
        return [
        { key: 'telegram_client_bot_enabled', value: enabled ? '1' : '0' },
        { key: 'telegram_client_bot_token', value: token }
        ];
      }
      return [];
    },
    runAsync: async () => ({ affectedRows: 1 }), withTransaction: async fn => fn(),
    normalizeOrderItems: async () => [], allocateOrderNo: async () => 'TEST',
    getOrderCooldownMs: async () => 0, checkAndSetCooldown: async () => true,
    getClientIp: () => '127.0.0.1', formatOrder: value => value,
    io: { to: () => ({ emit() {} }) }, logger
  });
  return { handler: handlers.get('GET /api/public/delivery/telegram-miniapp-stores'), calls };
}

function response() {
  return { statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
function request(storeId, entry) {
  return { query: { store_id: String(storeId), entry }, headers: {},
    get(name) { return name.toLowerCase() === 'x-telegram-init-data' ? signedInitData() : ''; } };
}

test('shared Client Bot Mini App resolves only the store represented by the signed Chat ID binding', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const { handler, calls } = setup();
  const signature = createStoreEntrySignature({ storeId: 11, chatId: '-100111', secret });
  const res = response();
  await handler(request(11, signature), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.stores.map(store => [store.id, store.merchantId]), [[11, 7]]);
  assert.ok(calls.some(call => call.sql.includes('telegram_store_admin_recipients') && call.params[0] === 11));
});

test('a store entry cannot be used to select another tenant store', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const { handler } = setup();
  const signature = createStoreEntrySignature({ storeId: 11, chatId: '-100111', secret });
  const res = response();
  await handler(request(12, signature), res);
  assert.equal(res.statusCode, 403);
});

test('shared Client Bot Mini App rejects missing signed initData before resolving the store', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const { handler, calls } = setup();
  const req = request(11, 'A'.repeat(43));
  req.get = () => '';
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});


test('Telegram Mini App store lookup logs safe failure metadata without exposing error messages', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const entries = [];
  const logger = { error: (...args) => entries.push(args) };
  const { handler } = setup({ logger, failSettings: true });
  const signature = createStoreEntrySignature({ storeId: 11, chatId: '-100111', secret });
  const res = response();
  await handler(request(11, signature), res);
  assert.equal(res.statusCode, 503);
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], '[telegram-miniapp-store-resolution] failed');
  assert.equal(entries[0][1].stage, 'bot_configuration');
  assert.equal(entries[0][1].code, 'ER_ACCESS_DENIED');
  assert.equal(JSON.stringify(entries).includes('DO_NOT_LOG_THIS_SECRET'), false);
  assert.equal(JSON.stringify(res.body).includes('DO_NOT_LOG_THIS_SECRET'), false);
});
