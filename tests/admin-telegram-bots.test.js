'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/admin-telegram-bots');

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; }
  };
}

function setup(options = {}) {
  const routes = new Map();
  const calls = [];
  const state = { config: options.config || null, registry: [], webhooks: [], menus: [] };
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers.at(-1)); },
    put(path, ...handlers) { routes.set('PUT ' + path, handlers.at(-1)); }
  };
  const pass = (req, res, next) => next();
  registerRoutes(app, {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM merchants')) return { id: params[0] };
      if (sql.includes('FROM merchant_admins')) return { username: 'tenant-admin' };
      if (sql.includes('FROM telegram_merchant_bots')) return state.config;
      return null;
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params });
      if (sql.startsWith('DELETE FROM telegram_merchant_bot_token_registry')) state.registry = [];
      if (sql.startsWith('INSERT INTO telegram_merchant_bot_token_registry')) state.registry.push({ fingerprint: params[0], botConfigId: params[1], profile: params[2] });
      if (sql.startsWith('INSERT INTO telegram_merchant_bots')) {
        state.config = {
          id: 4, merchant_id: 7,
          client_bot_token_encrypted: params[1], client_bot_token_fingerprint: params[2],
          client_bot_username: params[3], client_bot_enabled: params[4],
          admin_bot_token_encrypted: params[5], admin_bot_token_fingerprint: params[6],
          admin_bot_username: params[7], admin_bot_enabled: params[8],
          webhook_path_hash: params[9], webhook_path_token_encrypted: params[10],
          webhook_secret_encrypted: params[11]
        };
      }
      if (sql.startsWith('UPDATE telegram_merchant_bots')) {
        Object.assign(state.config, {
          client_bot_token_encrypted: params[0], client_bot_token_fingerprint: params[1],
          client_bot_username: params[2], client_bot_enabled: params[3],
          admin_bot_token_encrypted: params[4], admin_bot_token_fingerprint: params[5],
          admin_bot_username: params[6], admin_bot_enabled: params[7]
        });
      }
      return { affectedRows: 1, ...(sql.startsWith('INSERT INTO telegram_merchant_bots') ? { lastID: 4 } : {}) };
    },
    withTransaction: async work => work(),
    requireAdminKey: pass,
    requirePermission: () => pass,
    getClientIp: () => '127.0.0.1',
    getTelegramBotUsername: async ({ token }) => {
      assert.ok(token.startsWith('12345:'));
      return 'TenantFoodBot';
    },
    configureWebhook: async input => { state.webhooks.push(input); return true; },
    configureMenuButton: async input => { state.menus.push(input); return true; }
  });
  return { routes, calls, state };
}

test('tenant Bot configuration GET never returns credentials', async () => {
  const { routes } = setup({
    config: {
      client_bot_enabled: 1, client_bot_token_encrypted: 'ciphertext', client_bot_username: 'TenantFoodBot',
      admin_bot_enabled: 0, admin_bot_token_encrypted: null, admin_bot_username: null
    }
  });
  const res = response();
  await routes.get('GET /api/admin/telegram/bot')({ merchantId: 7, isPrimaryAdmin: true }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.deepEqual(res.body, {
    configured: true,
    client: { enabled: true, tokenConfigured: true, username: 'TenantFoodBot' },
    admin: { enabled: false, tokenConfigured: false, username: null }
  });
  assert.equal(JSON.stringify(res.body).includes('ciphertext'), false);
});

test('tenant Bot configuration is primary-admin scoped and rejects non-primary admins', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/bot')({
    merchantId: 7, isPrimaryAdmin: false, body: { clientBotToken: '12345:' + 'a'.repeat(30) }
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('tenant Bot configuration encrypts credentials and stores only token fingerprints', async () => {
  const oldKey = process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
  const oldPublicUrl = process.env.FOODFLOW_PUBLIC_URL;
  process.env.TELEGRAM_BOT_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.FOODFLOW_PUBLIC_URL = 'https://foodflow.example.test';
  try {
    const { routes, calls, state } = setup();
    const clientToken = '12345:' + 'a'.repeat(30);
    const adminToken = '12345:' + 'b'.repeat(30);
    const res = response();
    await routes.get('PUT /api/admin/telegram/bot')({
      merchantId: 7, adminId: 3, isPrimaryAdmin: true,
      body: { clientBotToken: clientToken, adminBotToken: adminToken, clientBotEnabled: true, adminBotEnabled: true }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.config.client.username, 'TenantFoodBot');
    assert.equal(res.body.config.admin.username, 'TenantFoodBot');
    assert.equal(state.config.client_bot_token_encrypted.includes(clientToken), false);
    assert.equal(state.config.admin_bot_token_encrypted.includes(adminToken), false);
    assert.match(state.config.client_bot_token_fingerprint, /^[a-f0-9]{64}$/);
    assert.match(state.config.admin_bot_token_fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(state.config.webhook_path_token_encrypted);
    assert.ok(state.config.webhook_secret_encrypted);
    assert.equal(state.registry.length, 2);
    assert.deepEqual(state.registry.map(row => row.profile).sort(), ['admin', 'client']);
    assert.equal(state.webhooks.length, 1);
    assert.equal(state.webhooks[0].enabled, true);
    assert.match(state.webhooks[0].webhookUrl, /^https:\/\/foodflow\.example\.test\/api\/telegram\/tenant\/[A-Za-z0-9_-]{43}\/client\/webhook$/);
    assert.equal(state.menus.length, 1);
    assert.equal(res.body.webhookConfigured, true);
    assert.equal(JSON.stringify(calls).includes(clientToken), false);
    assert.equal(JSON.stringify(calls).includes(adminToken), false);
  } finally {
    if (oldKey === undefined) delete process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_BOT_ENCRYPTION_KEY = oldKey;
    if (oldPublicUrl === undefined) delete process.env.FOODFLOW_PUBLIC_URL;
    else process.env.FOODFLOW_PUBLIC_URL = oldPublicUrl;
  }
});

test('tenant Bot cannot be enabled without a token', async () => {
  const { routes } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/bot')({
    merchantId: 7, isPrimaryAdmin: true, body: { clientBotEnabled: true }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /必须配置 Token/);
});

test('tenant Client and Admin profiles cannot reuse the same Bot token', async () => {
  const oldKey = process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
  process.env.TELEGRAM_BOT_ENCRYPTION_KEY = '11'.repeat(32);
  try {
    const { routes } = setup();
    const token = '12345:' + 'c'.repeat(30);
    const res = response();
    await routes.get('PUT /api/admin/telegram/bot')({
      merchantId: 7, adminId: 3, isPrimaryAdmin: true,
      body: { clientBotToken: token, adminBotToken: token }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /必须使用不同/);
  } finally {
    if (oldKey === undefined) delete process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_BOT_ENCRYPTION_KEY = oldKey;
  }
});
