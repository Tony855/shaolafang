'use strict';

const crypto = require('node:crypto');
const { createTelegramCustomerWebhookHandler } = require('../server/services/telegram-customer-webhook');
const { decryptBotToken } = require('../server/services/telegram-bot-credentials');

module.exports = function registerTelegramWebhook(app, deps) {
  const { allAsync, getAsync, decryptCredential = decryptBotToken } = deps;

  // Compatibility endpoint for tenants that have not migrated from the shared Bot.
  const legacyHandler = createTelegramCustomerWebhookHandler({
    ...deps,
    secret: String(process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET || ''),
    getBotToken: async () => {
      const rows = await allAsync(
        'SELECT \`key\`, value FROM settings WHERE \`key\` IN (?, ?)',
        ['telegram_client_bot_enabled', 'telegram_client_bot_token']
      );
      const stored = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
      return stored.telegram_client_bot_enabled === '1' ? String(stored.telegram_client_bot_token || '') : '';
    }
  });

  app.post('/api/telegram/client/webhook', legacyHandler);

  // Tenant-specific route. The path token is high entropy and only its SHA-256
  // digest is stored. Resolve the tenant before processing any Telegram update.
  app.post('/api/telegram/tenant/:pathToken/client/webhook', async (req, res) => {
    const pathToken = String(req.params?.pathToken || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(pathToken)) return res.status(404).json({ ok: false });
    try {
      const pathHash = crypto.createHash('sha256').update(pathToken, 'utf8').digest('hex');
      const config = await getAsync(
        'SELECT id, merchant_id, client_bot_token_encrypted, webhook_secret_encrypted FROM telegram_merchant_bots WHERE webhook_path_hash=? AND client_bot_enabled=1 LIMIT 1',
        [pathHash]
      );
      if (!config || !config.client_bot_token_encrypted || !config.webhook_secret_encrypted) {
        return res.status(404).json({ ok: false });
      }
      const token = decryptCredential(config.client_bot_token_encrypted);
      const secret = decryptCredential(config.webhook_secret_encrypted);
      const merchantId = Number(config.merchant_id);
      const botConfigId = Number(config.id);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 ||
          !Number.isSafeInteger(botConfigId) || botConfigId <= 0) {
        return res.status(404).json({ ok: false });
      }
      const handler = createTelegramCustomerWebhookHandler({
        ...deps,
        merchantId,
        botConfigId,
        secret,
        getBotToken: async () => token
      });
      return handler(req, res);
    } catch (_) {
      // Credential decryption failures and database outages fail closed. Never
      // include the path token, Bot token, webhook secret, or raw error in logs.
      try { deps.logger?.error?.('[telegram-webhook] tenant route resolution failed'); } catch (_) {}
      return res.status(503).json({ ok: false });
    }
  });
};
