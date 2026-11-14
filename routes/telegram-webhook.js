'use strict';

const { createTelegramCustomerWebhookHandler } = require('../server/services/telegram-customer-webhook');

module.exports = function registerTelegramWebhook(app, deps) {
  const { allAsync } = deps;
  const handler = createTelegramCustomerWebhookHandler({
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
  app.post('/api/telegram/client/webhook', handler);
};
