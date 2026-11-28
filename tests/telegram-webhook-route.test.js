'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerTelegramWebhook = require('../routes/telegram-webhook');

const secret = 'telegram-webhook-secret-for-tests';
const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const pathToken = 'P'.repeat(43);
const challenge = 'A'.repeat(43);

function setup({ duplicate = false, challengeRow = true, expired = false, consumed = false } = {}) {
  let handler;
  const handlers = new Map();
  const calls = [];
  const app = { post(path, fn) { handlers.set(path, fn); } };
  const deps = {
    allAsync: async (sql, params = []) => {
      calls.push(['all', sql, params]);
      if (sql.includes('FROM telegram_customer_bindings')) return [{ id: 31 }];
      return [{ key: 'telegram_client_bot_enabled', value: '1' }, { key: 'telegram_client_bot_token', value: token }];
    },
    getAsync: async (sql, params = []) => {
      calls.push(['get', sql, params]);
      if (sql.includes('telegram_merchant_bots')) return { id: 22, merchant_id: 7, client_bot_token_encrypted: 'encrypted-token', webhook_path_token_encrypted: 'encrypted-path', webhook_secret_encrypted: 'encrypted-secret' };
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
    withTransaction: async fn => fn(),
    decryptCredential: value => value === 'encrypted-token' ? token : value === 'encrypted-path' ? pathToken : secret
  };
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = secret;
  registerTelegramWebhook(app, deps);
  handler = handlers.get('/api/telegram/client/webhook');
  return { handler, tenantHandler: handlers.get('/api/telegram/tenant/:pathToken/client/webhook'), calls, handlers };
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

test('legacy shared webhook remains registered alongside the tenant webhook route', () => {
  const { handler, tenantHandler } = setup();
  assert.equal(typeof handler, 'function');
  assert.equal(typeof tenantHandler, 'function');
});

test('tenant webhook resolves its Bot config by the hashed path token and scopes binding writes', async () => {
  const { tenantHandler, calls } = setup();
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: 12345 } } }) });
  try {
    const req = request();
    req.params = { pathToken };
    const res = response();
    await tenantHandler(req, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { ok: true });
    const configLookup = calls.find(call => call[1]?.includes('FROM telegram_merchant_bots'));
    assert.ok(configLookup);
    assert.deepEqual(configLookup[2], [require('crypto').createHash('sha256').update(pathToken).digest('hex')]);
    const dedupe = calls.find(call => call[1]?.includes('INSERT INTO telegram_merchant_webhook_updates'));
    assert.ok(dedupe);
    assert.deepEqual(dedupe[2], [22, 77]);
    const challengeLookup = calls.find(call => call[1]?.includes('FROM telegram_customer_binding_challenges'));
    assert.ok(challengeLookup[1].includes('merchant_id=?'));
    assert.deepEqual(challengeLookup[2], [require('crypto').createHash('sha256').update(challenge).digest('hex'), 7]);
  } finally {
    global.fetch = oldFetch;
  }
});

test('tenant webhook rejects malformed path tokens before database access', async () => {
  const { tenantHandler, calls } = setup();
  const req = request();
  req.params = { pathToken: 'short' };
  const res = response();
  await tenantHandler(req, res);
  assert.equal(res.code, 404);
  assert.equal(calls.length, 0);
});

test('tenant /stop revokes only bindings owned by the resolved merchant', async () => {
  const { tenantHandler, calls } = setup();
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, result: { message_id: 2, chat: { id: 12345 } } }) });
  try {
    const req = request();
    req.params = { pathToken };
    req.body.message.text = '/stop';
    const res = response();
    await tenantHandler(req, res);
    assert.equal(res.code, 200);
    const bindingLock = calls.find(call => call[0] === 'all' && call[1].includes('FROM telegram_customer_bindings'));
    assert.ok(bindingLock[1].includes('WHERE merchant_id=? AND telegram_chat_id=? AND telegram_user_id=?'));
    assert.deepEqual(bindingLock[2], [7, '12345', '12345']);
    const revoke = calls.find(call => call[0] === 'run' && call[1].includes('UPDATE telegram_customer_bindings SET is_active=0'));
    assert.ok(revoke[1].includes('WHERE merchant_id=? AND telegram_chat_id=? AND telegram_user_id=?'));
    assert.deepEqual(revoke[2], [7, '12345', '12345']);
  } finally {
    global.fetch = oldFetch;
  }
});
