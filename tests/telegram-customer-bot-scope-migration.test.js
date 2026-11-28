'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COLUMN_STATEMENTS, ensureTelegramCustomerBotScopeSchema } = require('../server/db/migrations/telegram-customer-bot-scope');

test('customer Bot ownership migration adds nullable bot_config_id columns and scoped indexes', async () => {
  const statements = [];
  await ensureTelegramCustomerBotScopeSchema({ runAsync: async sql => statements.push(sql) });
  assert.deepEqual(statements, COLUMN_STATEMENTS);
  assert.match(statements[0], /telegram_customer_binding_challenges ADD COLUMN bot_config_id BIGINT UNSIGNED DEFAULT NULL/);
  assert.match(statements[1], /telegram_customer_bindings ADD COLUMN bot_config_id BIGINT UNSIGNED DEFAULT NULL/);
  assert.match(statements[2], /merchant_id, bot_config_id, expires_at/);
  assert.match(statements[3], /merchant_id, bot_config_id, is_active/);
});

test('customer Bot ownership migration tolerates columns and indexes that already exist', async () => {
  await assert.doesNotReject(() => ensureTelegramCustomerBotScopeSchema({
    runAsync: async sql => {
      const error = new Error('duplicate schema object');
      if (sql.includes('ADD COLUMN')) { error.code = 'ER_DUP_FIELDNAME'; error.errno = 1060; }
      else { error.code = 'ER_DUP_KEYNAME'; error.errno = 1061; }
      throw error;
    }
  }));
});

test('customer Bot ownership migration propagates unexpected database errors', async () => {
  const failure = new Error('database unavailable');
  await assert.rejects(
    ensureTelegramCustomerBotScopeSchema({ runAsync: async () => { throw failure; } }),
    failure
  );
});
