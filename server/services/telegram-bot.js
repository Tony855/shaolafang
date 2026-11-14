'use strict';

const TELEGRAM_API = 'https://api.telegram.org';

function validateBotToken(token) {
  return typeof token === 'string' && token.length <= 128 && /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token);
}

function validateChatId(chatId) {
  return typeof chatId === 'string' &&
    ( /^-?\d{1,20}$/.test(chatId) || /^@[A-Za-z0-9_]{5,32}$/.test(chatId) );
}

async function sendTelegramMessage({ token, chatId, text, fetchImpl = globalThis.fetch }) {
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
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (_) {
    throw new Error('无法连接 Telegram API，请检查服务器网络或稍后重试');
  }

  let payload;
  try { payload = await response.json(); }
  catch (_) { throw new Error('Telegram API 返回了无法识别的响应'); }

  if (!response.ok || payload?.ok !== true) {
    const code = Number(payload?.error_code || response.status);
    if (code === 401) throw new Error('Telegram Bot Token 无效或已撤销');
    if (code === 403) throw new Error('Bot 无权向该 Chat ID 发送消息，请先启动 Bot 或检查群组权限');
    if (code === 400) throw new Error('Chat ID 无效，或 Bot 尚未加入目标群组');
    throw new Error('Telegram 消息发送失败（HTTP ' + code + '）');
  }

  return {
    messageId: Number(payload.result?.message_id) || null,
    chatId: String(payload.result?.chat?.id ?? chatId)
  };
}

async function sendTelegramTestMessage({ token, chatId, fetchImpl = globalThis.fetch }) {
  return sendTelegramMessage({
    token, chatId, fetchImpl,
    text: 'FoodFlow Telegram Bot 连接测试成功。'
  });
}

module.exports = { validateBotToken, validateChatId, sendTelegramMessage, sendTelegramTestMessage };
