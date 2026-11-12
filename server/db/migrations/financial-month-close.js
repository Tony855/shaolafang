'use strict';

async function ensureFinancialMonthCloseSchema({ runAsync, allAsync }) {
  if (typeof runAsync !== 'function' || typeof allAsync !== 'function') {
    throw new TypeError('runAsync and allAsync are required');
  }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_month_close_periods (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      period_month CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      status ENUM('open','close_pending','locked','reopen_pending') NOT NULL DEFAULT 'open',
      pending_action ENUM('close','reopen') DEFAULT NULL,
      pending_actor_admin_id INT DEFAULT NULL,
      pending_actor_username VARCHAR(100) DEFAULT NULL,
      pending_reason VARCHAR(500) DEFAULT NULL,
      locked_by_admin_id INT DEFAULT NULL,
      locked_at DATETIME(3) DEFAULT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_financial_month_period (merchant_id, store_id, period_month, currency_code),
      KEY idx_financial_month_period_status (merchant_id, store_id, status, period_month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_month_close_events (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      period_id BIGINT NOT NULL,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      period_month CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      action ENUM('request_close','approve_close','reject_close','request_reopen','approve_reopen','reject_reopen') NOT NULL,
      actor_admin_id INT NOT NULL,
      actor_username VARCHAR(100) NOT NULL,
      reason VARCHAR(500) NOT NULL,
      before_status VARCHAR(24) NOT NULL,
      after_status VARCHAR(24) NOT NULL,
      idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      previous_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
      event_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_financial_month_close_idempotency (period_id, idempotency_key),
      KEY idx_financial_month_close_event_history (period_id, id),
      KEY idx_financial_month_close_event_tenant (merchant_id, store_id, period_month, currency_code, created_at),
      CONSTRAINT fk_financial_month_close_event_period FOREIGN KEY (period_id)
        REFERENCES financial_month_close_periods(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const periodColumns = await allAsync('SHOW COLUMNS FROM financial_month_close_periods');
  const periodNames = new Set(periodColumns.map(column => column.Field));
  const requiredPeriodColumns = [
    'id', 'merchant_id', 'store_id', 'period_month', 'currency_code', 'status',
    'pending_action', 'pending_actor_admin_id', 'pending_actor_username',
    'pending_reason', 'locked_by_admin_id', 'locked_at', 'created_at', 'updated_at'
  ];
  const missingPeriodColumns = requiredPeriodColumns.filter(name => !periodNames.has(name));
  if (missingPeriodColumns.length) {
    throw new Error('financial_month_close_periods schema is incomplete: ' + missingPeriodColumns.join(', '));
  }

  const eventColumns = await allAsync('SHOW COLUMNS FROM financial_month_close_events');
  const eventNames = new Set(eventColumns.map(column => column.Field));
  const requiredEventColumns = [
    'id', 'period_id', 'merchant_id', 'store_id', 'period_month', 'currency_code',
    'action', 'actor_admin_id', 'actor_username', 'reason', 'before_status',
    'after_status', 'idempotency_key', 'request_sha256', 'previous_hash',
    'event_hash', 'created_at'
  ];
  const missingEventColumns = requiredEventColumns.filter(name => !eventNames.has(name));
  if (missingEventColumns.length) {
    throw new Error('financial_month_close_events schema is incomplete: ' + missingEventColumns.join(', '));
  }

  const periodIndexes = await allAsync('SHOW INDEX FROM financial_month_close_periods');
  if (!periodIndexes.some(index => index.Key_name === 'unique_financial_month_period')) {
    const duplicate = await allAsync(
      `SELECT merchant_id, store_id, period_month, currency_code, COUNT(*) AS duplicate_count
       FROM financial_month_close_periods
       GROUP BY merchant_id, store_id, period_month, currency_code
       HAVING COUNT(*) > 1 LIMIT 1`
    );
    if (duplicate.length) throw new Error('duplicate financial month close periods must be resolved before migration');
    await runAsync('CREATE UNIQUE INDEX unique_financial_month_period ON financial_month_close_periods (merchant_id, store_id, period_month, currency_code)');
  }

  const eventIndexes = await allAsync('SHOW INDEX FROM financial_month_close_events');
  if (!eventIndexes.some(index => index.Key_name === 'unique_financial_month_close_idempotency')) {
    const duplicate = await allAsync(
      `SELECT period_id, idempotency_key, COUNT(*) AS duplicate_count
       FROM financial_month_close_events
       GROUP BY period_id, idempotency_key
       HAVING COUNT(*) > 1 LIMIT 1`
    );
    if (duplicate.length) throw new Error('duplicate financial month close idempotency keys must be resolved before migration');
    await runAsync('CREATE UNIQUE INDEX unique_financial_month_close_idempotency ON financial_month_close_events (period_id, idempotency_key)');
  }
}

async function lockOpenFinancialMonthPeriod({ runAsync, getAsync, merchantId, storeId, periodMonth, currencyCode }) {
  if (!Number.isSafeInteger(Number(merchantId)) || Number(merchantId) <= 0 ||
      !Number.isSafeInteger(Number(storeId)) || Number(storeId) <= 0) {
    throw new TypeError('merchantId and storeId must be positive safe integers');
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodMonth || '')) ||
      !/^[A-Z]{3}$/.test(String(currencyCode || ''))) {
    throw new TypeError('periodMonth or currencyCode is invalid');
  }
  await runAsync(
    `INSERT INTO financial_month_close_periods
      (merchant_id, store_id, period_month, currency_code, status)
     VALUES (?, ?, ?, ?, 'open')
     ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
    [merchantId, storeId, periodMonth, currencyCode]
  );
  const period = await getAsync(
    `SELECT id, status FROM financial_month_close_periods
     WHERE merchant_id=? AND store_id=? AND period_month=? AND currency_code=?
     FOR UPDATE`,
    [merchantId, storeId, periodMonth, currencyCode]
  );
  if (!period) throw new Error('financial month close period could not be locked');
  if (period.status !== 'open') {
    const error = new Error('financial month is pending approval or locked');
    error.code = 'FINANCIAL_MONTH_LOCKED';
    throw error;
  }
  return period;
}

module.exports = { ensureFinancialMonthCloseSchema, lockOpenFinancialMonthPeriod };
