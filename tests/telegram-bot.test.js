'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBotToken, validateChatId, sendTelegramTestMessage, sendTelegramMessage, getTelegramBotUsername, getTelegramGroupChats, setTelegramMenuButton, setTelegramWebhook } = require('../server/services/telegram-bot');

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
    text: 'FoodFlow Telegram Bot 连接测试成功。',
    parse_mode: 'HTML'
  });
  assert.deepEqual(result, { messageId: 17, chatId: '-100123' });
});

test('sends a store Mini App inline keyboard as Telegram reply markup', async () => {
  let payload;
  const replyMarkup = { inline_keyboard: [[{ text: 'Open ordering', web_app: { url: 'https://foodflow.example.test/delivery-order.html?store_id=8&telegram=1' } }]] };
  await sendTelegramMessage({
    token, chatId: '98765', text: 'Open FoodFlow', replyMarkup,
    fetchImpl: async (url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 18, chat: { id: 98765 } } }) };
    }
  });
  assert.deepEqual(payload.reply_markup, replyMarkup);
});
test('sets the default customer Bot menu button to the Telegram Mini App', async () => {
  let request;
  await setTelegramMenuButton({
    token, webAppUrl: 'https://foodflow.example.test/telegram/delivery',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    }
  });
  assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/setChatMenuButton');
  assert.deepEqual(request.body, { menu_button: {
    type: 'web_app', text: '🍽️ 外卖点餐',
    web_app: { url: 'https://foodflow.example.test/telegram/delivery' }
  } });
});

test('sets a store-specific Mini App menu button only for the target private chat', async () => {
  let request;
  await setTelegramMenuButton({
    token, chatId: '98765', text: '🍽️ 本店点餐',
    webAppUrl: 'https://foodflow.example.test/delivery/order?store_id=8&entry=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&telegram=1',
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    }
  });
  assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/setChatMenuButton');
  assert.deepEqual(request.body, {
    chat_id: '98765',
    menu_button: { type: 'web_app', text: '🍽️ 本店点餐', web_app: { url: 'https://foodflow.example.test/delivery/order?store_id=8&entry=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&telegram=1' } }
  });
});

test('resets the default Bot menu button when the Client Bot is disabled', async () => {
  let body;
  await setTelegramMenuButton({
    token, enabled: false,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    }
  });
  assert.deepEqual(body, { menu_button: { type: 'commands' } });
});

test('rejects non-HTTPS Mini App menu URLs before calling Telegram', async () => {
  let called = false;
  await assert.rejects(() => setTelegramMenuButton({
    token, webAppUrl: 'http://foodflow.example.test/telegram-delivery.html',
    fetchImpl: async () => { called = true; }
  }), /HTTPS/);
  assert.equal(called, false);
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

test('marks network timeouts, unreadable responses and HTTP 5xx as ambiguous delivery outcomes', async () => {
  await assert.rejects(
    () => sendTelegramMessage({ token, chatId: '-100123', text: 'hello', fetchImpl: async () => { throw new Error('socket timeout'); } }),
    error => error.deliveryUncertain === true && !error.message.includes(token)
  );
  await assert.rejects(
    () => sendTelegramMessage({ token, chatId: '-100123', text: 'hello', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) }),
    error => error.deliveryUncertain === true
  );
  await assert.rejects(
    () => sendTelegramMessage({ token, chatId: '-100123', text: 'hello', fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error_code: 502 }) }) }),
    error => error.deliveryUncertain === true
  );
  await assert.rejects(
    () => sendTelegramMessage({ token, chatId: '-100123', text: 'hello', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 5 } }) }) }),
    error => error.deliveryUncertain !== true && error.retryAfterSeconds === 5
  );
});

test('registers the one shared Client Bot webhook with the configured secret', async () => {
  let request;
  const webhookSecret = 'client-webhook-secret-'.padEnd(40, 'x');
  await setTelegramWebhook({
    token, webhookUrl: 'https://foodflow.example.test/api/telegram/client/webhook',
    secretToken: webhookSecret,
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    }
  });
  assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/setWebhook');
  assert.deepEqual(request.body, {
    url: 'https://foodflow.example.test/api/telegram/client/webhook',
    secret_token: webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false
  });
});

test('removes the shared Client Bot webhook when disabled without dropping pending updates', async () => {
  let request;
  await setTelegramWebhook({
    token, enabled: false,
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    }
  });
  assert.equal(request.url, 'https://api.telegram.org/bot' + token + '/deleteWebhook');
  assert.deepEqual(request.body, {});
});

test('rejects insecure or weak webhook settings before contacting Telegram', async () => {
  let called = false;
  await assert.rejects(() => setTelegramWebhook({
    token, webhookUrl: 'http://foodflow.example.test/webhook', secretToken: 'x'.repeat(40),
    fetchImpl: async () => { called = true; }
  }), /HTTPS/);
  await assert.rejects(() => setTelegramWebhook({
    token, webhookUrl: 'https://foodflow.example.test/webhook', secretToken: 'short',
    fetchImpl: async () => { called = true; }
  }), /32 至 256/);
  assert.equal(called, false);
});


test('discovers group and supergroup IDs without returning message content', async () => {
  const requests = [];
  const updates = {
    ok: true,
    result: [
      { update_id: 101, message: { chat: { id: -12345, type: 'group', title: 'Kitchen Team' }, text: 'private message text' } },
      { update_id: 102, message: { chat: { id: -1009876543210, type: 'supergroup', title: 'Store Ops', username: 'store_ops' }, text: '/start' } },
      { update_id: 103, message: { chat: { id: 123456, type: 'private', first_name: 'Customer' }, text: 'hello' } }
    ]
  };
  const chats = await getTelegramGroupChats({
    token,
    fetchImpl: async url => {
      requests.push(String(url));
      return { ok: true, status: 200, json: async () => requests.length === 1 ? updates : { ok: true, result: [] } };
    }
  });
  assert.equal(chats.length, 2);
  assert.deepEqual(chats.map(chat => chat.chatId).sort(), ['-1009876543210', '-12345']);
  assert.equal(chats.find(chat => chat.chatId === '-1009876543210').type, 'supergroup');
  assert.equal(JSON.stringify(chats).includes('private message text'), false);
  assert.equal(JSON.stringify(chats).includes('Customer'), false);
  assert.match(requests[1], /offset=104/);
});

test('reports Admin Bot webhook conflict during group discovery', async () => {
  await assert.rejects(
    () => getTelegramGroupChats({
      token,
      fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error_code: 409, description: 'Conflict: webhook active' }) })
    }),
    /已配置 Webhook/
  );
});
