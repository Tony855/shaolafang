'use strict';

const crypto = require('crypto');
const { validateBotToken, sendTelegramMessage } = require('./telegram-bot');
const { constantTimeSecretMatch, parseTelegramPrivateUpdate } = require('./telegram-webhook');

function createTelegramCustomerWebhookHandler({
  getAsync, allAsync, runAsync, withTransaction, secret, getBotToken,
  sendMessage = sendTelegramMessage, logger = console
} = {}) {
  for (const [name, fn] of Object.entries({ getAsync, allAsync, runAsync, withTransaction, getBotToken })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' is required');
  }

  return async function telegramCustomerWebhook(req, res) {
    if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-store');
    const suppliedSecret = req.get?.('X-Telegram-Bot-Api-Secret-Token') || req.headers?.['x-telegram-bot-api-secret-token'] || '';
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256 || !constantTimeSecretMatch(suppliedSecret, secret)) {
      return res.status(403).json({ ok: false });
    }

    const update = parseTelegramPrivateUpdate(req.body);
    if (!update) return res.status(200).json({ ok: true });

    let botToken = '';
    try {
      botToken = await getBotToken();
    } catch (_) {
      // A customer must still be able to revoke consent with /stop even when
      // outbound Bot configuration is disabled or temporarily unavailable.
      if (update.action !== 'stop') return res.status(503).json({ ok: false });
    }
    if (update.action !== 'stop' && !validateBotToken(botToken)) {
      return res.status(200).json({ ok: true });
    }

    let bound = null;
    try {
      await withTransaction(async () => {
        try {
          await runAsync('INSERT INTO telegram_webhook_updates (update_id, received_at) VALUES (?, UTC_TIMESTAMP(3))', [update.updateId]);
          await runAsync('DELETE FROM telegram_webhook_updates WHERE received_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY) LIMIT 1000');
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY') return;
          throw error;
        }

        if (update.action === 'stop') {
          const revoked = await runAsync(
            'UPDATE telegram_customer_bindings SET is_active=0, revoked_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE telegram_chat_id=? AND telegram_user_id=? AND is_active=1',
            [update.telegramChatId, update.telegramUserId]
          );
          bound = {
            chatId: update.telegramChatId,
            text: Number(revoked.affectedRows) > 0
              ? 'FoodFlow：已取消此 Telegram 账号的所有顾客通知绑定。之后不会再收到订单通知。'
              : 'FoodFlow：当前 Telegram 账号没有启用中的顾客通知绑定。'
          };
          return;
        }

        const challengeHash = crypto.createHash('sha256').update(update.challenge).digest('hex');
        const challenge = await getAsync(
          'SELECT id, customer_token_hash, merchant_id, store_id, expires_at, consumed_at FROM telegram_customer_binding_challenges WHERE challenge_hash=? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE',
          [challengeHash]
        );
        // expires_at is a MySQL DATETIME written with UTC_TIMESTAMP(3). The SQL predicate above is authoritative; do not reinterpret that timezone-naive value as local JavaScript time.
        if (!challenge || challenge.consumed_at) return;
        const activeStore = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1',
          [challenge.store_id, challenge.merchant_id]
        );
        if (!activeStore) return;

        const existingRows = await allAsync(
          'SELECT id, customer_token_hash, store_id, telegram_chat_id, is_active FROM telegram_customer_bindings WHERE (telegram_chat_id=? AND store_id=?) OR (customer_token_hash=? AND store_id=?) FOR UPDATE',
          [update.telegramChatId, challenge.store_id, challenge.customer_token_hash, challenge.store_id]
        );
        const chatOwner = existingRows.find(row => String(row.telegram_chat_id) === update.telegramChatId);
        const ownerBinding = existingRows.find(row => row.customer_token_hash === challenge.customer_token_hash && Number(row.store_id) === Number(challenge.store_id));
        // Customer tokens are intentionally rotated for each new QR scan. A
        // Telegram user who proves control of both the current customer session
        // (the one-time challenge) and this private chat may move the chat to
        // the new session. Remove the previous identity row so queued messages
        // for that old binding fail closed instead of following the reused ID.
        if (chatOwner && (!ownerBinding || Number(chatOwner.id) !== Number(ownerBinding.id))) {
          await runAsync('DELETE FROM telegram_customer_bindings WHERE id=?', [chatOwner.id]);
        }
        if (ownerBinding) {
          await runAsync(
            'UPDATE telegram_customer_bindings SET merchant_id=?, telegram_user_id=?, telegram_chat_id=?, is_active=1, revoked_at=NULL, updated_at=UTC_TIMESTAMP(3) WHERE id=?',
            [challenge.merchant_id, update.telegramUserId, update.telegramChatId, ownerBinding.id]
          );
        } else {
          await runAsync(
            'INSERT INTO telegram_customer_bindings (customer_token_hash, merchant_id, store_id, telegram_user_id, telegram_chat_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
            [challenge.customer_token_hash, challenge.merchant_id, challenge.store_id, update.telegramUserId, update.telegramChatId]
          );
        }
        const consumed = await runAsync(
          'UPDATE telegram_customer_binding_challenges SET consumed_at=UTC_TIMESTAMP(3) WHERE id=? AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(3)',
          [challenge.id]
        );
        if (Number(consumed.affectedRows) !== 1) throw new Error('Telegram binding challenge consumption race');
        bound = { chatId: update.telegramChatId, text: 'FoodFlow：Telegram 顾客通知绑定成功。你只会收到当前顾客会话关联的订单通知。' };
      });
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') return res.status(200).json({ ok: true });
      try { logger.error('[telegram-webhook] update processing failed'); } catch (_) {}
      return res.status(503).json({ ok: false });
    }

    if (bound && validateBotToken(botToken)) {
      try {
        await sendMessage({ token: botToken, chatId: bound.chatId, text: bound.text });
      } catch (_) {
        try { logger.warn('[telegram-webhook] confirmation message failed'); } catch (_) {}
      }
    }
    return res.status(200).json({ ok: true });
  };
}

module.exports = { createTelegramCustomerWebhookHandler };
