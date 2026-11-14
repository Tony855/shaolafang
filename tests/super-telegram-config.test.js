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
  assert.equal(JSON.stringify(res.body).includes(token), false);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
});

test('configuration update preserves a blank token and writes separate scopes atomically', async () => {
  const ctx = setup({ telegram_client_bot_token: token });
  const res = response();
  await ctx.routes.get('PUT /api/super/telegram/config')({
    body: {
      client: { enabled: true, token: '', chat_id: '-100123' },
      admin: { enabled: false, token: '987654:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', chat_id: '12345' }
    },
    superAdmin: { id: 1, username: 'root' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(ctx.settings.get('telegram_client_bot_token'), token);
  assert.equal(ctx.settings.get('telegram_client_chat_id'), '-100123');
  assert.equal(ctx.settings.get('telegram_client_bot_enabled'), '1');
  assert.equal(ctx.settings.get('telegram_admin_bot_enabled'), '0');
});

test('rejects invalid tokens and enabled bots without a complete stored configuration', async () => {
  const ctx = setup();
  const invalid = response();
  await ctx.routes.get('PUT /api/super/telegram/config')({
    body: {
      client: { enabled: false, token: 'not-a-token', chat_id: '' },
      admin: { enabled: false, token: '', chat_id: '' }
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
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 22 } }) };
  };
  try {
    const res = response();
    await ctx.routes.get('POST /api/super/telegram/:scope/test')({
      params: { scope: 'admin' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message_id: 22 });
    assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/sendMessage');
  } finally {
    global.fetch = oldFetch;
  }
});
