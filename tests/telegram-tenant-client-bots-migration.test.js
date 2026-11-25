'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_STATEMENTS, ensureTelegramTenantClientBotSchema } = require('../server/db/migrations/telegram-tenant-client-bots');

test('tenant Client Bot schema stores one isolated Bot and webhook credential set per merchant', async () => {
  assert.equal(SCHEMA_STATEMENTS.length, 1);
  const sql = SCHEMA_STATEMENTS[0];
  assert.match(sql, /PRIMARY KEY \(merchant_id\)/);
  assert.match(sql, /UNIQUE KEY uq_telegram_tenant_bot_token \(bot_token\)/);
  assert.match(sql, /UNIQUE KEY uq_telegram_tenant_webhook_path \(webhook_path_token\)/);
  assert.match(sql, /webhook_secret VARCHAR\(128\)/);
  assert.match(sql, /is_enabled TINYINT\(1\)/);
});

test('tenant Client Bot migration executes every schema statement and requires a database runner', async () => {
  const calls = [];
  await ensureTelegramTenantClientBotSchema({ runAsync: async sql => calls.push(sql) });
  assert.deepEqual(calls, SCHEMA_STATEMENTS);
  await assert.rejects(() => ensureTelegramTenantClientBotSchema({}), /runAsync is required/);
});
