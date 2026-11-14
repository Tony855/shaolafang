'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createTelegramCustomerWebhookHandler } = require('../server/services/telegram-customer-webhook');

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function fixture({ botToken = '123456:abcdefghijklmnopqrstuvwxyzABCDE' } = {}) {
  const challenge = 'A'.repeat(43);
  const challengeHash = crypto.createHash('sha256').update(challenge).digest('hex');
  const state = { updates: new Set(), outboxSuppressions: [], challenge: { id: 1, customer_token_hash: 'f'.repeat(64), merchant_id: 3, store_id: 8, expires_at: new Date(Date.now() + 60000), consumed_at: null }, bindings: [], consumed: false };
  const handler = createTelegramCustomerWebhookHandler({
    secret: 's'.repeat(40),
    getAsync: async (sql, params) => {
      if (sql.includes('telegram_customer_binding_challenges')) return params[0] === challengeHash && !state.consumed ? state.challenge : null;
      if (sql.includes('FROM stores')) return { id: 8 };
      return null;
    },
    allAsync: async (sql, params) => {
      if (sql.includes('telegram_customer_bindings')) return state.bindings.filter(x =>
        (x.telegram_chat_id === params[0] && x.store_id === params[1]) ||
        (x.customer_token_hash === params[2] && x.store_id === params[3]));
      return [];
    },
    runAsync: async (sql, params) => {
      if (sql.includes('INSERT INTO telegram_webhook_updates')) {
        if (state.updates.has(params[0])) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        state.updates.add(params[0]); return { affectedRows: 1 };
      }
      if (sql.includes('UPDATE telegram_notification_outbox')) {
        state.outboxSuppressions.push({ sql, params });
        return { affectedRows: 1 };
      }
      if (sql.includes('UPDATE telegram_customer_bindings') && sql.includes('WHERE telegram_chat_id=? AND telegram_user_id=?')) {
        const matches = state.bindings.filter(x => x.telegram_chat_id === params[0] && String(x.telegram_user_id) === params[1] && x.is_active !== 0);
        for (const row of matches) Object.assign(row, { is_active: 0, revoked_at: new Date() });
        return { affectedRows: matches.length };
      }
      if (sql.includes('DELETE FROM telegram_customer_bindings WHERE id=?')) {
        const index = state.bindings.findIndex(x => x.id === params[0]);
        if (index >= 0) state.bindings.splice(index, 1);
        return { affectedRows: index >= 0 ? 1 : 0 };
      }
      if (sql.includes('UPDATE telegram_customer_bindings')) {
        const row = state.bindings.find(x => x.id === params[3]);
        if (row) Object.assign(row, { merchant_id: params[0], telegram_user_id: params[1], telegram_chat_id: params[2], is_active: 1, revoked_at: null });
        return { affectedRows: row ? 1 : 0 };
      }
      if (sql.includes('UPDATE telegram_customer_binding_challenges')) { state.consumed = true; return { affectedRows: 1 }; }
      if (sql.includes('INSERT INTO telegram_customer_bindings')) {
        if (state.bindings.some(x => (x.telegram_chat_id === params[4] && Number(x.store_id) === Number(params[2])) || (x.customer_token_hash === params[0] && Number(x.store_id) === Number(params[2])))) {
          throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        }
        state.bindings.push({ id: 9, customer_token_hash: params[0], merchant_id: params[1], store_id: params[2], telegram_user_id: params[3], telegram_chat_id: params[4], is_active: 1 });
        return { affectedRows: 1 };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => work(),
    getBotToken: async () => botToken,
    sendMessage: async () => ({ messageId: 1 }),
    logger: { warn() {}, error() {} }
  });
  return { handler, challenge, state };
}

test('Telegram customer webhook rejects requests without the configured secret', async () => {
  const { handler } = fixture();
  const res = response();
  await handler({ headers: {}, body: { update_id: 1 } }, res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { ok: false });
});

test('Telegram customer webhook consumes a one-time deep-link challenge and binds only the private chat', async () => {
  const { handler, challenge, state } = fixture();
  const res = response();
  await handler({
    headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
    body: { update_id: 100, message: { text: '/start ' + challenge, chat: { id: 98765, type: 'private' }, from: { id: 98765 } } }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0].store_id, 8);
  assert.equal(state.consumed, true);
});

test('Telegram customer webhook ignores duplicate update IDs and group chats', async () => {
  const { handler, challenge, state } = fixture();
  const req = {
    headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
    body: { update_id: 101, message: { text: '/start ' + challenge, chat: { id: -123, type: 'group' }, from: { id: 123 } } }
  };
  await handler(req, response());
  await handler(req, response());
  assert.equal(state.bindings.length, 0);
  assert.equal(state.updates.size, 0);
});


test('Telegram customer webhook safely reactivates the same revoked owner binding', async () => {
  const { handler, challenge, state } = fixture();
  state.bindings.push({ id: 9, customer_token_hash: 'f'.repeat(64), merchant_id: 3, store_id: 8, telegram_user_id: '98765', telegram_chat_id: '98765', is_active: 0, revoked_at: new Date() });
  const res = response();
  await handler({
    headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
    body: { update_id: 102, message: { text: '/start ' + challenge, chat: { id: 98765, type: 'private' }, from: { id: 98765 } } }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.bindings.length, 1);
  assert.equal(state.bindings[0].is_active, 1);
  assert.equal(state.bindings[0].revoked_at, null);
});


test('Telegram customer webhook deduplicates a replayed valid update after binding', async () => {
  const { handler, challenge, state } = fixture();
  const req = {
    headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
    body: { update_id: 103, message: { text: '/start ' + challenge, chat: { id: 98765, type: 'private' }, from: { id: 98765 } } }
  };
  const first = response();
  const replay = response();
  await handler(req, first);
  await handler(req, replay);
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(state.bindings.length, 1);
  assert.equal(state.updates.size, 1);
});


test('Telegram challenge expiry is evaluated by UTC SQL, not local parsing of DATETIME', async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Phnom_Penh';
  try {
    const { handler, challenge, state } = fixture();
    const utcFuture = new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    state.challenge.expires_at = utcFuture;
    assert.ok(new Date(utcFuture).getTime() < Date.now(), 'the UTC DATETIME string would be misread as local time');
    const res = response();
    await handler({
      headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
      body: { update_id: 104, message: { text: '/start ' + challenge, chat: { id: 98766, type: 'private' }, from: { id: 98766 } } }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(state.bindings.length, 1);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});


test('Telegram customer can revoke all active bindings for their private chat with /stop', async () => {
  const { handler, state } = fixture();
  state.bindings.push(
    { id: 9, customer_token_hash: 'f'.repeat(64), merchant_id: 3, store_id: 8, telegram_user_id: '98765', telegram_chat_id: '98765', is_active: 1 },
    { id: 10, customer_token_hash: 'e'.repeat(64), merchant_id: 4, store_id: 12, telegram_user_id: '98765', telegram_chat_id: '98765', is_active: 1 },
    { id: 11, customer_token_hash: 'd'.repeat(64), merchant_id: 3, store_id: 8, telegram_user_id: '11111', telegram_chat_id: '11111', is_active: 1 }
  );
  let sent = '';
  const handlerWithCapture = createTelegramCustomerWebhookHandler({
    secret: 's'.repeat(40),
    getAsync: async () => null,
    allAsync: async () => [],
    runAsync: async (sql, params) => {
      if (sql.includes('INSERT INTO telegram_webhook_updates')) { state.updates.add(params[0]); return { affectedRows: 1 }; }
      if (sql.includes('UPDATE telegram_notification_outbox')) { state.outboxSuppressions.push({ sql, params }); return { affectedRows: 1 }; }
      if (sql.includes('UPDATE telegram_customer_bindings') && sql.includes('WHERE telegram_chat_id=? AND telegram_user_id=?')) {
        const matches = state.bindings.filter(x => x.telegram_chat_id === params[0] && String(x.telegram_user_id) === params[1] && x.is_active !== 0);
        for (const row of matches) row.is_active = 0;
        return { affectedRows: matches.length };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => work(),
    getBotToken: async () => '123456:abcdefghijklmnopqrstuvwxyzABCDE',
    sendMessage: async input => { sent = input.text; return { messageId: 2 }; },
    logger: { warn() {}, error() {} }
  });
  const res = response();
  await handlerWithCapture({
    headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
    body: { update_id: 105, message: { text: '/stop', chat: { id: 98765, type: 'private' }, from: { id: 98765, is_bot: false } } }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.bindings[0].is_active, 0);
  assert.equal(state.bindings[1].is_active, 0);
  assert.equal(state.bindings[2].is_active, 1);
  assert.equal(state.outboxSuppressions.length, 1);
  assert.match(state.outboxSuppressions[0].sql, /last_error_code='binding_revoked'/);
  assert.match(state.outboxSuppressions[0].sql, /telegram_customer_bindings/);
  assert.match(sent, /已取消/);
});

test('Telegram customer /stop still revokes bindings when the Client Bot is disabled', async () => {
  const { handler, state } = fixture({ botToken: '' });
  state.bindings.push({
    id: 12, customer_token_hash: 'c'.repeat(64), merchant_id: 3, store_id: 8,
    telegram_user_id: '98765', telegram_chat_id: '98765', is_active: 1
  });
  const res = response();
  await handler({
    headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
    body: { update_id: 106, message: { text: '/stop', chat: { id: 98765, type: 'private' }, from: { id: 98765, is_bot: false } } }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.bindings[0].is_active, 0);
  assert.equal(state.outboxSuppressions.length, 1);
  assert.equal(state.updates.has(106), true);
});

test('Telegram customer can rebind the same private chat to a newly scanned customer session', async () => {
  const { handler, challenge, state } = fixture();
  state.bindings.push(
    { id: 8, customer_token_hash: 'a'.repeat(64), merchant_id: 3, store_id: 8, telegram_user_id: '98765', telegram_chat_id: '98765', is_active: 1 },
    { id: 10, customer_token_hash: 'd'.repeat(64), merchant_id: 4, store_id: 12, telegram_user_id: '98765', telegram_chat_id: '98765', is_active: 1 }
  );
  const res = response();
  await handler({
    headers: { 'x-telegram-bot-api-secret-token': 's'.repeat(40) },
    body: { update_id: 107, message: { text: '/start ' + challenge, chat: { id: 98765, type: 'private' }, from: { id: 98765, is_bot: false } } }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.bindings.length, 2);
  const currentStoreBinding = state.bindings.find(row => Number(row.store_id) === 8);
  const otherStoreBinding = state.bindings.find(row => Number(row.store_id) === 12);
  assert.equal(currentStoreBinding.id, 9);
  assert.equal(currentStoreBinding.customer_token_hash, 'f'.repeat(64));
  assert.equal(currentStoreBinding.telegram_chat_id, '98765');
  assert.equal(currentStoreBinding.is_active, 1);
  assert.equal(otherStoreBinding.id, 10);
  assert.equal(otherStoreBinding.customer_token_hash, 'd'.repeat(64));
});
