'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachSuperRoutes = require('../routes/super');

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

function setup(initial = {}) {
  const routes = new Map();
  const settings = new Map(Object.entries(initial));
  const writes = [];
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers.at(-1)); },
    put(path, ...handlers) { routes.set('PUT ' + path, handlers.at(-1)); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers.at(-1)); },
    delete() {}
  };
  const deps = {
    allAsync: async (_sql, keys = []) => keys.filter(key => settings.has(key)).map(key => ({ key, value: settings.get(key) })),
    getAsync: async () => null,
    runAsync: async (sql, params) => {
      writes.push({ sql, params });
      if (sql.includes('INSERT INTO settings')) settings.set(params[0], params[1]);
      return { affectedRows: 1 };
    },
    withTransaction: async fn => fn(),
    requireSuperAdmin: (_req, _res, next) => next(),
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {},
    verifyPassword: () => true,
    hashPassword: value => value,
    collectBackupData: async () => ({}),
    autoBackupDatabase: async () => ({})
  };
  attachSuperRoutes(app, deps);
  return { routes, settings, writes };
}

function response() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

test('configuration read masks tokens and never returns plaintext credentials', async () => {
  const ctx = setup({
    telegram_client_bot_enabled: '1',
    telegram_client_bot_token: token,
    telegram_client_chat_id: '-100123'
  });
  const res = response();
  await ctx.routes.get('GET /api/super/telegram/config')({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.client.configured, true);
  assert.equal(res.body.client.enabled, true);
  assert.equal(res.body.client.chat_id, '-100123');
  assert.equal(res.body.client.token_masked, '••••••••' + token.slice(-4));
  assert.equal(Object.hasOwn(res.body.admin, 'chat_id'), false);
  assert.equal(JSON.stringify(res.body).includes(token), false);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
});

test('configuration update preserves a blank token and writes separate scopes atomically', async () => {
  const ctx = setup({ telegram_client_bot_token: token });
  const res = response();
  await ctx.routes.get('PUT /api/super/telegram/config')({
    body: {
      client: { enabled: true, token: '', chat_id: '-100123' },
      admin: { enabled: false, token: '987654:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi' }
    },
    superAdmin: { id: 1, username: 'root' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.settings.get('telegram_client_bot_token'), token);
  assert.equal(ctx.settings.get('telegram_client_chat_id'), '-100123');
  assert.equal(ctx.settings.get('telegram_client_bot_enabled'), '1');
  assert.equal(ctx.settings.get('telegram_admin_bot_enabled'), '0');
  assert.equal(ctx.settings.has('telegram_admin_chat_id'), false);
});

test('rejects invalid tokens and enabled bots without a complete stored configuration', async () => {
  const ctx = setup();
  const invalid = response();
  await ctx.routes.get('PUT /api/super/telegram/config')({
    body: {
      client: { enabled: false, token: 'not-a-token', chat_id: '' },
      admin: { enabled: false, token: '' }
    }
  }, invalid);
  assert.equal(invalid.statusCode, 400);

  const incomplete = response();
  await ctx.routes.get('PUT /api/super/telegram/config')({
    body: {
      client: { enabled: true, token: '', chat_id: '' },
      admin: { enabled: false, token: '', chat_id: '' }
    }
  }, incomplete);
  assert.equal(incomplete.statusCode, 400);
});

test('saving an enabled Client Bot configures the default Telegram Mini App menu button', async () => {
  const ctx = setup({ telegram_client_bot_token: token });
  const previousUrl = process.env.FOODFLOW_PUBLIC_URL;
  const previousFetch = global.fetch;
  const requests = [];
  const previousSecret = process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET;
  process.env.FOODFLOW_PUBLIC_URL = 'https://foodflow.example.test/';
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = 'client-webhook-secret-for-tests-123456';
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  try {
    const res = response();
    await ctx.routes.get('PUT /api/super/telegram/config')({
      body: {
        client: { enabled: true, token: '', chat_id: '-100123' },
        admin: { enabled: false, token: '' }
      },
      superAdmin: { id: 1, username: 'root' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.menu_button_configured, true);
    assert.equal(res.body.webhook_configured, true);
    const menuRequest = requests.find(request => request.url.endsWith('/setChatMenuButton'));
    const webhookRequest = requests.find(request => request.url.endsWith('/setWebhook'));
    assert.equal(menuRequest.url, 'https://api.telegram.org/bot' + token + '/setChatMenuButton');
    assert.deepEqual(menuRequest.body.menu_button, {
      type: 'web_app', text: '🍽️ 外卖点餐',
      web_app: { url: 'https://foodflow.example.test/telegram/delivery' }
    });
    assert.equal(webhookRequest.url, 'https://api.telegram.org/bot' + token + '/setWebhook');
    assert.equal(webhookRequest.body.url, 'https://foodflow.example.test/api/telegram/client/webhook');
    assert.equal(webhookRequest.body.secret_token, 'client-webhook-secret-for-tests-123456');
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.FOODFLOW_PUBLIC_URL;
    else process.env.FOODFLOW_PUBLIC_URL = previousUrl;
    if (previousSecret === undefined) delete process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET;
    else process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = previousSecret;
  }
});

test('disabling Client Bot terminally suppresses only queued customer notifications', async () => {
  const ctx = setup({
    telegram_client_bot_enabled: '1',
    telegram_client_bot_token: token,
    telegram_client_chat_id: '-100123',
    telegram_admin_bot_enabled: '1',
    telegram_admin_bot_token: token
  });
  const res = response();
  await ctx.routes.get('PUT /api/super/telegram/config')({
    body: {
      client: { enabled: false, token: '', chat_id: '-100123' },
      admin: { enabled: true, token: '' }
    },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  const suppressions = ctx.writes.filter(write => write.sql.includes('UPDATE telegram_notification_outbox'));
  assert.equal(suppressions.length, 1);
  assert.match(suppressions[0].sql, /recipient_scope='customer'/);
  assert.doesNotMatch(suppressions[0].sql, /system_admin|merchant_store/);
  assert.match(suppressions[0].sql, /state IN \('pending','processing'\)/);
});

test('disabling Admin Bot terminally suppresses global and store notices but preserves customer jobs', async () => {
  const ctx = setup({
    telegram_client_bot_enabled: '1',
    telegram_client_bot_token: token,
    telegram_client_chat_id: '-100123',
    telegram_admin_bot_enabled: '1',
    telegram_admin_bot_token: token,
  });
  const res = response();
  await ctx.routes.get('PUT /api/super/telegram/config')({
    body: {
      client: { enabled: true, token: '', chat_id: '-100123' },
      admin: { enabled: false, token: '' }
    },
    superAdmin: { id: 1, username: 'root' }
  }, res);

  assert.equal(res.statusCode, 200);
  const suppressions = ctx.writes.filter(write => write.sql.includes('UPDATE telegram_notification_outbox'));
  assert.equal(suppressions.length, 1);
  assert.match(suppressions[0].sql, /recipient_scope IN \('system_admin','merchant_store'\)/);
  assert.doesNotMatch(suppressions[0].sql, /recipient_scope='customer'/);
  assert.match(suppressions[0].sql, /state IN \('pending','processing'\)/);
});

test('test endpoint sends only for enabled, saved bot configuration', async () => {
  const ctx = setup({
    telegram_admin_bot_enabled: '1',
    telegram_admin_bot_token: token,
    telegram_admin_chat_id: '12345'
  });
  const oldFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { is_bot: true, username: 'foodflow_test_bot' } }) };
  };
  try {
    const res = response();
    await ctx.routes.get('POST /api/super/telegram/admin/test')({
      params: {}
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, bot_username: 'foodflow_test_bot' });
    assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/getMe');
  } finally {
    global.fetch = oldFetch;
  }
});
