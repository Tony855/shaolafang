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

async function setTelegramMenuButton({ token, text = '🍽️ 外卖点餐', webAppUrl, fetchImpl = globalThis.fetch }) {
  if (!validateBotToken(token)) throw new Error('Telegram Bot Token 格式无效');
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');
  const label = String(text || '').trim();
  let parsed;
  try { parsed = new URL(String(webAppUrl || '')); } catch (_) { throw new Error('Telegram Mini App URL 无效'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.href.length > 2048) {
    throw new Error('Telegram Mini App 必须使用有效的 HTTPS 地址');
  }
  let response;
  try {
    response = await fetchImpl(`${TELEGRAM_API}/bot${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: label, web_app: { url: parsed.href } } }),
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

async function sendTelegramTestMessage({ token, chatId, fetchImpl = globalThis.fetch }) {
  return sendTelegramMessage({
    token, chatId, fetchImpl,
    text: 'FoodFlow Telegram Bot 连接测试成功。'
  });
}

module.exports = { validateBotToken, validateChatId, sendTelegramMessage, sendTelegramTestMessage, getTelegramBotUsername, setTelegramMenuButton };
