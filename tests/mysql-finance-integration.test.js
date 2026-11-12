'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const {
  ensureFinancialMonthCloseSchema,
  ensureFinancialExceptionWorkflowSchema,
  lockOpenFinancialMonthPeriod
} = require('../server/db/migrations/financial-month-close');
const { ensureFinancialExceptionAlertSchema } = require('../server/db/migrations/financial-exception-alerts');

const databaseUrl = process.env.MYSQL_INTEGRATION_URL;

async function connectTestDatabase() {
  const connection = await mysql.createConnection(databaseUrl);
  return {
    connection,
    runAsync: async (sql, params = []) => {
      const [result] = await connection.query(sql, params);
      return result;
    },
    getAsync: async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      return rows[0] || null;
    },
    allAsync: async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      return rows;
    }
  };
}

test('MySQL integration: month-close migration, tenant uniqueness, idempotency and row locking', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const { connection, runAsync, getAsync, allAsync } = await connectTestDatabase();
  t.after(async () => {
    try {
      await connection.query('DROP TABLE IF EXISTS financial_month_close_events');
      await connection.query('DROP TABLE IF EXISTS financial_month_close_periods');
    } finally {
      await connection.end();
    }
  });

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
  const insertMonthEvent = params => runAsync(
    `INSERT INTO financial_month_close_events
      (period_id,merchant_id,store_id,period_month,currency_code,action,
       actor_admin_id,actor_username,reason,before_status,after_status,
       idempotency_key,request_sha256,previous_hash,event_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params
  );
  await insertMonthEvent(eventParams);
  await assert.rejects(insertMonthEvent(eventParams),
    error => error && error.code === 'ER_DUP_ENTRY');

  const tenantBEvent = [...eventParams];
  tenantBEvent[0] = tenantBPeriod;
  tenantBEvent[1] = 5;
  tenantBEvent[6] = 8;
  tenantBEvent[7] = 'finance-b';
  await insertMonthEvent(tenantBEvent);

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
  try {
    await assert.rejects(lockOpenFinancialMonthPeriod({
      runAsync, getAsync, merchantId: 4, storeId: 9,
      periodMonth: '2026-11', currencyCode: 'USD'
    }), error => error.code === 'FINANCIAL_MONTH_LOCKED');
  } finally {
    await connection.rollback();
  }

  const [events] = await connection.query(
    'SELECT merchant_id,store_id,idempotency_key FROM financial_month_close_events ORDER BY id'
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(row => Number(row.merchant_id)), [4, 5]);
});

test('MySQL integration: exception workflow and SLA alert schemas enforce foreign keys and idempotency', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const { connection, runAsync, allAsync } = await connectTestDatabase();
  const tables = [
    'financial_reconciliation_exception_alert_events',
    'financial_reconciliation_exception_alerts',
    'financial_reconciliation_exception_events',
    'financial_reconciliation_exception_cases',
    'financial_reconciliation_items',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await connection.end();
    }
  });

  for (const table of tables) await connection.query('DROP TABLE IF EXISTS ' + table);
  await runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT
  ) ENGINE=InnoDB`);
  await runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL
  ) ENGINE=InnoDB`);

  await ensureFinancialExceptionWorkflowSchema({ runAsync, allAsync });
  await ensureFinancialExceptionAlertSchema({ runAsync, allAsync });

  const [caseColumns] = await connection.query('SHOW COLUMNS FROM financial_reconciliation_exception_cases');
  const [caseEventColumns] = await connection.query('SHOW COLUMNS FROM financial_reconciliation_exception_events');
  const [alertColumns] = await connection.query('SHOW COLUMNS FROM financial_reconciliation_exception_alerts');
  const [alertEventColumns] = await connection.query('SHOW COLUMNS FROM financial_reconciliation_exception_alert_events');
  assert.ok(caseColumns.some(column => column.Field === 'assigned_admin_id'));
  assert.ok(caseEventColumns.some(column => column.Field === 'event_hash'));
  assert.ok(alertColumns.some(column => column.Field === 'acknowledged_at'));
  assert.ok(alertEventColumns.some(column => column.Field === 'request_sha256'));

  await runAsync('INSERT INTO financial_reconciliation_batches (id) VALUES (10),(11)');
  await runAsync('INSERT INTO financial_reconciliation_items (id,batch_id) VALUES (100,10),(101,11)');
  const insertCase = async (merchantId, itemId, batchId, adminId) => {
    const result = await runAsync(
      `INSERT INTO financial_reconciliation_exception_cases
        (merchant_id,store_id,batch_id,item_id,status,created_by_admin_id,updated_by_admin_id)
       VALUES (?,9,?,?, 'open',?,?)`,
      [merchantId, batchId, itemId, adminId, adminId]
    );
    return Number(result.insertId);
  };
  const caseA = await insertCase(4, 100, 10, 7);
  const caseB = await insertCase(5, 101, 11, 8);
  assert.notEqual(caseA, caseB);

  const insertCaseEvent = (merchantId, itemId, batchId, key, adminId) => runAsync(
    `INSERT INTO financial_reconciliation_exception_events
      (merchant_id,store_id,batch_id,item_id,actor_admin_id,actor_username,action,reason,
       before_json,after_json,idempotency_key,request_sha256,previous_hash,event_hash)
     VALUES (?,9,?,?,?,'finance','start','integration test',JSON_OBJECT('status','open'),
       JSON_OBJECT('status','in_progress'),?,?, '', ?)`,
    [merchantId, batchId, itemId, adminId, key, 'a'.repeat(64), 'b'.repeat(64)]
  );
  await insertCaseEvent(4, 100, 10, 'mysql-exception-event-0001', 7);
  await assert.rejects(
    insertCaseEvent(4, 100, 10, 'mysql-exception-event-0001', 7),
    error => error && error.code === 'ER_DUP_ENTRY'
  );
  await insertCaseEvent(5, 101, 11, 'mysql-exception-event-0001', 8);

  await assert.rejects(
    insertCase(6, 999, 10, 9),
    error => error && error.code === 'ER_NO_REFERENCED_ROW_2'
  );

  const insertAlert = async (merchantId, itemId, batchId) => {
    const result = await runAsync(
      `INSERT INTO financial_reconciliation_exception_alerts
        (merchant_id,store_id,batch_id,item_id,sla_hours)
       VALUES (?,9,?,?,24)`,
      [merchantId, batchId, itemId]
    );
    return Number(result.insertId);
  };
  const alertA = await insertAlert(4, 100, 10);
  const alertB = await insertAlert(5, 101, 11);
  await assert.rejects(insertAlert(4, 100, 10),
    error => error && error.code === 'ER_DUP_ENTRY');

  const insertAlertEvent = (alertId, merchantId, key, adminId) => runAsync(
    `INSERT INTO financial_reconciliation_exception_alert_events
      (alert_id,merchant_id,store_id,actor_admin_id,actor_username,action,reason,
       idempotency_key,request_sha256,previous_hash,event_hash)
     VALUES (?,?,9,?,'finance','acknowledged','integration test',?,?, '', ?)`,
    [alertId, merchantId, adminId, key, 'c'.repeat(64), 'd'.repeat(64)]
  );
  await insertAlertEvent(alertA, 4, 'mysql-alert-event-0001', 7);
  await assert.rejects(
    insertAlertEvent(alertA, 4, 'mysql-alert-event-0001', 7),
    error => error && error.code === 'ER_DUP_ENTRY'
  );
  await insertAlertEvent(alertB, 5, 'mysql-alert-event-0001', 8);

  const [cases] = await connection.query(
    'SELECT merchant_id,store_id,item_id FROM financial_reconciliation_exception_cases ORDER BY id'
  );
  const [events] = await connection.query(
    'SELECT merchant_id,item_id,idempotency_key FROM financial_reconciliation_exception_events ORDER BY id'
  );
  const [alerts] = await connection.query(
    'SELECT merchant_id,item_id,status FROM financial_reconciliation_exception_alerts ORDER BY id'
  );
  assert.deepEqual(cases.map(row => Number(row.merchant_id)), [4, 5]);
  assert.deepEqual(events.map(row => Number(row.merchant_id)), [4, 5]);
  assert.deepEqual(alerts.map(row => Number(row.merchant_id)), [4, 5]);
  assert.ok(alerts.every(row => row.status === 'pending'));
});
