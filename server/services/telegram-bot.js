'use strict';

const TELEGRAM_API = 'https://api.telegram.org';

function validateBotToken(token) {
  return typeof token === 'string' && token.length <= 128 && /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token);
}

function validateChatId(chatId) {
  return typeof chatId === 'string' &&
    ( /^-?\d{1,20}$/.test(chatId) || /^@[A-Za-z0-9_]{5,32}$/.test(chatId) );
}

async function sendTelegramMessage({ token, chatId, text, replyMarkup, fetchImpl = globalThis.fetch }) {
  if (!validateBotToken(token)) throw new Error('Telegram Bot Token 格式无效');
  if (!validateChatId(chatId)) throw new Error('Telegram Chat ID 格式无效');
  if (typeof text !== 'string' || !text.trim() || text.length > 4096) {
    throw new Error('Telegram 消息内容无效');
  }
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');

  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (_) {
    const error = new Error('无法连接 Telegram API，请检查服务器网络或稍后重试');
    error.deliveryUncertain = true;
    throw error;
  }

  let payload;
  try { payload = await response.json(); }
  catch (_) {
    const error = new Error('Telegram API 返回了无法识别的响应');
    error.deliveryUncertain = true;
    throw error;
  }

  if (!response.ok || payload?.ok !== true) {
    const code = Number(payload?.error_code || response.status);
    if (code === 401) throw new Error('Telegram Bot Token 无效或已撤销');
    if (code === 403) throw new Error('Bot 无权向该 Chat ID 发送消息，请先启动 Bot 或检查群组权限');
    if (code === 400) throw new Error('Chat ID 无效，或 Bot 尚未加入目标群组');
    const error = new Error('Telegram 消息发送失败（HTTP ' + code + '）');
    // A server-side failure can occur after Telegram accepted the message.
    // Treat it as ambiguous rather than retrying and risking a duplicate.
    if (code >= 500) error.deliveryUncertain = true;
    // Telegram supplies parameters.retry_after for flood-control responses.
    // Keep only a bounded integer; never retain or expose the raw API payload.
    const retryAfter = payload?.parameters?.retry_after;
    if (code === 429 && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
      error.retryAfterSeconds = Math.min(retryAfter, 3600);
    }
    throw error;
  }

  return {
    messageId: Number(payload.result?.message_id) || null,
    chatId: String(payload.result?.chat?.id ?? chatId)
  };
}


async function getTelegramGroupChats({ token, fetchImpl = globalThis.fetch }) {
  if (!validateBotToken(token)) throw new Error('Telegram Bot Token 格式无效');
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');
  const allowedUpdates = encodeURIComponent(JSON.stringify(['message', 'edited_message', 'my_chat_member']));
  const base = `${TELEGRAM_API}/bot${token}/getUpdates`;
  let response;
  try {
    response = await fetchImpl(`${base}?limit=100&timeout=0&allowed_updates=${allowedUpdates}`, {
      method: 'GET', signal: AbortSignal.timeout(10000)
    });
  } catch (_) {
    throw new Error('无法连接 Telegram API，请检查服务器网络或稍后重试');
  }
  let payload;
  try { payload = await response.json(); } catch (_) { throw new Error('Telegram API 返回了无法识别的响应'); }
  if (!response.ok || payload?.ok !== true) {
    const code = Number(payload?.error_code || response.status);
    if (code === 401) throw new Error('Telegram Admin Bot Token 无效或已撤销');
    if (code === 409) throw new Error('Admin Bot 已配置 Webhook，无法使用群组自动发现；请先检查 Bot 是否被其他服务接管');
    throw new Error('Telegram 群组读取失败（HTTP ' + code + '）');
  }

  const updates = Array.isArray(payload.result) ? payload.result : [];
  const chats = new Map();
  let maxUpdateId = -1;
  for (const update of updates) {
    if (Number.isSafeInteger(update?.update_id)) maxUpdateId = Math.max(maxUpdateId, update.update_id);
    const message = update?.message || update?.edited_message || update?.channel_post;
    const chat = message?.chat || update?.my_chat_member?.chat;
    if (!chat || !['group', 'supergroup'].includes(String(chat.type || ''))) continue;
    const chatId = String(chat.id ?? '');
    if (!/^-\d{1,20}$/.test(chatId)) continue;
    chats.set(chatId, {
      chatId,
      title: String(chat.title || '未命名群组').slice(0, 255),
      type: String(chat.type),
      username: typeof chat.username === 'string' ? chat.username.slice(0, 32) : ''
    });
  }

  // Confirm only the updates returned by this read, preventing the Admin Bot
  // update queue from growing indefinitely. The Admin Bot must not be shared
  // with another webhook/getUpdates consumer.
  if (maxUpdateId >= 0) {
    try {
      const ack = await fetchImpl(`${base}?offset=${maxUpdateId + 1}&limit=1&timeout=0&allowed_updates=${allowedUpdates}`, {
        method: 'GET', signal: AbortSignal.timeout(10000)
      });
      const ackPayload = await ack.json();
      if (!ack.ok || ackPayload?.ok !== true) throw new Error('ack_failed');
    } catch (_) {
      // Discovery results remain useful; a later read may show the same chats again.
    }
  }
  return Array.from(chats.values()).sort((a, b) => a.title.localeCompare(b.title));
}

