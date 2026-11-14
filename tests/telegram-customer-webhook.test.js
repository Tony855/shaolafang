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

function fixture() {
  const challenge = 'A'.repeat(43);
  const challengeHash = crypto.createHash('sha256').update(challenge).digest('hex');
  const state = { updates: new Set(), challenge: { id: 1, customer_token_hash: 'f'.repeat(64), merchant_id: 3, store_id: 8 }, bindings: [], consumed: false };
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
      if (sql.includes('UPDATE telegram_customer_bindings')) {
        const row = state.bindings.find(x => x.id === params[3]);
        if (row) Object.assign(row, { merchant_id: params[0], telegram_user_id: params[1], telegram_chat_id: params[2], is_active: 1, revoked_at: null });
        return { affectedRows: row ? 1 : 0 };
      }
      if (sql.includes('UPDATE telegram_customer_binding_challenges')) { state.consumed = true; return { affectedRows: 1 }; }
      if (sql.includes('INSERT INTO telegram_customer_bindings')) {
        if (state.bindings.some(x => x.telegram_chat_id === params[4] || (x.customer_token_hash === params[0] && x.store_id === params[2]))) {
          throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        }
        state.bindings.push({ id: 9, customer_token_hash: params[0], merchant_id: params[1], store_id: params[2], telegram_user_id: params[3], telegram_chat_id: params[4] });
        return { affectedRows: 1 };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => work(),
    getBotToken: async () => '123456:abcdefghijklmnopqrstuvwxyzABCDE',
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
