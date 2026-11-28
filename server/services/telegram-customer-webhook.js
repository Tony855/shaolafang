'use strict';

const crypto = require('crypto');
const { validateBotToken, sendTelegramMessage, setTelegramMenuButton } = require('./telegram-bot');
const { constantTimeSecretMatch, parseTelegramPrivateUpdate } = require('./telegram-webhook');
const { createStoreEntrySignature, verifyStoreEntrySignature, createTenantStoreEntrySignature, verifyTenantStoreEntrySignature } = require('./telegram-store-entry');

function createTelegramCustomerWebhookHandler({
  getAsync, allAsync, runAsync, withTransaction, secret, getBotToken,
  merchantId = null, botConfigId = null, webhookPathToken = '',
  sendMessage = sendTelegramMessage, setMenuButton = setTelegramMenuButton, logger = console
} = {}) {
  for (const [name, fn] of Object.entries({ getAsync, allAsync, runAsync, withTransaction, getBotToken })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' is required');
  }

  const scopedMerchantId = Number.isSafeInteger(Number(merchantId)) && Number(merchantId) > 0 ? Number(merchantId) : null;
  const scopedBotConfigId = Number.isSafeInteger(Number(botConfigId)) && Number(botConfigId) > 0 ? Number(botConfigId) : null;

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
          if (scopedBotConfigId) {
            await runAsync('INSERT INTO telegram_merchant_webhook_updates (bot_config_id, update_id, received_at) VALUES (?, ?, UTC_TIMESTAMP(3))', [scopedBotConfigId, update.updateId]);
            await runAsync('DELETE FROM telegram_merchant_webhook_updates WHERE bot_config_id=? AND received_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY) LIMIT 1000', [scopedBotConfigId]);
          } else {
            await runAsync('INSERT INTO telegram_webhook_updates (update_id, received_at) VALUES (?, UTC_TIMESTAMP(3))', [update.updateId]);
            await runAsync('DELETE FROM telegram_webhook_updates WHERE received_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY) LIMIT 1000');
          }
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY') return;
          throw error;
        }

        if (update.action === 'stop') {
          // Lock bindings first, then dead-letter their queue rows. Enqueue
          // uses the same binding -> outbox lock order, so a concurrent order
          // transaction cannot slip a notice in after /stop has committed.
          const activeBindings = await allAsync(
            scopedMerchantId
              ? 'SELECT id FROM telegram_customer_bindings WHERE merchant_id=? AND telegram_chat_id=? AND telegram_user_id=? AND is_active=1 ORDER BY id FOR UPDATE'
              : 'SELECT id FROM telegram_customer_bindings WHERE telegram_chat_id=? AND telegram_user_id=? AND is_active=1 AND merchant_id NOT IN (SELECT merchant_id FROM telegram_merchant_bots WHERE client_bot_enabled=1) ORDER BY id FOR UPDATE',
            scopedMerchantId ? [scopedMerchantId, update.telegramChatId, update.telegramUserId] : [update.telegramChatId, update.telegramUserId]
          );
          const bindingIds = Array.isArray(activeBindings)
            ? activeBindings.map(row => Number(row.id)).filter(id => Number.isSafeInteger(id) && id > 0)
            : [];
          if (bindingIds.length) {
            const placeholders = bindingIds.map(() => '?').join(',');
            await runAsync(
              "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='binding_revoked', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='customer' AND state IN ('pending','processing') AND recipient_key IN (" + placeholders + ")",
              bindingIds.map(id => `binding:${id}`)
            );
          }
          const revoked = await runAsync(
            scopedMerchantId
              ? 'UPDATE telegram_customer_bindings SET is_active=0, revoked_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE merchant_id=? AND telegram_chat_id=? AND telegram_user_id=? AND is_active=1'
              : 'UPDATE telegram_customer_bindings SET is_active=0, revoked_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE telegram_chat_id=? AND telegram_user_id=? AND is_active=1 AND merchant_id NOT IN (SELECT merchant_id FROM telegram_merchant_bots WHERE client_bot_enabled=1)',
            scopedMerchantId ? [scopedMerchantId, update.telegramChatId, update.telegramUserId] : [update.telegramChatId, update.telegramUserId]
          );
          bound = {
            chatId: update.telegramChatId,
            text: Number(revoked.affectedRows) > 0
              ? (scopedMerchantId ? 'FoodFlow：已取消此商户的 Telegram 顾客通知。其他商户的绑定不受影响。' : 'FoodFlow：已取消此 Telegram 账号的所有顾客通知绑定。之后不会再收到订单通知。')
              : (scopedMerchantId ? 'FoodFlow：当前商户没有启用中的顾客通知绑定。其他商户的绑定不受影响。' : 'FoodFlow：当前 Telegram 账号没有启用中的顾客通知绑定。')
          };
          return;
        }

        if (update.action === 'home') {
          // Resume the customer's most recently bound store within this Bot's tenant.
          // A tenant Bot never queries or exposes another merchant's customer bindings.
          const bindings = await allAsync(
            scopedMerchantId
              ? 'SELECT b.store_id, s.name FROM telegram_customer_bindings b JOIN stores s ON s.id=b.store_id AND s.merchant_id=b.merchant_id JOIN merchants m ON m.id=b.merchant_id WHERE b.merchant_id=? AND b.telegram_chat_id=? AND b.telegram_user_id=? AND b.is_active=1 AND b.revoked_at IS NULL AND s.active=1 AND m.status=1 ORDER BY b.updated_at DESC, b.id DESC LIMIT 1'
              : 'SELECT b.store_id, r.chat_id, s.name FROM telegram_customer_bindings b JOIN stores s ON s.id=b.store_id AND s.merchant_id=b.merchant_id JOIN merchants m ON m.id=b.merchant_id JOIN telegram_store_admin_recipients r ON r.merchant_id=b.merchant_id AND r.store_id=b.store_id LEFT JOIN telegram_merchant_bots tb ON tb.merchant_id=b.merchant_id AND tb.client_bot_enabled=1 WHERE tb.id IS NULL AND b.telegram_chat_id=? AND b.telegram_user_id=? AND b.is_active=1 AND r.is_enabled=1 AND r.chat_id<>\\'\\' AND s.active=1 AND m.status=1 ORDER BY b.updated_at DESC, b.id DESC LIMIT 1',
            scopedMerchantId ? [scopedMerchantId, update.telegramChatId, update.telegramUserId] : [update.telegramChatId, update.telegramUserId]
          );
          const binding = Array.isArray(bindings) ? bindings[0] : null;
          const publicUrl = String(process.env.FOODFLOW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
          let publicOrigin = '';
          try {
            const parsed = new URL(publicUrl);
            if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) publicOrigin = parsed.origin;
          } catch (_) {}
          if (binding && publicOrigin) {
            const signature = scopedMerchantId
              ? createTenantStoreEntrySignature({ merchantId: scopedMerchantId, storeId: binding.store_id, secret })
              : createStoreEntrySignature({ storeId: binding.store_id, chatId: String(binding.chat_id || ''), secret });
            const botQuery = scopedMerchantId && /^[A-Za-z0-9_-]{43}$/.test(webhookPathToken) ? '&bot=' + encodeURIComponent(webhookPathToken) : '';
            const webAppUrl = publicOrigin + '/delivery/order?store_id=' + encodeURIComponent(String(binding.store_id)) + '&entry=' + encodeURIComponent(signature) + '&telegram=1' + botQuery;
            bound = {
              chatId: update.telegramChatId,
              text: '欢迎回来 FoodFlow' + (binding.name ? ' · ' + String(binding.name).slice(0, 80) : '') + '。已自动为你打开最近绑定的门店。',
              menuButtonUrl: webAppUrl,
              replyMarkup: { inline_keyboard: [[{ text: '🍽️ 继续本店外卖点餐', web_app: { url: webAppUrl } }]] }
            };
          } else {
            bound = {
              chatId: update.telegramChatId,
              text: '欢迎使用 FoodFlow 外卖点餐。请先通过门店管理员提供的专属 Telegram 点餐链接进入一次；之后再次打开机器人，系统会自动进入你最近绑定的门店。'
            };
          }
          return;
        }

        if (update.action === 'delivery') {
          const recipient = await getAsync(
            scopedMerchantId
              ? 'SELECT s.id, s.name, s.merchant_id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.merchant_id=? AND s.id=? AND s.active=1 AND m.status=1 LIMIT 1'
              : 'SELECT r.chat_id, r.is_enabled, s.id, s.name, s.merchant_id FROM telegram_store_admin_recipients r JOIN stores s ON s.id=r.store_id AND s.merchant_id=r.merchant_id JOIN merchants m ON m.id=r.merchant_id LEFT JOIN telegram_merchant_bots tb ON tb.merchant_id=r.merchant_id AND tb.client_bot_enabled=1 WHERE tb.id IS NULL AND r.store_id=? AND r.is_enabled=1 AND r.chat_id<>\\'\\' AND s.active=1 AND m.status=1 LIMIT 1',
            scopedMerchantId ? [scopedMerchantId, update.storeId] : [update.storeId]
          );
          const publicUrl = String(process.env.FOODFLOW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
          let publicOrigin = '';
          try {
            const parsed = new URL(publicUrl);
            if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) publicOrigin = parsed.origin;
          } catch (_) {}
          const validEntry = scopedMerchantId
            ? recipient && verifyTenantStoreEntrySignature({ merchantId: scopedMerchantId, storeId: recipient.id, secret, signature: update.entrySignature })
            : recipient && verifyStoreEntrySignature({ storeId: recipient.id, chatId: String(recipient.chat_id || ''), secret, signature: update.entrySignature });
          if (recipient && publicOrigin && validEntry) {
            const botQuery = scopedMerchantId && /^[A-Za-z0-9_-]{43}$/.test(webhookPathToken) ? '&bot=' + encodeURIComponent(webhookPathToken) : '';
            const webAppUrl = publicOrigin + '/delivery/order?store_id=' + encodeURIComponent(String(recipient.id)) + '&entry=' + encodeURIComponent(update.entrySignature) + '&telegram=1' + botQuery;
            bound = {
              chatId: update.telegramChatId,
              text: '欢迎使用 FoodFlow' + (recipient.name ? ' · ' + String(recipient.name).slice(0, 80) : '') + '。此入口已绑定当前门店。',
              menuButtonUrl: webAppUrl,
              replyMarkup: { inline_keyboard: [[{ text: '🍽️ 打开本店外卖点餐', web_app: { url: webAppUrl } }]] }
            };
          } else {
            bound = {
              chatId: update.telegramChatId,
              text: '此门店点餐链接已失效或门店群组绑定已变更，请向门店管理员获取最新专属链接。'
            };
          }
          return;
        }

        const challengeHash = crypto.createHash('sha256').update(update.challenge).digest('hex');
        const challenge = await getAsync(
          scopedMerchantId
            ? 'SELECT id, customer_token_hash, merchant_id, store_id, expires_at, consumed_at FROM telegram_customer_binding_challenges WHERE challenge_hash=? AND merchant_id=? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE'
            : 'SELECT id, customer_token_hash, merchant_id, store_id, expires_at, consumed_at FROM telegram_customer_binding_challenges WHERE challenge_hash=? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(3) AND merchant_id NOT IN (SELECT merchant_id FROM telegram_merchant_bots WHERE client_bot_enabled=1) FOR UPDATE',
          scopedMerchantId ? [challengeHash, scopedMerchantId] : [challengeHash]
        );
        // expires_at is a MySQL DATETIME written with UTC_TIMESTAMP(3). The SQL predicate above is authoritative; do not reinterpret that timezone-naive value as local JavaScript time.
        if (!challenge || challenge.consumed_at) return;
        const activeStore = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1 AND (? IS NULL OR s.merchant_id=?)',
          [challenge.store_id, challenge.merchant_id, scopedMerchantId, scopedMerchantId]
        );
        if (!activeStore) return;

        const existingRows = await allAsync(
          scopedMerchantId
            ? 'SELECT id, customer_token_hash, store_id, telegram_chat_id, is_active FROM telegram_customer_bindings WHERE merchant_id=? AND ((telegram_chat_id=? AND store_id=?) OR (customer_token_hash=? AND store_id=?)) FOR UPDATE'
            : 'SELECT id, customer_token_hash, store_id, telegram_chat_id, is_active FROM telegram_customer_bindings WHERE (telegram_chat_id=? AND store_id=?) OR (customer_token_hash=? AND store_id=?) FOR UPDATE',
          scopedMerchantId ? [scopedMerchantId, update.telegramChatId, challenge.store_id, challenge.customer_token_hash, challenge.store_id] : [update.telegramChatId, challenge.store_id, challenge.customer_token_hash, challenge.store_id]
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
          if (Number(ownerBinding.is_active) !== 1) {
            // Do not resurrect messages queued before a prior opt-out when
            // the same customer identity later chooses to bind again.
            await runAsync(
              "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='binding_revoked', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='customer' AND recipient_key=? AND state IN ('pending','processing')",
              [`binding:${ownerBinding.id}`]
            );
          }
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
      if (bound.menuButtonUrl && typeof setMenuButton === 'function') {
        try {
          await setMenuButton({
            token: botToken, chatId: bound.chatId, enabled: true,
            text: '🍽️ 本店点餐', webAppUrl: bound.menuButtonUrl
          });
        } catch (_) {
          try { logger.warn('[telegram-webhook] store-specific chat menu button update failed'); } catch (_) {}
        }
      }
      try {
        await sendMessage({ token: botToken, chatId: bound.chatId, text: bound.text, replyMarkup: bound.replyMarkup });
      } catch (_) {
        try { logger.warn('[telegram-webhook] confirmation message failed'); } catch (_) {}
      }
    }
    return res.status(200).json({ ok: true });
  };
}

module.exports = { createTelegramCustomerWebhookHandler };
