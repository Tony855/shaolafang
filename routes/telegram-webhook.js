'use strict';

const { createTelegramCustomerWebhookHandler } = require('../server/services/telegram-customer-webhook');
const { constantTimeSecretMatch } = require('../server/services/telegram-webhook');

module.exports = function registerTelegramWebhook(app, deps) {
  const { allAsync, getAsync } = deps;

  // Tenant Client Bots use an opaque per-bot URL and a per-bot Telegram secret.
  // The path token is only a locator; the Telegram secret header authenticates
  // the request, and the bot must still be enabled in the tenant configuration.
  app.post('/api/telegram/client/:pathToken/webhook', async (req, res) => {
    const pathToken = String(req.params?.pathToken || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(pathToken)) return res.status(404).json({ ok: false });
    try {
      const bot = await getAsync(
        'SELECT merchant_id, bot_token, webhook_secret FROM telegram_tenant_client_bots WHERE webhook_path_token=? AND is_enabled=1 LIMIT 1',
        [pathToken]
      );
      if (!bot || !bot.bot_token || !bot.webhook_secret) return res.status(404).json({ ok: false });
      const suppliedSecret = req.get?.('X-Telegram-Bot-Api-Secret-Token') || req.headers?.['x-telegram-bot-api-secret-token'] || '';
      if (!constantTimeSecretMatch(suppliedSecret, String(bot.webhook_secret))) return res.status(403).json({ ok: false });

      const handler = createTelegramCustomerWebhookHandler({
        ...deps,
        secret: String(bot.webhook_secret),
        tenantMerchantId: Number(bot.merchant_id),
        getBotToken: async () => String(bot.bot_token)
      });
      return handler(req, res);
    } catch (_) {
      return res.status(503).json({ ok: false });
    }
  });

  // Legacy single-client-bot endpoint retained during migration. New tenant
  // bots must be registered only through the tenant-specific route above.
  const legacyHandler = createTelegramCustomerWebhookHandler({
    ...deps,
    secret: String(process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET || ''),
    getBotToken: async () => {
      const rows = await allAsync(
        'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
        ['telegram_client_bot_enabled', 'telegram_client_bot_token']
      );
      const stored = Object.fromEntries(rows.map(row => [row.key, row.value]));
      return stored.telegram_client_bot_enabled === '1' ? String(stored.telegram_client_bot_token || '') : '';
    }
  });
  app.post('/api/telegram/client/webhook', legacyHandler);
};
