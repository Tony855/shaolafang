'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOutboxInput, retryDelaySeconds } = require('../server/services/telegram-notification-outbox-core');
const { validateResolvedRecipient, classifyTelegramError } = require('../server/services/telegram-notification-worker-core');

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

test('outbox payload stores only the rendered allowlisted message', () => {
  const row = normalizeOutboxInput({
    eventKey: 'order:store-3:42:created', recipientScope: 'merchant_store',
    recipientKey: 'store:3', merchantId: 9, storeId: 3,
    event: { type: 'order.created', storeName: 'Store A', orderNo: '42', amount: 7.5, currency: 'USD', customerToken: 'secret', note: 'private' }
  });
  assert.equal(row.merchantId, 9);
  assert.equal(row.storeId, 3);
  assert.deepEqual(JSON.parse(row.payloadJson), { text: '[FoodFlow] 新订单\n门店：Store A\n订单：42\n金额：7.50 USD' });
  assert.equal(row.payloadJson.includes('secret'), false);
  assert.equal(row.payloadJson.includes('private'), false);
});

test('outbox rejects malformed idempotency keys and tenantless non-admin recipients', () => {
  const base = { eventKey: 'x', recipientScope: 'customer', recipientKey: 'binding:1', event: { type: 'order.created', storeName: 'A', orderNo: '1', amount: 1 } };
  assert.throws(() => normalizeOutboxInput({ ...base, merchantId: null, storeId: null }), /商户编号/);
  assert.throws(() => normalizeOutboxInput({ ...base, eventKey: 'bad key', merchantId: 1, storeId: 1 }), /幂等键/);
  assert.throws(() => normalizeOutboxInput({ ...base, recipientScope: 'system_admin', merchantId: 1, storeId: null }), /系统管理员/);
});

test('retry delay is bounded exponential backoff', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelaySeconds), [15, 30, 60, 120, 240, 480, 900, 900]);
  assert.throws(() => retryDelaySeconds(0), /重试次数/);
});

test('recipient resolver enforces scope and tenant ownership', () => {
  const job = { recipient_scope: 'merchant_store', merchant_id: 9, store_id: 3 };
  assert.equal(validateResolvedRecipient(job, { scope: 'merchant_store', merchantId: 9, storeId: 3, token, chatId: '-100123' }), true);
  assert.equal(validateResolvedRecipient(job, { scope: 'merchant_store', merchantId: 10, storeId: 3, token, chatId: '-100123' }), false);
  assert.equal(validateResolvedRecipient(job, { scope: 'system_admin', merchantId: null, storeId: null, token, chatId: '-100123' }), false);
});

test('Telegram error classifier returns only fixed safe codes', () => {
  assert.equal(classifyTelegramError(new Error('无法连接 Telegram API，请检查服务器网络或稍后重试')), 'network_error');
  assert.equal(classifyTelegramError(new Error('Telegram 消息发送失败（HTTP 429）')), 'telegram_429');
  assert.equal(classifyTelegramError(new Error('Bot Token 无效或已撤销')), 'telegram_401');
  assert.equal(classifyTelegramError(new Error('Bot 无权向该 Chat ID 发送消息，请先启动 Bot 或检查群组权限')), 'telegram_403');
  assert.equal(classifyTelegramError(new Error('Chat ID 无效，或 Bot 尚未加入目标群组')), 'telegram_400');
  assert.equal(classifyTelegramError(new Error('secret token response 500 details')), 'unknown');
});
