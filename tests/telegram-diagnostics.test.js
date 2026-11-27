'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectTelegramDiagnostics } = require('../scripts/telegram-diagnostics');

const clientToken = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const adminToken = '654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const secret = 'a'.repeat(64);

test('Telegram diagnostics report actionable status without exposing credentials', async () => {
  let recipientQuery = '';
  const allAsync = async sql => {
    if (sql.includes('FROM settings')) return [
      { key: 'telegram_admin_bot_enabled', value: '1' },
      { key: 'telegram_admin_bot_token', value: adminToken },
      { key: 'telegram_client_bot_enabled', value: '1' },
      { key: 'telegram_client_bot_token', value: clientToken },
      { key: 'telegram_client_chat_id', value: '123456789' }
    ];
    if (sql.includes('telegram_customer_bindings')) return [{ total: 3, active: 2 }];
    if (sql.includes('telegram_store_admin_recipients')) { recipientQuery = sql; return [{ total: 4, enabled: 3, orderEnabled: 2 }]; }
    if (sql.includes('telegram_notification_outbox')) return [
      { state: 'pending', recipient_scope: 'customer', last_error_code: null, total: 2 },
      { state: 'dead', recipient_scope: 'merchant_store', last_error_code: 'invalid_recipient', total: 1 }
    ];
    throw new Error('unexpected query');
  };
  let requestedUrl = '';
  const report = await collectTelegramDiagnostics({
    allAsync,
    env: {
      TELEGRAM_NOTIFICATION_WORKER_ENABLED: 'true',
      TELEGRAM_CLIENT_WEBHOOK_SECRET: secret,
      FOODFLOW_PUBLIC_URL: 'https://foodflow.example.test/'
    },
    fetchImpl: async url => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            url: 'https://foodflow.example.test/api/telegram/client/webhook',
            pending_update_count: 0
          }
        })
      };
    }
  });

  assert.equal(report.worker.enabled, true);
  assert.equal(report.webhookSecret.configured, true);
  assert.equal(report.bots.admin.businessRecipientMode, 'store_chat_id_only');
  assert.equal(Object.hasOwn(report.bots.admin, 'globalChatConfigured'), false);
  assert.equal(report.customerBindings.active, 2);
  assert.equal(report.storeRecipients.enabled, 3);
  assert.match(recipientQuery, /SUM\(chat_id<>/);
  assert.doesNotMatch(recipientQuery, /is_enabled/);
  assert.equal(report.outbox.groups[0].total, 2);
  assert.equal(report.clientWebhook.matchesExpectedUrl, true);
  assert.match(requestedUrl, /getWebhookInfo$/);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(clientToken), false);
  assert.equal(serialized.includes(adminToken), false);
  assert.equal(serialized.includes(secret), false);
});

test('Telegram diagnostics fail closed when notification tables are not installed', async () => {
  const allAsync = async sql => {
    if (sql.includes('FROM settings')) return [];
    throw new Error('table does not exist');
  };
  const report = await collectTelegramDiagnostics({
    allAsync,
    env: {},
    fetchImpl: async () => { throw new Error('should not be called'); }
  });
  assert.deepEqual(report.customerBindings, { available: false });
  assert.deepEqual(report.storeRecipients, { available: false });
  assert.deepEqual(report.outbox, { available: false });
  assert.equal(report.clientWebhook.checked, false);
  assert.equal(report.worker.enabled, false, 'non-production without an override must keep worker disabled');
  const productionDefault = await collectTelegramDiagnostics({ allAsync, env: { NODE_ENV: 'production' }, fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(productionDefault.worker.enabled, true);
  const explicitlyEnabled = await collectTelegramDiagnostics({ allAsync, env: { NODE_ENV: 'test', TELEGRAM_NOTIFICATION_WORKER_ENABLED: 'true' }, fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(explicitlyEnabled.worker.enabled, true);
  const paused = await collectTelegramDiagnostics({ allAsync, env: { TELEGRAM_NOTIFICATION_WORKER_ENABLED: 'false' }, fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(paused.worker.enabled, false);
});
