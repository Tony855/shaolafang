'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendTelegramMessage } = require('../server/services/telegram-bot');

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

test('sends bounded business text as plain Telegram text', async () => {
  let request;
  const result = await sendTelegramMessage({
    token, chatId: '-100123', text: '[FoodFlow] 新订单\n订单：11001',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 31, chat: { id: -100123 } } }) };
    }
  });
  assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/sendMessage');
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: '-100123', text: '[FoodFlow] 新订单\n订单：11001'
  });
  assert.deepEqual(result, { messageId: 31, chatId: '-100123' });
});

test('rejects empty or oversized messages before network access', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(() => sendTelegramMessage({ token, chatId: '12345', text: '', fetchImpl }), /消息内容无效/);
  await assert.rejects(() => sendTelegramMessage({ token, chatId: '12345', text: 'x'.repeat(4097), fetchImpl }), /消息内容无效/);
  assert.equal(called, false);
});

test('does not leak raw Telegram response descriptions', async () => {
  const secret = 'sensitive-response-detail';
  await assert.rejects(() => sendTelegramMessage({
    token, chatId: '12345', text: 'safe',
    fetchImpl: async () => ({
      ok: false, status: 500,
      json: async () => ({ ok: false, error_code: 500, description: secret })
    })
  }), error => !error.message.includes(secret));
});
