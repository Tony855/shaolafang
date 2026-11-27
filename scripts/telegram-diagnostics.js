'use strict';

const WEBHOOK_PATH = '/api/telegram/client/webhook';
const { isTelegramNotificationWorkerEnabled } = require('../server/services/telegram-notification-worker-runtime');
const { isTelegramGroupSubscriptionsRoutingEnabled } = require('../server/services/telegram-notification-routing');

function toCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

async function safeQuery(allAsync, sql) {
  try {
    return { available: true, rows: await allAsync(sql) };
  } catch (_) {
    // Do not print SQL errors: drivers may include database or schema details.
    return { available: false, rows: [] };
  }
}

async function collectTelegramDiagnostics({ allAsync, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (typeof allAsync !== 'function') throw new TypeError('allAsync is required');

  const settingRows = await allAsync(
    'SELECT `key`, value FROM settings WHERE `key` IN (?, ?, ?, ?, ?)',
    [
      'telegram_admin_bot_enabled',
      'telegram_admin_bot_token',
      'telegram_client_bot_enabled',
      'telegram_client_bot_token',
      'telegram_client_chat_id'
    ]
  );
  const settings = Object.fromEntries((Array.isArray(settingRows) ? settingRows : []).map(row => [row.key, row.value]));
  const clientToken = String(settings.telegram_client_bot_token || '');
  const adminToken = String(settings.telegram_admin_bot_token || '');
  const secret = String(env.TELEGRAM_CLIENT_WEBHOOK_SECRET || '');
  const expectedBase = String(env.FOODFLOW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const expectedWebhookUrl = expectedBase ? expectedBase + WEBHOOK_PATH : null;

  const [bindings, recipients, outbox, destinations, subscriptions] = await Promise.all([
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(is_active=1 AND revoked_at IS NULL), 0) AS active FROM telegram_customer_bindings'),
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(chat_id<>\'\'), 0) AS enabled, COALESCE(SUM(chat_id<>\'\' AND notify_order_created=1), 0) AS orderEnabled FROM telegram_store_admin_recipients'),
    safeQuery(allAsync,
      'SELECT state, recipient_scope, last_error_code, COUNT(*) AS total FROM telegram_notification_outbox GROUP BY state, recipient_scope, last_error_code ORDER BY state, recipient_scope, last_error_code'),
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(is_enabled=1), 0) AS enabled FROM telegram_chat_destinations'),
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(is_enabled=1), 0) AS enabled, COALESCE(SUM(is_enabled=1 AND notify_order_created=1), 0) AS orderEnabled, COALESCE(SUM(is_enabled=1 AND notify_settled=1), 0) AS settledEnabled, COALESCE(SUM(is_enabled=1 AND notify_refunded=1), 0) AS refundedEnabled FROM telegram_store_subscriptions')
  ]);

  let clientWebhook = {
    checked: false,
    configured: false,
    reason: 'client_bot_token_missing',
    pendingUpdateCount: null,
    lastErrorDate: null,
    lastErrorPresent: false,
    matchesExpectedUrl: null
  };

  if (clientToken && typeof fetchImpl === 'function') {
    try {
      const response = await fetchImpl('https://api.telegram.org/bot' + clientToken + '/getWebhookInfo', {
        method: 'GET',
        signal: AbortSignal.timeout(10000)
      });
      const payload = await response.json();
      if (response.ok && payload?.ok === true && payload.result) {
        const actualUrl = String(payload.result.url || '');
        clientWebhook = {
          checked: true,
          configured: Boolean(actualUrl),
          reason: null,
          url: actualUrl || null,
          pendingUpdateCount: toCount(payload.result.pending_update_count),
          lastErrorDate: Number(payload.result.last_error_date) || null,
          lastErrorPresent: Boolean(payload.result.last_error_message),
          matchesExpectedUrl: expectedWebhookUrl ? actualUrl === expectedWebhookUrl : null
        };
      } else {
        clientWebhook = { ...clientWebhook, checked: true, reason: 'telegram_api_error' };
      }
    } catch (_) {
      clientWebhook = { ...clientWebhook, checked: true, reason: 'network_error' };
    }
  } else if (clientToken) {
    clientWebhook = { ...clientWebhook, reason: 'fetch_unavailable' };
  }

  return {
    worker: {
      enabled: isTelegramNotificationWorkerEnabled(env.TELEGRAM_NOTIFICATION_WORKER_ENABLED)
    },
    routing: {
      groupSubscriptionsEnabled: isTelegramGroupSubscriptionsRoutingEnabled(env.TELEGRAM_GROUP_SUBSCRIPTIONS_ROUTING_ENABLED),
      mode: isTelegramGroupSubscriptionsRoutingEnabled(env.TELEGRAM_GROUP_SUBSCRIPTIONS_ROUTING_ENABLED) ? 'group_subscriptions' : 'legacy_store_recipients',
      destinations: destinations.available
        ? { available: true, total: toCount(destinations.rows[0]?.total), enabled: toCount(destinations.rows[0]?.enabled) }
        : { available: false },
      subscriptions: subscriptions.available
        ? { available: true, total: toCount(subscriptions.rows[0]?.total), enabled: toCount(subscriptions.rows[0]?.enabled), orderEnabled: toCount(subscriptions.rows[0]?.orderEnabled), settledEnabled: toCount(subscriptions.rows[0]?.settledEnabled), refundedEnabled: toCount(subscriptions.rows[0]?.refundedEnabled) }
        : { available: false }
    },
    webhookSecret: {
      configured: secret.length >= 32 && secret.length <= 256,
      lengthValid: secret.length >= 32 && secret.length <= 256
    },
    bots: {
      admin: {
        enabled: settings.telegram_admin_bot_enabled === '1',
        tokenConfigured: Boolean(adminToken),
        businessRecipientMode: 'store_chat_id_only'
      },
      client: {
        enabled: settings.telegram_client_bot_enabled === '1',
        tokenConfigured: Boolean(clientToken),
        sharedTestChatConfigured: Boolean(settings.telegram_client_chat_id)
      }
    },
    customerBindings: bindings.available
      ? { available: true, total: toCount(bindings.rows[0]?.total), active: toCount(bindings.rows[0]?.active) }
      : { available: false },
    storeRecipients: recipients.available
      ? {
          available: true,
          total: toCount(recipients.rows[0]?.total),
          enabled: toCount(recipients.rows[0]?.enabled),
          orderEnabled: toCount(recipients.rows[0]?.orderEnabled)
        }
      : { available: false },
    outbox: outbox.available
      ? {
          available: true,
          groups: outbox.rows.map(row => ({
            state: String(row.state || ''),
            scope: String(row.recipient_scope || ''),
            errorCode: row.last_error_code ? String(row.last_error_code) : null,
            total: toCount(row.total)
          }))
        }
      : { available: false },
    clientWebhook
  };
}

async function main() {
  // env.js loads the application's .env before the database pool is created.
  require('../server/config/env');
  const { allAsync } = require('../server/db/helpers');
  const poolModule = require('../server/db/pool');
  try {
    const report = await collectTelegramDiagnostics({ allAsync });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (_) {
    process.stderr.write('Telegram diagnostics failed. Check database connectivity and application configuration.\n');
    process.exitCode = 1;
  } finally {
    await poolModule.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('Telegram diagnostics failed.\n');
    process.exitCode = 1;
  });
}

module.exports = { collectTelegramDiagnostics };
