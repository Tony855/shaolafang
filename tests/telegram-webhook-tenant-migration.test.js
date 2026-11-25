'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureTelegramCustomerBindingSchema } = require('../server/db/migrations/telegram-customer-binding');

test('existing webhook update table migrates to merchant-scoped composite idempotency key', async () => {
  const statements = [];
  let hasMerchantId = false;
  let primary = ['update_id'];
  const allAsync = async (sql, params) => {
    if (sql.includes('information_schema.COLUMNS')) {
      assert.deepEqual(params, ['telegram_webhook_updates']);
      return hasMerchantId ? [{ COLUMN_NAME: 'merchant_id' }, { COLUMN_NAME: 'update_id' }, { COLUMN_NAME: 'received_at' }]
        : [{ COLUMN_NAME: 'update_id' }, { COLUMN_NAME: 'received_at' }];
    }
    if (sql.includes('information_schema.STATISTICS')) {
      assert.deepEqual(params, ['telegram_webhook_updates', 'PRIMARY']);
      return primary.map((COLUMN_NAME, index) => ({ COLUMN_NAME, SEQ_IN_INDEX: index + 1 }));
    }
    throw new Error('Unexpected metadata query');
  };
  const runAsync = async sql => {
    statements.push(sql);
    if (sql.includes('ADD COLUMN merchant_id')) hasMerchantId = true;
    if (sql.includes('DROP PRIMARY KEY')) primary = ['merchant_id', 'update_id'];
    return { affectedRows: 0 };
  };

  await ensureTelegramCustomerBindingSchema({ runAsync, allAsync });
  assert.equal(statements.some(sql => sql.includes('ADD COLUMN merchant_id BIGINT UNSIGNED NOT NULL DEFAULT 0 FIRST')), true);
  assert.equal(statements.some(sql => sql.includes('DROP PRIMARY KEY, ADD PRIMARY KEY (merchant_id, update_id)')), true);
  assert.match(statements.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS telegram_webhook_updates')), /PRIMARY KEY \(merchant_id, update_id\)/);

  const migrationCount = statements.length;
  await ensureTelegramCustomerBindingSchema({ runAsync, allAsync });
  assert.equal(statements.slice(migrationCount).some(sql => sql.includes('ADD COLUMN merchant_id') || sql.includes('DROP PRIMARY KEY')), false);
});
