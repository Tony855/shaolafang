'use strict';

const WEBHOOK_PATH = '/api/telegram/client/webhook';
const TENANT_WEBHOOK_PATH = '/api/telegram/tenant/';
const DEFAULT_TENANT_WEBHOOK_CHECK_LIMIT = 25;
const { decryptBotToken, loadKey } = require('../server/services/telegram-bot-credentials');
const { isTelegramNotificationWorkerEnabled } = require('../server/services/telegram-notification-worker-runtime');
const { isTelegramGroupSubscriptionsRoutingEnabled } = require('../server/services/telegram-notification-routing');

function toCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function encryptionKeyStatus(value) {
  const configured = Boolean(String(value || '').trim());
  try {
    loadKey(value === undefined || value === null ? '' : value);
    return { configured, valid: true };
  } catch (_) {
    return { configured, valid: false };
  }
}

async function inspectTenantBots({ rows, env, fetchImpl, expectedBase, limit }) {
  const list = Array.isArray(rows) ? rows : [];
  const keyStatus = encryptionKeyStatus(env.TELEGRAM_BOT_ENCRYPTION_KEY);
  const clientEnabled = list.filter(row => Number(row.client_bot_enabled) === 1);
  const adminEnabled = list.filter(row => Number(row.admin_bot_enabled) === 1);
  const results = [];
  let attempted = 0;

  for (const row of clientEnabled.slice(0, limit)) {
    const result = {
      merchantId: toCount(row.merchant_id),
      botConfigId: toCount(row.id),
      enabled: true,
      tokenConfigured: Boolean(row.client_bot_token_encrypted),
      webhookConfigured: false,
      matchesExpectedUrl: null,
      pendingUpdateCount: null,
      lastErrorDate: null,
      lastErrorPresent: false,
      reason: null
    };

    if (!row.client_bot_token_encrypted || !row.webhook_path_token_encrypted || !row.webhook_secret_encrypted) {
      result.reason = 'tenant_credentials_incomplete';
      results.push(result);
      continue;
    }
    if (!keyStatus.valid) {
      result.reason = keyStatus.configured ? 'encryption_key_invalid' : 'encryption_key_missing';
      results.push(result);
      continue;
    }

    let token;
    let pathToken;
    try {
      token = decryptBotToken(row.client_bot_token_encrypted, { key: String(env.TELEGRAM_BOT_ENCRYPTION_KEY || '') });
      pathToken = decryptBotToken(row.webhook_path_token_encrypted, { key: env.TELEGRAM_BOT_ENCRYPTION_KEY });
      // Confirm that the webhook secret can also be recovered without returning it.
      decryptBotToken(row.webhook_secret_encrypted, { key: env.TELEGRAM_BOT_ENCRYPTION_KEY });
    } catch (_) {
      result.reason = 'credential_decryption_failed';
      results.push(result);
      continue;
    }

    if (typeof fetchImpl !== 'function') {
      result.reason = 'fetch_unavailable';
      results.push(result);
      continue;
    }

    attempted += 1;
    try {
      const response = await fetchImpl('https://api.telegram.org/bot' + token + '/getWebhookInfo', {
        method: 'GET',
        signal: AbortSignal.timeout(10000)
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true || !payload.result) {
        result.reason = 'telegram_api_error';
      } else {
        const actualUrl = String(payload.result.url || '');
        result.webhookConfigured = Boolean(actualUrl);
        result.matchesExpectedUrl = expectedBase
          ? actualUrl === expectedBase + TENANT_WEBHOOK_PATH + pathToken + '/client/webhook'
          : null;
        result.pendingUpdateCount = toCount(payload.result.pending_update_count);
        result.lastErrorDate = Number(payload.result.last_error_date) || null;
        result.lastErrorPresent = Boolean(payload.result.last_error_message);
      }
    } catch (_) {
      result.reason = 'network_error';
    }
    results.push(result);
  }

  return {
    available: true,
    total: list.length,
    clientEnabled: clientEnabled.length,
    clientTokenConfigured: list.filter(row => Boolean(row.client_bot_token_encrypted)).length,
    adminEnabled: adminEnabled.length,
    adminTokenConfigured: list.filter(row => Boolean(row.admin_bot_token_encrypted)).length,
    encryptionKey: keyStatus,
    webhookChecks: {
      limit,
      attempted,
      checked: results.length,
      remaining: Math.max(0, clientEnabled.length - results.length),
      results
    }
  };
}

async function safeQuery(allAsync, sql) {
  try {
    return { available: true, rows: await allAsync(sql) };
  } catch (_) {
    // Do not print SQL errors: drivers may include database or schema details.
    return { available: false, rows: [] };
  }
}

async function collectTelegramDiagnostics({ allAsync, env = process.env, fetchImpl = globalThis.fetch, tenantWebhookCheckLimit = DEFAULT_TENANT_WEBHOOK_CHECK_LIMIT } = {}) {
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

  const tenantLimit = Math.max(0, Math.min(100, toCount(tenantWebhookCheckLimit)));
  const [bindings, recipients, outbox, destinations, subscriptions, tenantBotRows] = await Promise.all([
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(is_active=1 AND revoked_at IS NULL), 0) AS active FROM telegram_customer_bindings'),
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(chat_id<>\'\'), 0) AS enabled, COALESCE(SUM(chat_id<>\'\' AND notify_order_created=1), 0) AS orderEnabled FROM telegram_store_admin_recipients'),
    safeQuery(allAsync,
      'SELECT state, recipient_scope, last_error_code, COUNT(*) AS total FROM telegram_notification_outbox GROUP BY state, recipient_scope, last_error_code ORDER BY state, recipient_scope, last_error_code'),
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(is_enabled=1), 0) AS enabled FROM telegram_chat_destinations'),
    safeQuery(allAsync,
      'SELECT COUNT(*) AS total, COALESCE(SUM(is_enabled=1), 0) AS enabled, COALESCE(SUM(is_enabled=1 AND notify_order_created=1), 0) AS orderEnabled, COALESCE(SUM(is_enabled=1 AND notify_settled=1), 0) AS settledEnabled, COALESCE(SUM(is_enabled=1 AND notify_refunded=1), 0) AS refundedEnabled FROM telegram_store_subscriptions'),
    safeQuery(allAsync,
      'SELECT id, merchant_id, client_bot_enabled, client_bot_token_encrypted, admin_bot_enabled, admin_bot_token_encrypted, webhook_path_token_encrypted, webhook_secret_encrypted FROM telegram_merchant_bots ORDER BY merchant_id, id')
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

  const tenantBots = tenantBotRows.available
    ? await inspectTenantBots({ rows: tenantBotRows.rows, env, fetchImpl, expectedBase, limit: tenantLimit })
    : { available: false, encryptionKey: encryptionKeyStatus(env.TELEGRAM_BOT_ENCRYPTION_KEY) };

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
    tenantBots,
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

module.exports = { collectTelegramDiagnostics, inspectTenantBots, encryptionKeyStatus, DEFAULT_TENANT_WEBHOOK_CHECK_LIMIT };
