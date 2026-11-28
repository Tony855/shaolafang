'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const registerCustomerDeliveryRoutes = require('../routes/customer-delivery');
const { createStoreEntrySignature, verifyStoreEntrySignature, createTenantStoreEntrySignature, verifyTenantStoreEntrySignature } = require('../server/services/telegram-store-entry');
const { encryptBotToken } = require('../server/services/telegram-bot-credentials');

const token = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
const secret = 's'.repeat(40);

function signedInitData(botToken = token) {
  const now = Math.floor(Date.now() / 1000);
  const params = new Map([
    ['auth_date', String(now)], ['query_id', 'shared-client-test'],
    ['user', JSON.stringify({ id: 10001, first_name: 'Customer' })]
  ]);
  const data = Array.from(params.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const webAppSecret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', crypto.createHmac('sha256', webAppSecret).update(data).digest('hex'));
  return new URLSearchParams(Array.from(params.entries()).sort(([a], [b]) => a < b ? -1 : 1)).toString();
}

function setup({ recipient = { id: 11, merchant_id: 7, name: 'Tenant A store', chat_id: '-100111' }, binding = null, enabled = true, logger = { error() {}, warn() {} }, failSettings = false, tenantBot = null, tenantStores = [] } = {}) {
  const handlers = new Map(), calls = [];
  const app = { get(path, handler) { handlers.set('GET ' + path, handler); }, post() {}, delete() {} };
  registerCustomerDeliveryRoutes(app, {
    getAsync: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM telegram_merchant_bots')) return tenantBot;
      if (sql.includes('WHERE s.id=? AND s.merchant_id=?')) return tenantBot && Number(params[1]) === Number(tenantBot.merchant_id) ? { id: Number(params[0]), name: 'Tenant A store', merchant_id: Number(params[1]) } : null;
      if (sql.includes('telegram_store_admin_recipients')) return recipient && Number(params[0]) === Number(recipient.id) ? recipient : null;
      return null;
    },
    allAsync: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM stores s JOIN merchants m')) return tenantStores;
      if (sql.includes('FROM settings')) {
        if (failSettings) throw Object.assign(new Error('DO_NOT_LOG_THIS_SECRET'), { code: 'ER_ACCESS_DENIED' });
        return [
        { key: 'telegram_client_bot_enabled', value: enabled ? '1' : '0' },
        { key: 'telegram_client_bot_token', value: token }
        ];
      }
      if (sql.includes('FROM telegram_customer_bindings')) return binding ? [binding] : [];
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
function request(storeId, entry, bot) {
  return { query: { ...(storeId ? { store_id: String(storeId) } : {}), ...(entry ? { entry } : {}), ...(bot ? { bot } : {}) }, headers: {},
    get(name) { return name.toLowerCase() === 'x-telegram-init-data' ? signedInitData() : ''; } };
}

test('shared Client Bot Mini App resolves only the store represented by the signed Chat ID binding', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const { handler, calls } = setup();
  const signature = createStoreEntrySignature({ storeId: 11, chatId: '-100111', secret });
  const res = response();
  await handler(request(11, signature), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.stores.map(store => [store.id, store.merchantId, store.entry]), [[11, 7, signature]]);
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


test('Telegram Mini App logs safe reason codes for rejected authentication and entry stages', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const entries = [];
  const logger = { error() {}, warn: (...args) => entries.push(args) };

  const missing = setup({ logger });
  const missingRequest = request(11, 'A'.repeat(43));
  missingRequest.get = () => '';
  const missingResponse = response();
  await missing.handler(missingRequest, missingResponse);
  assert.equal(missingResponse.statusCode, 401);

  const disabled = setup({ logger, enabled: false });
  const signature = createStoreEntrySignature({ storeId: 11, chatId: '-100111', secret });
  const disabledResponse = response();
  await disabled.handler(request(11, signature), disabledResponse);
  assert.equal(disabledResponse.statusCode, 403);

  const invalidEntry = setup({ logger });
  const invalidEntryResponse = response();
  await invalidEntry.handler(request(11, 'invalid'), invalidEntryResponse);
  assert.equal(invalidEntryResponse.statusCode, 403);

  assert.deepEqual(entries.map(entry => entry[1]), [
    { stage: 'request', reason: 'missing_init_data' },
    { stage: 'bot_configuration', reason: 'legacy_bot_disabled' },
    { stage: 'entry_validation', reason: 'entry_invalid' }
  ]);
  assert.equal(JSON.stringify(entries).includes(signature), false);
  assert.equal(JSON.stringify(entries).includes(token), false);
});

test('Telegram Mini App logs when the signed store binding is missing or no longer matches', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const entries = [];
  const logger = { error() {}, warn: (...args) => entries.push(args) };
  const signature = createStoreEntrySignature({ storeId: 11, chatId: '-100111', secret });

  const missingBinding = setup({ logger, recipient: null });
  const missingResponse = response();
  await missingBinding.handler(request(11, signature), missingResponse);
  assert.equal(missingResponse.statusCode, 403);

  const changedBinding = setup({ logger, recipient: { id: 11, merchant_id: 7, name: 'Tenant A store', chat_id: '-100222' } });
  const changedResponse = response();
  await changedBinding.handler(request(11, signature), changedResponse);
  assert.equal(changedResponse.statusCode, 403);

  assert.deepEqual(entries.map(entry => entry[1]), [
    { stage: 'store_binding_lookup', reason: 'active_store_binding_missing' },
    { stage: 'store_binding_lookup', reason: 'entry_signature_mismatch' }
  ]);
  assert.equal(JSON.stringify(entries).includes('-100111'), false);
  assert.equal(JSON.stringify(entries).includes(signature), false);
});


test('global Telegram Mini App menu resolves the authenticated user latest active bound store', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const binding = { id: 11, store_id: 11, merchant_id: 7, name: 'Tenant A store', chat_id: '-100111' };
  const { handler, calls } = setup({ binding });
  const res = response();
  await handler({ query: {}, headers: {}, get(name) { return name.toLowerCase() === 'x-telegram-init-data' ? signedInitData() : ''; } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stores.length, 1);
  assert.equal(res.body.stores[0].id, 11);
  assert.equal(res.body.stores[0].merchantId, 7);
  assert.equal(verifyStoreEntrySignature({ storeId: 11, chatId: '-100111', secret, signature: res.body.stores[0].entry }), true);
  const lookup = calls.find(call => call.sql.includes('FROM telegram_customer_bindings'));
  assert.deepEqual(lookup.params, ['10001']);
  assert.match(lookup.sql, /b\.merchant_id/);
  assert.match(lookup.sql, /b\.revoked_at IS NULL/);
});

test('global Telegram Mini App menu fails with a clear onboarding message when user has no active store binding', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  const { handler } = setup();
  const res = response();
  await handler({ query: {}, headers: {}, get(name) { return name.toLowerCase() === 'x-telegram-init-data' ? signedInitData() : ''; } }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /先点击门店管理员提供的专属点餐链接/);
});

test('tenant Client Bot Mini App lists only stores owned by its resolved merchant', async () => {
  const oldKey = process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
  process.env.TELEGRAM_BOT_ENCRYPTION_KEY = '33'.repeat(32);
  try {
    const tenantToken = '987654:abcdefghijklmnopqrstuvwxyzABCDE';
    const tenantSecret = 'tenant-webhook-secret-123456789012345';
    const botPath = 'B'.repeat(43);
    const tenantBot = {
      merchant_id: 7,
      client_bot_token_encrypted: encryptBotToken(tenantToken),
      webhook_secret_encrypted: encryptBotToken(tenantSecret)
    };
    const ctx = setup({
      tenantBot,
      tenantStores: [
        { id: 11, name: 'Tenant A store 1' },
        { id: 12, name: 'Tenant A store 2' }
      ]
    });
    const res = response();
    // The signed Telegram initData must be generated with the Bot that owns this path.
    const req = request(null, null, botPath);
    req.get = name => name.toLowerCase() === 'x-telegram-init-data' ? signedInitData(tenantToken) : '';
    await ctx.handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.stores.map(x => x.id), [11, 12]);
    assert.ok(res.body.stores.every(x => x.merchantId === 7));
    assert.ok(res.body.stores.every(x => verifyTenantStoreEntrySignature({
      merchantId: 7, storeId: x.id, secret: tenantSecret, signature: x.entry
    })));
    assert.equal(ctx.calls.some(call => call.sql.includes('WHERE s.merchant_id=?') && call.params[0] === 7), true);
  } finally {
    if (oldKey === undefined) delete process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_BOT_ENCRYPTION_KEY = oldKey;
  }
});

test('tenant Bot Mini App rejects a store owned by another merchant', async () => {
  const oldKey = process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
  process.env.TELEGRAM_BOT_ENCRYPTION_KEY = '44'.repeat(32);
  try {
    const tenantToken = '987654:abcdefghijklmnopqrstuvwxyzABCDE';
    const tenantSecret = 'tenant-webhook-secret-123456789012345';
    const botPath = 'C'.repeat(43);
    const tenantBot = {
      merchant_id: 7,
      client_bot_token_encrypted: encryptBotToken(tenantToken),
      webhook_secret_encrypted: encryptBotToken(tenantSecret)
    };
    const ctx = setup({ tenantBot });
    const signature = createTenantStoreEntrySignature({ merchantId: 8, storeId: 88, secret: tenantSecret });
    const req = request(88, signature, botPath);
    req.get = name => name.toLowerCase() === 'x-telegram-init-data' ? signedInitData(tenantToken) : '';
    const res = response();
    await ctx.handler(req, res);
    assert.equal(res.statusCode, 403);
  } finally {
    if (oldKey === undefined) delete process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_BOT_ENCRYPTION_KEY = oldKey;
  }
});
