'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const registerRoutes = require('../routes/customer-delivery');
const { createStoreEntrySignature } = require('../server/services/telegram-store-entry');
const { encryptBotToken } = require('../server/services/telegram-bot-credentials');

const botToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const customerToken = 'a'.repeat(64);

function signedInitData(token = botToken) {
  const authDate = String(Math.floor(Date.now() / 1000));
  const values = new Map([
    ['auth_date', authDate],
    ['query_id', 'AAE-test-query'],
    ['user', JSON.stringify({ id: 987654321, first_name: 'Test' })]
  ]);
  const data = Array.from(values.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  values.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return new URLSearchParams(Array.from(values.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)).toString();
}

function setup({ enabled = true, secret = 's'.repeat(40), bound = false, tenantBot = null } = {}) {
  const handlers = new Map();
  const calls = [];
  let bindingRows = bound ? [{ id: 41 }] : [];
  const app = {
    get(path, ...fns) { handlers.set('GET ' + path, fns[fns.length - 1]); },
    post(path, ...fns) { handlers.set('POST ' + path, fns[fns.length - 1]); },
    delete(path, ...fns) { handlers.set('DELETE ' + path, fns[fns.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM telegram_merchant_bots')) return tenantBot;
      if (sql.includes('FROM telegram_tenant_client_bots')) return { bot_token: botToken };
      if (sql.includes('FROM telegram_store_admin_recipients')) return params[0] === 7 ? { id: 7, name: 'Test Store', merchant_id: 3, chat_id: '-100777' } : null;
      if (sql.includes('FROM stores s JOIN merchants')) return { id: 7, name: 'Test Store', merchant_id: 3 };
      if (sql.includes('FROM telegram_customer_bindings')) return bindingRows[0] || null;
      return null;
    },
    allAsync: async (sql, params = []) => {
      calls.push({ type: 'all', sql, params });
      if (sql.includes('FROM settings')) return [
        { key: 'telegram_client_bot_enabled', value: enabled ? '1' : '0' },
        { key: 'telegram_client_bot_token', value: botToken }
      ];
      if (sql.includes('FROM stores s JOIN merchants')) return [{ id: 7, merchant_id: 3, name: 'Test Store' }, { id: 9, merchant_id: 3, name: 'Second Store' }];
      if (sql.includes('FROM telegram_customer_bindings')) return bindingRows;
      return [];
    },
    runAsync: async (sql, params = []) => { calls.push({ type: 'run', sql, params }); return { affectedRows: 1 }; },
    withTransaction: async fn => fn(),
    normalizeOrderItems: async items => items,
    allocateOrderNo: async () => '11GL00001',
    getOrderCooldownMs: async () => 1000,
    checkAndSetCooldown: async () => true,
    getClientIp: () => '127.0.0.1',
    formatOrder: row => row,
    io: { to() { return { emit() {} }; } }
  };
  if (secret) process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  else delete process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET;
  registerRoutes(app, deps);
  return { handlers, calls, setBindings(rows) { bindingRows = rows; } };
}

function response() {
  return { statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function request({ query = {}, body = {}, token = customerToken, initData = '' } = {}) {
  return { query, body, headers: {}, get(name) { if (name.toLowerCase() === 'x-customer-token') return token; if (name.toLowerCase() === 'x-telegram-init-data') return initData; return ''; } };
}

test('Telegram Mini App resolves only the store whose Chat ID binding signs the entry link', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = 's'.repeat(40);
  const ctx = setup();
  const handler = ctx.handlers.get('GET /api/public/delivery/telegram-miniapp-stores');
  const signature = createStoreEntrySignature({ storeId: 7, chatId: '-100777', secret: process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET });
  const req = request({ initData: signedInitData() });
  req.query = { store_id: '7', entry: signature };
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { stores: [{ id: 7, merchantId: 3, name: 'Test Store', entry: signature }] });
  assert.match(res.headers['Cache-Control'], /no-store/);
});

test('delivery customer Telegram binding status is scoped to the store and hashed customer identity', async () => {
  const ctx = setup({ bound: true });
  const res = response();
  await ctx.handlers.get('GET /api/public/delivery/customer-telegram/binding')(request({ query: { store_id: '7' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { bound: true });
  const lookup = ctx.calls.find(call => call.type === 'get' && call.sql.includes('telegram_customer_bindings'));
  assert.deepEqual(lookup.params, [require('../server/services/session-token').hashSessionToken(customerToken), 3, 7]);
  assert.match(res.headers['Cache-Control'], /no-store/);
});

test('delivery customer Telegram binding rejects malformed customer credentials', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handlers.get('GET /api/public/delivery/customer-telegram/binding')(request({ query: { store_id: '7' }, token: 'short' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(ctx.calls.some(call => call.sql?.includes('telegram_customer_bindings')), false);
});

test('delivery customer Telegram binding start creates a short-lived one-time deep link', async () => {
  const ctx = setup();
  const originalFetch = global.fetch;
  global.fetch = async url => {
    assert.equal(String(url), 'https://api.telegram.org/bot' + botToken + '/getMe');
    return { ok: true, json: async () => ({ ok: true, result: { username: 'FoodFlowCustomerBot' } }) };
  };
  try {
    const res = response();
    await ctx.handlers.get('POST /api/public/delivery/customer-telegram/binding/start')(request({ body: { store_id: 7 } }), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.deepLink, /^https:\/\/t\.me\/FoodFlowCustomerBot\?start=[A-Za-z0-9_-]{43}$/);
    assert.equal(res.body.expiresInSeconds, 600);
    const insert = ctx.calls.find(call => call.type === 'run' && call.sql.includes('INSERT INTO telegram_customer_binding_challenges'));
    assert.ok(insert);
    assert.equal(insert.params[1], require('../server/services/session-token').hashSessionToken(customerToken));
    assert.equal(insert.params[2], 3);
    assert.equal(insert.params[3], null);
    assert.equal(insert.params[4], 7);
  } finally {
    global.fetch = originalFetch;
  }
});

test('delivery customer Telegram binding start fails closed when the webhook secret is missing', async () => {
  const ctx = setup({ secret: '' });
  const res = response();
  await ctx.handlers.get('POST /api/public/delivery/customer-telegram/binding/start')(request({ body: { store_id: 7 } }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(ctx.calls.some(call => call.sql?.includes('INSERT INTO telegram_customer_binding_challenges')), false);
});

test('delivery customer Telegram unbind dead-letters queued notices before revoking the binding', async () => {
  const ctx = setup({ bound: true });
  const res = response();
  await ctx.handlers.get('DELETE /api/public/delivery/customer-telegram/binding')(request({ query: { store_id: '7' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.revoked, true);
  const deadLetter = ctx.calls.find(call => call.type === 'run' && call.sql.includes("last_error_code='binding_revoked'"));
  assert.ok(deadLetter);
  const revoke = ctx.calls.find(call => call.type === 'run' && call.sql.includes('UPDATE telegram_customer_bindings'));
  assert.ok(revoke);
});

test('customer binding deep link uses the tenant-owned Client Bot without reading the shared Bot settings', async () => {
  const oldKey = process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
  process.env.TELEGRAM_BOT_ENCRYPTION_KEY = '66'.repeat(32);
  const tenantToken = '765432:abcdefghijklmnopqrstuvwxyzABCDE';
  const tenantSecret = 'tenant-webhook-secret-123456789012345';
  const tenantBot = {
    id: 5,
    client_bot_enabled: 1,
    client_bot_username: 'TenantFoodBot',
    client_bot_token_encrypted: encryptBotToken(tenantToken),
    webhook_secret_encrypted: encryptBotToken(tenantSecret)
  };
  const ctx = setup({ tenantBot });
  const originalFetch = global.fetch;
  global.fetch = async url => {
    assert.equal(String(url), 'https://api.telegram.org/bot' + tenantToken + '/getMe');
    return { ok: true, json: async () => ({ ok: true, result: { username: 'TenantFoodBot' } }) };
  };
  try {
    const res = response();
    await ctx.handlers.get('POST /api/public/delivery/customer-telegram/binding/start')(request({ body: { store_id: 7 } }), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.deepLink, /^https:\/\/t\.me\/TenantFoodBot\?start=[A-Za-z0-9_-]{43}$/);
    assert.equal(ctx.calls.some(call => call.sql.includes('FROM telegram_merchant_bots') && call.params[0] === 3), true);
    const challengeInsert = ctx.calls.find(call => call.sql.includes('INSERT INTO telegram_customer_binding_challenges'));
    assert.equal(challengeInsert.params[3], 5);
    assert.equal(ctx.calls.some(call => call.sql.includes('FROM settings')), false);
  } finally {
    global.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_BOT_ENCRYPTION_KEY = oldKey;
  }
});
