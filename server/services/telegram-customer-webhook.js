'use strict';

const crypto = require('crypto');
const { sendTelegramMessage, validateBotToken } = require('./telegram-bot');

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createTelegramCustomerWebhookHandler({
  getAsync, runAsync, withTransaction, secret, getBotToken, sendMessage = sendTelegramMessage, logger = console
} = {}) {
  for (const [name, fn] of Object.entries({ getAsync, runAsync, withTransaction, getBotToken })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' is required');
  }

  return async function telegramCustomerWebhook(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const suppliedSecret = req.get?.('X-Telegram-Bot-Api-Secret-Token') || req.headers?.['x-telegram-bot-api-secret-token'] || '';
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256 || !safeEqual(suppliedSecret, secret)) {
      return res.status(403).json({ ok: false });
    }

    const update = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const updateId = Number(update.update_id);
    if (!Number.isSafeInteger(updateId) || updateId < 0) return res.status(200).json({ ok: true });

    try {
      let bound = null;
      await withTransaction(async () => {
        try {
          await runAsync('INSERT INTO telegram_webhook_updates (update_id, received_at) VALUES (?, UTC_TIMESTAMP(3))', [updateId]);
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY') return;
          throw error;
        }

        const message = update.message;
        const text = typeof message?.text === 'string' ? message.text.trim() : '';
        const match = text.match(/^\/start\s+([A-Za-z0-9_-]{32,64})$/);
        const chatId = String(message?.chat?.id ?? '');
        const userId = String(message?.from?.id ?? '');
        if (message?.chat?.type !== 'private' || !match || !/^-?\d{1,20}$/.test(chatId) || !/^\d{1,20}$/.test(userId)) return;

        const challengeHash = crypto.createHash('sha256').update(match[1]).digest('hex');
        const challenge = await getAsync(
          'SELECT id, customer_token_hash, merchant_id, store_id FROM telegram_customer_binding_challenges WHERE challenge_hash=? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE',
          [challengeHash]
        );
        if (!challenge) return;

        const consumed = await runAsync(
          'UPDATE telegram_customer_binding_challenges SET consumed_at=UTC_TIMESTAMP(3) WHERE id=? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3)',
          [challenge.id]
        );
        if (Number(consumed.affectedRows) !== 1) return;

        try {
          await runAsync(
            'INSERT INTO telegram_customer_bindings (customer_token_hash, merchant_id, store_id, telegram_user_id, telegram_chat_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=IF(customer_token_hash=VALUES(customer_token_hash) AND store_id=VALUES(store_id), id, id)',
            [challenge.customer_token_hash, challenge.merchant_id, challenge.store_id, userId, chatId]
          );
          const row = await getAsync(
            'SELECT id FROM telegram_customer_bindings WHERE customer_token_hash=? AND merchant_id=? AND store_id=? AND telegram_chat_id=? AND is_active=1 AND revoked_at IS NULL LIMIT 1',
            [challenge.customer_token_hash, challenge.merchant_id, challenge.store_id, chatId]
          );
          if (row) bound = { id: Number(row.id), chatId };
        } catch (error) {
          if (error?.code !== 'ER_DUP_ENTRY') throw error;
        }
      });

      if (bound) {
        try {
          const token = await getBotToken();
          if (validateBotToken(token)) await sendMessage({ token, chatId: bound.chatId, text: 'FoodFlow Telegram 通知绑定成功。' });
        } catch (error) {
          logger.warn('[telegram-webhook] confirmation message failed');
        }
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      logger.error('[telegram-webhook] update processing failed:', error?.message || 'unknown error');
      return res.status(200).json({ ok: true });
    }
  };
}

module.exports = { createTelegramCustomerWebhookHandler, safeEqual };
