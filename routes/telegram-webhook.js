'use strict';

const crypto = require('crypto');
const { sendTelegramMessage } = require('../server/services/telegram-bot');
const { constantTimeSecretMatch, parseTelegramPrivateStartUpdate } = require('../server/services/telegram-webhook');

module.exports = function registerTelegramWebhook(app, deps) {
  const { getAsync, allAsync, runAsync, withTransaction } = deps;
  const secret = String(process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET || '');

  app.post('/api/telegram/client/webhook', async (req, res) => {
    const suppliedSecret = typeof req.get === 'function'
      ? req.get('X-Telegram-Bot-Api-Secret-Token')
      : req.headers?.['x-telegram-bot-api-secret-token'];
    if (secret.length < 32 || secret.length > 256 || !constantTimeSecretMatch(suppliedSecret, secret)) return res.status(403).json({ ok: false });

    const update = parseTelegramPrivateStartUpdate(req.body);
    if (!update) return res.status(200).json({ ok: true });

    try {
      const keys = ['telegram_client_bot_enabled', 'telegram_client_bot_token'];
      const rows = await allAsync('SELECT `key`, value FROM settings WHERE `key` IN (?, ?)', keys);
      const config = Object.fromEntries(rows.map(row => [row.key, row.value]));
      if (config.telegram_client_bot_enabled !== '1' || !config.telegram_client_bot_token) {
        return res.status(200).json({ ok: true });
      }

      const challengeHash = crypto.createHash('sha256').update(update.challenge).digest('hex');
      const binding = await withTransaction(async () => {
        await runAsync('INSERT INTO telegram_webhook_updates (update_id, received_at) VALUES (?, UTC_TIMESTAMP(3))', [update.updateId]);
        const challenge = await getAsync(
          'SELECT id, customer_token_hash, merchant_id, store_id, expires_at, consumed_at FROM telegram_customer_binding_challenges WHERE challenge_hash=? FOR UPDATE',
          [challengeHash]
        );
        if (!challenge || challenge.consumed_at || !Number.isFinite(new Date(challenge.expires_at).getTime()) || new Date(challenge.expires_at).getTime() <= Date.now()) {
          return null;
        }
        const store = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1',
          [challenge.store_id, challenge.merchant_id]
        );
        if (!store) return null;

        const existingRows = await allAsync(
          'SELECT id, customer_token_hash, store_id, telegram_chat_id FROM telegram_customer_bindings WHERE (telegram_chat_id=? AND store_id=?) OR (customer_token_hash=? AND store_id=?) FOR UPDATE',
          [update.telegramChatId, challenge.store_id, challenge.customer_token_hash, challenge.store_id]
        );
        const chatOwner = existingRows.find(row => String(row.telegram_chat_id) === update.telegramChatId);
        if (chatOwner && (chatOwner.customer_token_hash !== challenge.customer_token_hash || Number(chatOwner.store_id) !== Number(challenge.store_id))) {
          return null;
        }
        const ownerBinding = existingRows.find(row => row.customer_token_hash === challenge.customer_token_hash && Number(row.store_id) === Number(challenge.store_id));
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
        await runAsync('DELETE FROM telegram_webhook_updates WHERE received_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)');
        return { chatId: update.telegramChatId };
      });

      if (binding) {
        try {
          await sendTelegramMessage({
            token: String(config.telegram_client_bot_token),
            chatId: binding.chatId,
            text: 'FoodFlow：Telegram 顾客通知绑定成功。你只会收到当前顾客会话关联的订单通知。'
          });
        } catch (_) {
          // The binding is committed; Telegram webhook retries are deduplicated by update_id.
        }
      }
      return res.status(200).json({ ok: true });
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') return res.status(200).json({ ok: true });
      return res.status(503).json({ ok: false });
    }
  });
};
