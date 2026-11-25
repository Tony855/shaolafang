'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerTelegramWebhook = require('../routes/telegram-webhook');

const secret = 'telegram-webhook-secret-for-tests';
const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const challenge = 'A'.repeat(43);

function setup({ duplicate = false, challengeRow = true, expired = false, consumed = false } = {}) {
  let handler;
  const handlers = new Map();
  const calls = [];
  const app = { post(path, fn) { handlers.set(path, fn); } };
  const deps = {
    allAsync: async () => [{ key: 'telegram_client_bot_enabled', value: '1' }, { key: 'telegram_client_bot_token', value: token }],
    getAsync: async sql => {
      calls.push(['get', sql]);
      if (sql.includes('telegram_customer_binding_challenges')) return challengeRow && !expired && !consumed ? {
        id: 5, customer_token_hash: 'a'.repeat(64), merchant_id: 7, store_id: 9,
        expires_at: new Date(Date.now() + (expired ? -60000 : 60000)), consumed_at: consumed ? new Date() : null
      } : null;
      if (sql.includes('FROM stores')) return { id: 9 };
      return null;
    },
    runAsync: async (sql, params) => {
      calls.push(['run', sql, params]);
      if (duplicate && sql.includes('INSERT INTO telegram_webhook_updates')) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      return { affectedRows: 1 };
    },
    withTransaction: async fn => fn()
  };
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  registerTelegramWebhook(app, deps);
  handler = handlers.get('/api/telegram/client/webhook');
  return { handler, tenantHandler: handlers.get('/api/telegram/client/:pathToken/webhook'), calls };
}

function response() {
  return {
    code: 200,
    status(value) { this.code = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function request(secretValue = secret) {
  return {
    headers: {},
    get(name) { return name.toLowerCase() === 'x-telegram-bot-api-secret-token' ? secretValue : undefined; },
    body: { update_id: 77, message: { text: `/start ${challenge}`, chat: { id: 12345, type: 'private' }, from: { id: 12345, is_bot: false } } }
  };
}

test('Telegram webhook rejects unauthorized updates before touching persistence', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler(request('wrong-secret'), res);
  assert.equal(res.code, 403);
  assert.equal(calls.length, 0);
});

test('Telegram webhook consumes a valid challenge and binds only the private chat', async () => {
  const { handler, calls } = setup();
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 12345 } } }) });
  try {
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(calls.some(call => call[1]?.includes('INSERT INTO telegram_customer_bindings')), true);
    assert.equal(calls.some(call => call[1]?.includes('SET consumed_at=UTC_TIMESTAMP')), true);
  } finally {
    global.fetch = oldFetch;
  }
});

test('Telegram webhook acknowledges replayed update IDs without repeating binding writes', async () => {
  const { handler, calls } = setup({ duplicate: true });
  const res = response();
  await handler(request(), res);
  assert.equal(res.code, 200);
  assert.equal(calls.some(call => call[1]?.includes('INSERT INTO telegram_customer_bindings')), false);
});

test('Telegram webhook records but does not bind an expired or unknown challenge', async () => {
  const { handler, calls } = setup({ challengeRow: false });
  const res = response();
  await handler(request(), res);
  assert.equal(res.code, 200);
  assert.equal(calls.some(call => call[1]?.includes('INSERT INTO telegram_customer_bindings')), false);
});


test('Telegram webhook refuses expired or already consumed binding challenges', async () => {
  for (const options of [{ expired: true }, { consumed: true }]) {
    const { handler, calls } = setup(options);
    const res = response();
    await handler(request(), res);
    assert.equal(res.code, 200);
    assert.equal(calls.some(call => call[1]?.includes('INSERT INTO telegram_customer_bindings')), false);
  }
});

test('tenant webhook resolves the Bot by opaque path and checks its per-Bot secret', async () => {
  const { tenantHandler, calls } = setup();
  const tenantSecret = 'tenant-secret-'.padEnd(40, 'x');
  const oldGetAsync = null;
  assert.equal(typeof tenantHandler, 'function');
  // Replace the route fixture's tenant lookup with a real tenant row by
  // wrapping the registered handler's dependencies in a separate registration.
  const tenantCalls = [];
  let route;
  registerTelegramWebhook({ post(path, fn) { if (path.includes(':pathToken')) route = fn; } }, {
    ...{
      getAsync: async (sql, params) => {
        tenantCalls.push([sql, params]);
        if (sql.includes('telegram_tenant_client_bots')) return {
          merchant_id: 7, bot_token: token, webhook_secret: tenantSecret
        };
        if (sql.includes('telegram_customer_binding_challenges')) return null;
        return null;
      },
      allAsync: async () => [],
      runAsync: async () => ({ affectedRows: 1 }),
      withTransaction: async fn => fn()
    }
  });
  const res = response();
  await route({
    params: { pathToken: 'a'.repeat(43) },
    headers: { 'x-telegram-bot-api-secret-token': tenantSecret },
    get(name) { return this.headers[name.toLowerCase()]; },
    body: { update_id: 901, message: { text: '/start AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chat: { id: 1, type: 'private' }, from: { id: 1 } } }
  }, res);
  assert.equal(res.code, 200);
  assert.equal(tenantCalls[0][1][0], 'a'.repeat(43));
  assert.match(tenantCalls[0][0], /webhook_path_token=\?/);
});

test('tenant webhook rejects a wrong secret before invoking customer handler', async () => {
  let route;
  const lookups = [];
  registerTelegramWebhook({ post(path, fn) { if (path.includes(':pathToken')) route = fn; } }, {
    getAsync: async (sql, params) => {
      lookups.push(params);
      return { merchant_id: 7, bot_token: token, webhook_secret: 'z'.repeat(40) };
    },
    allAsync: async () => [], runAsync: async () => ({ affectedRows: 1 }),
    withTransaction: async fn => fn()
  });
  const res = response();
  await route({ params: { pathToken: 'b'.repeat(43) }, headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: {} }, res);
  assert.equal(res.code, 403);
  assert.deepEqual(lookups, [['b'.repeat(43)]]);
});
