'use strict';

const COLUMN_STATEMENTS = [
  'ALTER TABLE telegram_customer_binding_challenges ADD COLUMN bot_config_id BIGINT UNSIGNED DEFAULT NULL AFTER merchant_id',
  'ALTER TABLE telegram_customer_bindings ADD COLUMN bot_config_id BIGINT UNSIGNED DEFAULT NULL AFTER merchant_id',
  'ALTER TABLE telegram_customer_binding_challenges ADD KEY idx_telegram_customer_challenge_bot (merchant_id, bot_config_id, expires_at)',
  'ALTER TABLE telegram_customer_bindings ADD KEY idx_telegram_customer_binding_bot (merchant_id, bot_config_id, is_active)'
];

async function ensureTelegramCustomerBotScopeSchema({ runAsync }) {
  if (typeof runAsync !== 'function') throw new TypeError('runAsync is required');
  for (const statement of COLUMN_STATEMENTS) {
    try {
      await runAsync(statement);
    } catch (error) {
      const duplicateColumn = error?.code === 'ER_DUP_FIELDNAME' || error?.errno === 1060;
      const duplicateIndex = error?.code === 'ER_DUP_KEYNAME' || error?.errno === 1061;
      if (!duplicateColumn && !duplicateIndex) throw error;
    }
  }
}

module.exports = { COLUMN_STATEMENTS, ensureTelegramCustomerBotScopeSchema };
