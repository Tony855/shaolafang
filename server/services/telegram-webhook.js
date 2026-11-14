'use strict';

const crypto = require('crypto');

function constantTimeSecretMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseTelegramPrivateStartUpdate(update) {
  if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id) || update.update_id <= 0) return null;
  const message = update.message;
  if (!message || typeof message !== 'object' || message.chat?.type !== 'private') return null;
  const chatId = String(message.chat?.id ?? '');
  const userId = String(message.from?.id ?? '');
  if (!/^\d{1,20}$/.test(chatId) || !/^\d{1,20}$/.test(userId)) return null;
  if (message.from?.is_bot === true) return null;
  if (typeof message.text !== 'string' || message.text.length > 256) return null;
  const match = message.text.trim().match(/^\/start\s+([A-Za-z0-9_-]{20,64})$/);
  if (!match) return null;
  return { updateId: update.update_id, challenge: match[1], telegramUserId: userId, telegramChatId: chatId };
}

module.exports = { constantTimeSecretMatch, parseTelegramPrivateStartUpdate };
