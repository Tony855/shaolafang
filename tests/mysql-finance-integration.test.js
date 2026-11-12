'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const {
  ensureFinancialMonthCloseSchema,
  lockOpenFinancialMonthPeriod
} = require('../server/db/migrations/financial-month-close');

const databaseUrl = process.env.MYSQL_INTEGRATION_URL;

test('MySQL integration: month-close migration, tenant uniqueness, idempotency and row locking', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const connection = await mysql.createConnection(databaseUrl);
  t.after(async () => {
    try {
      await connection.query('DROP TABLE IF EXISTS financial_month_close_events');
      await connection.query('DROP TABLE IF EXISTS financial_month_close_periods');
    } finally {
      await connection.end();
    }
  });

  const runAsync = async (sql, params = []) => {
    const [result] = await connection.query(sql, params);
    return result;
  };
  const getAsync = async (sql, params = []) => {
    const [rows] = await connection.query(sql, params);
    return rows[0] || null;
  };
  const allAsync = async (sql, params = []) => {
    const [rows] = await connection.query(sql, params);
    return rows;
  };

  await connection.query('DROP TABLE IF EXISTS financial_month_close_events');
  await connection.query('DROP TABLE IF EXISTS financial_month_close_periods');
  await ensureFinancialMonthCloseSchema({ runAsync, allAsync });

  const [periodColumns] = await connection.query('SHOW COLUMNS FROM financial_month_close_periods');
  const [eventColumns] = await connection.query('SHOW COLUMNS FROM financial_month_close_events');
  assert.ok(periodColumns.some(column => column.Field === 'merchant_id'));
  assert.ok(eventColumns.some(column => column.Field === 'event_hash'));

  const insertPeriod = async (merchantId, storeId) => {
    const result = await runAsync(
      'INSERT INTO financial_month_close_periods (merchant_id,store_id,period_month,currency_code) VALUES (?,?,?,?)',
      [merchantId, storeId, '2026-11', 'USD']
    );
    return Number(result.insertId);
  };

  const tenantAPeriod = await insertPeriod(4, 9);
  const tenantBPeriod = await insertPeriod(5, 9);
  assert.notEqual(tenantAPeriod, tenantBPeriod,
    'the same month/currency must be independently representable for different merchants');

  const eventParams = [
    tenantAPeriod, 4, 9, '2026-11', 'USD', 'request_close',
    7, 'finance-a', 'close evidence', 'open', 'close_pending',
    'mysql-integration-idempotency-001', 'a'.repeat(64), '', 'b'.repeat(64)
  ];
  await runAsync(
    `INSERT INTO financial_month_close_events
      (period_id,merchant_id,store_id,period_month,currency_code,action,
       actor_admin_id,actor_username,reason,before_status,after_status,
       idempotency_key,request_sha256,previous_hash,event_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    eventParams
  );
  await assert.rejects(
    runAsync(
      `INSERT INTO financial_month_close_events
        (period_id,merchant_id,store_id,period_month,currency_code,action,
         actor_admin_id,actor_username,reason,before_status,after_status,
         idempotency_key,request_sha256,previous_hash,event_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      eventParams
    ),
    error => error && error.code === 'ER_DUP_ENTRY'
  );

  const tenantBEvent = [...eventParams];
  tenantBEvent[0] = tenantBPeriod;
  tenantBEvent[1] = 5;
  tenantBEvent[6] = 8;
  tenantBEvent[7] = 'finance-b';
  await runAsync(
    `INSERT INTO financial_month_close_events
      (period_id,merchant_id,store_id,period_month,currency_code,action,
       actor_admin_id,actor_username,reason,before_status,after_status,
       idempotency_key,request_sha256,previous_hash,event_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    tenantBEvent
  );

  await connection.beginTransaction();
  try {
    const locked = await lockOpenFinancialMonthPeriod({
      runAsync, getAsync, merchantId: 4, storeId: 9,
      periodMonth: '2026-11', currencyCode: 'USD'
    });
    assert.equal(Number(locked.id), tenantAPeriod);
    await runAsync(
      "UPDATE financial_month_close_periods SET status='locked' WHERE id=?",
      [tenantAPeriod]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  await connection.beginTransaction();
  await assert.rejects(lockOpenFinancialMonthPeriod({
    runAsync, getAsync, merchantId: 4, storeId: 9,
    periodMonth: '2026-11', currencyCode: 'USD'
  }), error => error.code === 'FINANCIAL_MONTH_LOCKED');
  await connection.rollback();

  const [events] = await connection.query(
    'SELECT merchant_id,store_id,idempotency_key FROM financial_month_close_events ORDER BY id'
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(row => Number(row.merchant_id)), [4, 5]);
});
