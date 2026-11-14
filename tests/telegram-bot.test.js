'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBotToken, validateChatId, sendTelegramTestMessage, getTelegramBotUsername } = require('../server/services/telegram-bot');

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const validPayload = { ok: true, result: { message_id: 17, chat: { id: -100123 } } };

test('validates bot tokens and numeric or public channel chat IDs', () => {
  assert.equal(validateBotToken(token), true);
  assert.equal(validateBotToken('bad-token'), false);
  assert.equal(validateChatId('-100123'), true);
  assert.equal(validateChatId('@foodflow_updates'), true);
  assert.equal(validateChatId('bad chat'), false);
});

test('sends a fixed test message to Telegram without exposing the token in errors', async () => {
  let request;
  const result = await sendTelegramTestMessage({
    token,
    chatId: '-100123',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => validPayload };
    }
  });
  assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/sendMessage');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {
    chat_id: '-100123',
    text: 'FoodFlow Telegram Bot 连接测试成功。'
  });
  assert.deepEqual(result, { messageId: 17, chatId: '-100123' });
});

test('rejects invalid credentials before making a network request', async () => {
  let called = false;
  await assert.rejects(
    () => sendTelegramTestMessage({ token: 'invalid', chatId: '1', fetchImpl: async () => { called = true; } }),
    /Token 格式无效/
  );
  assert.equal(called, false);
});

test('maps Telegram authorization and chat permission errors to safe messages', async () => {
  await assert.rejects(
    () => sendTelegramTestMessage({
      token, chatId: '12345',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error_code: 401, description: 'unauthorized ' + token }) })
    }),
    error => error.message === 'Telegram Bot Token 无效或已撤销' && !error.message.includes(token)
  );
  await assert.rejects(
    () => sendTelegramTestMessage({
      token, chatId: '12345',
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error_code: 403 }) })
    }),
    /无权向该 Chat ID 发送消息/
  );
});


test('resolves the configured Bot username for a deep-link without exposing API errors', async () => {
  let requestedUrl = '';
  const username = await getTelegramBotUsername({
    token,
    fetchImpl: async url => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ ok: true, result: { username: 'FoodFlowClientBot' } }) };
    }
  });
  assert.equal(username, 'FoodFlowClientBot');
  assert.equal(requestedUrl, 'https://api.telegram.org/bot' + token + '/getMe');
  await assert.rejects(() => getTelegramBotUsername({ token, fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, description: token }) }) }), /Bot 信息读取失败/);
});