async function getTelegramBotUsername({ token, fetchImpl = globalThis.fetch }) {
  if (!validateBotToken(token)) throw new Error('Telegram Bot Token 格式无效');
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token}/getMe`, { method: 'GET', signal: AbortSignal.timeout(10000) });
  } catch (_) {
    throw new Error('无法连接 Telegram API，请检查服务器网络或稍后重试');
  }
  let payload;
  try { payload = await response.json(); } catch (_) { throw new Error('Telegram API 返回了无法识别的响应'); }
  const username = String(payload?.result?.username || '');
  if (!response.ok || payload?.ok !== true || !/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new Error('Telegram Bot 信息读取失败');
  }
  return username;
}

async function setTelegramMenuButton({ token, chatId, text = '🍽️ 外卖点餐', webAppUrl, enabled = true, fetchImpl = globalThis.fetch }) {
  if (!validateBotToken(token)) throw new Error('Telegram Bot Token 格式无效');
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');
  let menuButton = { type: 'commands' };
  if (enabled) {
    let parsed;
    try { parsed = new URL(String(webAppUrl || '')); } catch (_) { throw new Error('Telegram Mini App URL 无效'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.href.length > 2048) {
      throw new Error('Telegram Mini App 必须使用有效的 HTTPS 地址');
    }
    menuButton = { type: 'web_app', text: String(text || '').trim(), web_app: { url: parsed.href } };
  }
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(chatId !== undefined && chatId !== null ? { chat_id: String(chatId) } : {}), menu_button: menuButton }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (_) {
    throw new Error('无法连接 Telegram API，菜单按钮配置未确认');
  }
  let payload;
  try { payload = await response.json(); } catch (_) { throw new Error('Telegram API 返回了无法识别的响应'); }
  if (!response.ok || payload?.ok !== true) {
    const code = Number(payload?.error_code || response.status);
    if (code === 401) throw new Error('Telegram Bot Token 无效或已撤销');
    throw new Error('Telegram 菜单按钮配置失败（HTTP ' + code + '）');
  }
  return true;
}

async function setTelegramWebhook({ token, webhookUrl, secretToken, enabled = true, fetchImpl = globalThis.fetch }) {
  if (!validateBotToken(token)) throw new Error('Telegram Bot Token 格式无效');
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');

  let endpoint = 'deleteWebhook';
  let body = {};
  if (enabled) {
    let parsed;
    try { parsed = new URL(String(webhookUrl || '')); } catch (_) { throw new Error('Telegram Webhook URL 无效'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.href.length > 2048) {
      throw new Error('Telegram Webhook 必须使用有效的 HTTPS 地址');
    }
    if (typeof secretToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secretToken)) {
      throw new Error('TELEGRAM_CLIENT_WEBHOOK_SECRET 必须为 32 至 256 位安全字符');
    }
    endpoint = 'setWebhook';
    body = { url: parsed.href, secret_token: secretToken, allowed_updates: ['message'], drop_pending_updates: false };
  }

  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
  } catch (_) {
    throw new Error('无法连接 Telegram API，Webhook 配置未确认');
  }
  let payload;
  try { payload = await response.json(); } catch (_) { throw new Error('Telegram API 返回了无法识别的响应'); }
  if (!response.ok || payload?.ok !== true) {
    const code = Number(payload?.error_code || response.status);
    if (code === 401) throw new Error('Telegram Bot Token 无效或已撤销');
    throw new Error('Telegram Webhook 配置失败（HTTP ' + code + '）');
  }
  return true;
}

async function sendTelegramTestMessage({ token, chatId, fetchImpl = globalThis.fetch }) {
  return sendTelegramMessage({
    token, chatId, fetchImpl,
    text: 'FoodFlow Telegram Bot 连接测试成功。'
  });
}

module.exports = { validateBotToken, validateChatId, sendTelegramMessage, sendTelegramTestMessage, getTelegramBotUsername, getTelegramGroupChats, setTelegramMenuButton, setTelegramWebhook };
