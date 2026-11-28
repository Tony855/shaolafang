'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_STATEMENTS,
  ensureTelegramMerchantBotSchema
} = require('../server/db/migrations/telegram-merchant-bots');

test('tenant Telegram Bot migration creates tenant-scoped Bot configuration and update deduplication tables', async () => {
  const statements = [];
  await ensureTelegramMerchantBotSchema({ runAsync: async sql => { statements.push(sql); } });
  assert.deepEqual(statements, SCHEMA_STATEMENTS);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS telegram_merchant_bots/);
  assert.match(statements[0], /UNIQUE KEY uq_telegram_merchant_bots_merchant \(merchant_id\)/);
  assert.match(statements[0], /client_bot_token_encrypted TEXT/);
  assert.match(statements[0], /admin_bot_token_encrypted TEXT/);
  assert.match(statements[0], /webhook_path_hash CHAR\(64\)/);
  assert.match(statements[1], /PRIMARY KEY \(bot_config_id, update_id\)/);
  assert.match(statements[1], /FOREIGN KEY \(bot_config_id\) REFERENCES telegram_merchant_bots\(id\)/);
});

test('tenant Telegram Bot migration requires the database executor', async () => {
  await assert.rejects(() => ensureTelegramMerchantBotSchema({}), /runAsync is required/);
});
