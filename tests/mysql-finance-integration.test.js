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

  // Startup schema ensure must be safe to rerun after the tables contain production-shaped data.
  await ensureFinancialMonthCloseSchema({ runAsync, allAsync });
  const [periodsAfterEnsure] = await connection.query(
    'SELECT merchant_id,store_id FROM financial_month_close_periods ORDER BY merchant_id'
  );
  const [eventsAfterEnsure] = await connection.query(
    'SELECT merchant_id,idempotency_key FROM financial_month_close_events ORDER BY merchant_id'
  );
  assert.deepEqual(periodsAfterEnsure.map(row => Number(row.merchant_id)), [4, 5]);
  assert.deepEqual(eventsAfterEnsure.map(row => Number(row.merchant_id)), [4, 5]);

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

  // Re-running startup schema ensure must retain existing exception and SLA history.
  await ensureFinancialExceptionWorkflowSchema({ runAsync, allAsync });
  await ensureFinancialExceptionAlertSchema({ runAsync, allAsync });
  const [casesAfterEnsure] = await connection.query('SELECT merchant_id FROM financial_reconciliation_exception_cases ORDER BY merchant_id');
  const [caseEventsAfterEnsure] = await connection.query('SELECT merchant_id FROM financial_reconciliation_exception_events ORDER BY merchant_id');
  const [alertsAfterEnsure] = await connection.query('SELECT merchant_id FROM financial_reconciliation_exception_alerts ORDER BY merchant_id');
  const [alertEventsAfterEnsure] = await connection.query('SELECT merchant_id FROM financial_reconciliation_exception_alert_events ORDER BY merchant_id');
  assert.deepEqual(casesAfterEnsure.map(row => Number(row.merchant_id)), [4, 5]);
  assert.deepEqual(caseEventsAfterEnsure.map(row => Number(row.merchant_id)), [4, 5]);
  assert.deepEqual(alertsAfterEnsure.map(row => Number(row.merchant_id)), [4, 5]);
  assert.deepEqual(alertEventsAfterEnsure.map(row => Number(row.merchant_id)), [4, 5]);

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


test('MySQL integration: statement import is idempotent and rolls back conflicting row replays', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const { connection, runAsync, getAsync, allAsync } = await connectTestDatabase();
  t.after(async () => {
    try {
      await connection.query('DROP TABLE IF EXISTS financial_reconciliation_items');
      await connection.query('DROP TABLE IF EXISTS financial_reconciliation_batches');
    } finally {
      await connection.end();
    }
  });

  await connection.query('DROP TABLE IF EXISTS financial_reconciliation_items');
  await connection.query('DROP TABLE IF EXISTS financial_reconciliation_batches');
  await runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    provider_code VARCHAR(40) NOT NULL,
    external_batch_id VARCHAR(191) NOT NULL,
    statement_sha256 CHAR(64) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    row_count INT NOT NULL,
    total_debit_minor BIGINT NOT NULL,
    total_credit_minor BIGINT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported',
    imported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_financial_statement_batch (merchant_id,store_id,provider_code,external_batch_id)
  ) ENGINE=InnoDB`);
  await runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    row_no INT NOT NULL,
    external_reference VARCHAR(191) NOT NULL,
    transaction_reference VARCHAR(191) NOT NULL DEFAULT '',
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    row_sha256 CHAR(64) NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    UNIQUE KEY unique_financial_statement_row (batch_id,row_no),
    CONSTRAINT fk_finance_import_test_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  const { createFinancialReconciliationService } = require('../server/services/financial-reconciliation');
  const withTransaction = async work => {
    await connection.beginTransaction();
    try {
      const result = await work();
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  };
  const service = createFinancialReconciliationService({ runAsync, getAsync, withTransaction });
  const input = {
    merchantId: 4, storeId: 9, providerCode: 'ABA_PAYWAY',
    externalBatchId: 'mysql-import-rollback-001', statementSha256: 'a'.repeat(64),
    currencyCode: 'USD',
    rows: [
      { externalReference: 'line-1', transactionReference: 'order-1', direction: 'credit',
        amountMinor: 1200, occurredAt: '2026-11-11T02:00:00.000Z', description: 'settlement' },
      { externalReference: 'line-2', transactionReference: 'refund-2', direction: 'debit',
        amountMinor: 200, occurredAt: '2026-11-11T02:01:00.000Z', description: 'refund' }
    ]
  };

  const first = await service.importStatementBatch(input);
  assert.equal(first.importedRows, 2);
  assert.equal(first.replayed, false);
  const replay = await service.importStatementBatch(input);
  assert.equal(replay.batchId, first.batchId);
  assert.equal(replay.replayed, true);

  const changedRowReplay = {
    ...input,
    rows: input.rows.map((row, index) => index === 0 ? { ...row, description: 'conflicting content' } : row)
  };
  await assert.rejects(service.importStatementBatch(changedRowReplay),
    error => error.code === 'RECONCILIATION_ROW_CONFLICT');

  const [batches] = await connection.query(
    'SELECT id, row_count, statement_sha256 FROM financial_reconciliation_batches WHERE merchant_id=4 AND store_id=9'
  );
  const [items] = await connection.query(
    'SELECT row_no, row_sha256, description FROM financial_reconciliation_items WHERE batch_id=? ORDER BY row_no',
    [first.batchId]
  );
  assert.equal(batches.length, 1);
  assert.equal(Number(batches[0].row_count), 2);
  assert.equal(items.length, 2);
  assert.equal(items[0].description, 'settlement',
    'failed conflicting replay must roll back its attempted row mutation');
  assert.equal(items[1].description, 'refund');
});


test('MySQL integration: concurrent month-close lock contenders allow only one transition', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const firstDb = await connectTestDatabase();
  const secondDb = await connectTestDatabase();
  t.after(async () => {
    try {
      await firstDb.connection.query('DROP TABLE IF EXISTS financial_month_close_events');
      await firstDb.connection.query('DROP TABLE IF EXISTS financial_month_close_periods');
    } finally {
      await Promise.all([firstDb.connection.end(), secondDb.connection.end()]);
    }
  });

  await firstDb.connection.query('DROP TABLE IF EXISTS financial_month_close_events');
  await firstDb.connection.query('DROP TABLE IF EXISTS financial_month_close_periods');
  await ensureFinancialMonthCloseSchema({ runAsync: firstDb.runAsync, allAsync: firstDb.allAsync });

  const lockAndTransition = async db => {
    await db.connection.beginTransaction();
    try {
      const period = await lockOpenFinancialMonthPeriod({
        runAsync: db.runAsync, getAsync: db.getAsync,
        merchantId: 44, storeId: 12, periodMonth: '2026-11', currencyCode: 'USD'
      });
      await db.runAsync(
        "UPDATE financial_month_close_periods SET status='locked' WHERE id=?",
        [period.id]
      );
      await db.connection.commit();
      return Number(period.id);
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };

  const outcomes = await Promise.allSettled([
    lockAndTransition(firstDb),
    lockAndTransition(secondDb)
  ]);
  const winners = outcomes.filter(result => result.status === 'fulfilled');
  const losers = outcomes.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1, 'only one concurrent transaction may transition the open period');
  assert.equal(losers.length, 1, 'the competing transaction must observe the committed locked state');
  assert.equal(losers[0].reason.code, 'FINANCIAL_MONTH_LOCKED');
  assert.equal(winners[0].value > 0, true);

  const [periods] = await firstDb.connection.query(
    "SELECT id,status FROM financial_month_close_periods WHERE merchant_id=44 AND store_id=12 AND period_month='2026-11' AND currency_code='USD'"
  );
  assert.equal(periods.length, 1, 'the unique tenant/month/currency key must prevent duplicate periods');
  assert.equal(periods[0].status, 'locked');
});


test('MySQL integration: journal posting is balanced, idempotent, and rejects changed replays', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const db = await connectTestDatabase();
  t.after(async () => {
    try {
      await db.connection.query('DROP TABLE IF EXISTS financial_journal_entries');
      await db.connection.query('DROP TABLE IF EXISTS financial_journal_transactions');
    } finally {
      await db.connection.end();
    }
  });

  await db.connection.query('DROP TABLE IF EXISTS financial_journal_entries');
  await db.connection.query('DROP TABLE IF EXISTS financial_journal_transactions');
  await db.runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_financial_journal_idempotency (merchant_id,store_id,idempotency_key)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL DEFAULT '',
    UNIQUE KEY unique_financial_journal_line (transaction_id,line_no),
    CONSTRAINT fk_financial_journal_test_transaction FOREIGN KEY (transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  const { createFinancialLedgerService } = require('../server/services/financial-ledger-store');
  const withTransaction = async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };
  const service = createFinancialLedgerService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const draft = {
    merchantId: 44, storeId: 12, currencyCode: 'USD',
    sourceType: 'order_payment', sourceId: 'mysql-order-1001',
    idempotencyKey: 'mysql-journal:order-1001', description: 'Order payment',
    createdBy: 'mysql-integration',
    entries: [
      { accountCode: 'payment_clearing', direction: 'debit', amountMinor: 12500, memo: 'gross receipt' },
      { accountCode: 'sales_revenue', direction: 'credit', amountMinor: 12500, memo: 'recognized sale' }
    ]
  };

  const first = await service.postJournalTransaction(draft);
  const replay = await service.postJournalTransaction(draft);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.transactionId, first.transactionId);

  await assert.rejects(service.postJournalTransaction({
    ...draft,
    description: 'Changed header under same key'
  }), error => error.code === 'JOURNAL_IDEMPOTENCY_CONFLICT');
  await assert.rejects(service.postJournalTransaction({
    ...draft,
    entries: [
      { accountCode: 'payment_clearing', direction: 'debit', amountMinor: 12000, memo: 'changed amount' },
      { accountCode: 'sales_revenue', direction: 'credit', amountMinor: 12000, memo: 'changed amount' }
    ]
  }), error => error.code === 'JOURNAL_IDEMPOTENCY_CONFLICT');

  const [transactions] = await db.connection.query(
    'SELECT id,merchant_id,store_id,currency_code FROM financial_journal_transactions'
  );
  const [entries] = await db.connection.query(
    'SELECT line_no,direction,amount_minor,merchant_id,store_id FROM financial_journal_entries WHERE transaction_id=? ORDER BY line_no',
    [first.transactionId]
  );
  assert.equal(transactions.length, 1);
  assert.deepEqual([Number(transactions[0].merchant_id), Number(transactions[0].store_id), transactions[0].currency_code],
    [44, 12, 'USD']);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(row => [row.direction, Number(row.amount_minor)]),
    [['debit', 12500], ['credit', 12500]]);
  assert.ok(entries.every(row => Number(row.merchant_id) === 44 && Number(row.store_id) === 12));
});


test('MySQL integration: journal CSV export returns only the authenticated merchant and store rows', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const db = await connectTestDatabase();
  t.after(async () => {
    try {
      await db.connection.query('DROP TABLE IF EXISTS financial_journal_entries');
      await db.connection.query('DROP TABLE IF EXISTS financial_journal_transactions');
    } finally {
      await db.connection.end();
    }
  });

  await db.connection.query('DROP TABLE IF EXISTS financial_journal_entries');
  await db.connection.query('DROP TABLE IF EXISTS financial_journal_transactions');
  await db.runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY unique_financial_journal_idempotency (merchant_id,store_id,idempotency_key)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL DEFAULT '',
    UNIQUE KEY unique_financial_journal_line (transaction_id,line_no),
    CONSTRAINT fk_financial_journal_export_test_transaction FOREIGN KEY (transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  const insertTransaction = async (merchantId, storeId, currencyCode, sourceId, description) => {
    const result = await db.runAsync(
      `INSERT INTO financial_journal_transactions
        (merchant_id,store_id,currency_code,source_type,source_id,idempotency_key,description,created_by,created_at)
       VALUES (?,?,?,'order_payment',?,?,?,'integration-test','2026-11-12 10:00:00.000')`,
      [merchantId, storeId, currencyCode, sourceId, 'export-test:' + sourceId, description]
    );
    return Number(result.insertId);
  };
  const tenantATransaction = await insertTransaction(44, 12, 'USD', 'tenant-a-order', 'Tenant A journal');
  const tenantBTransaction = await insertTransaction(45, 12, 'USD', 'tenant-b-order', 'Tenant B secret');
  const otherStoreTransaction = await insertTransaction(44, 13, 'USD', 'other-store-order', 'Other store secret');
  const insertEntries = async (transactionId, merchantId, storeId, accountPrefix, amount) => {
    await db.runAsync(
      `INSERT INTO financial_journal_entries
        (transaction_id,merchant_id,store_id,line_no,account_code,direction,amount_minor,memo)
       VALUES (?,?,?,1,?,'debit',?,'cash received'),(?,?,?,2,?,'credit',?,'sale recognized')`,
      [transactionId, merchantId, storeId, accountPrefix + '_CASH', amount,
        transactionId, merchantId, storeId, accountPrefix + '_SALES', amount]
    );
  };
  await insertEntries(tenantATransaction, 44, 12, 'TENANT_A', 12500);
  await insertEntries(tenantBTransaction, 45, 12, 'TENANT_B', 9900);
  await insertEntries(otherStoreTransaction, 44, 13, 'OTHER_STORE', 7700);

  const { createFinancialVoucherExportService } = require('../server/services/financial-voucher-export');
  const exporter = createFinancialVoucherExportService({
    allAsync: db.allAsync,
    withTransaction: async work => work()
  });
  const exported = await exporter.exportJournalDetails({
    merchantId: 44, storeId: 12, from: '2026-11-12', to: '2026-11-12'
  });

  assert.equal(exported.rowCount, 2);
  assert.match(exported.csv, /TENANT_A_CASH/);
  assert.match(exported.csv, /TENANT_A_SALES/);
  assert.match(exported.csv, /12500/);
  assert.doesNotMatch(exported.csv, /TENANT_B|Other store secret|OTHER_STORE/,
    'journal export must not disclose another merchant or another store');
});


test('MySQL integration: reconciliation suggestions use only tenant/store-owned journal candidates', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const db = await connectTestDatabase();
  const tables = [
    'financial_journal_entries',
    'financial_journal_transactions',
    'financial_reconciliation_items',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await db.connection.end();
    }
  });

  for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
  await db.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    row_count INT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported'
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    row_no INT NOT NULL,
    external_reference VARCHAR(191) NOT NULL,
    transaction_reference VARCHAR(191) NOT NULL DEFAULT '',
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    match_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    match_reason VARCHAR(100) DEFAULT NULL,
    matched_journal_transaction_id BIGINT DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    exception_note VARCHAR(255) DEFAULT NULL,
    UNIQUE KEY unique_finance_match_test_row (batch_id,row_no)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL DEFAULT '',
    UNIQUE KEY unique_finance_match_test_entry (transaction_id,line_no),
    CONSTRAINT fk_finance_match_test_journal FOREIGN KEY (transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  const batchResult = await db.runAsync(
    "INSERT INTO financial_reconciliation_batches (merchant_id,store_id,currency_code,row_count,status) VALUES (44,12,'USD',1,'imported')"
  );
  const batchId = Number(batchResult.insertId);
  await db.runAsync(
    `INSERT INTO financial_reconciliation_items
      (batch_id,merchant_id,store_id,row_no,external_reference,transaction_reference,direction,amount_minor,currency_code,occurred_at,description)
     VALUES (?,44,12,1,'bank-line-1','order-match-1','credit',12500,'USD','2026-11-12 10:00:00.000','Tenant A bank row')`,
    [batchId]
  );

  const insertJournal = async (merchantId, storeId, sourceId, currencyCode, amountMinor) => {
    const result = await db.runAsync(
      `INSERT INTO financial_journal_transactions
        (merchant_id,store_id,currency_code,source_type,source_id,idempotency_key,description)
       VALUES (?, ?, ?, 'order_payment', ?, ?, 'integration candidate')`,
      [merchantId, storeId, currencyCode, sourceId, 'match-test:' + merchantId + ':' + storeId + ':' + sourceId]
    );
    const id = Number(result.insertId);
    await db.runAsync(
      `INSERT INTO financial_journal_entries
        (transaction_id,merchant_id,store_id,line_no,account_code,direction,amount_minor)
       VALUES (?, ?, ?, 1, 'cash', 'debit', ?), (?, ?, ?, 2, 'sales', 'credit', ?)`,
      [id, merchantId, storeId, amountMinor, id, merchantId, storeId, amountMinor]
    );
    return id;
  };
  const tenantACandidate = await insertJournal(44, 12, 'order-match-1', 'USD', 12500);
  await insertJournal(45, 12, 'order-match-1', 'USD', 12500);
  await insertJournal(44, 13, 'order-match-1', 'USD', 12500);
  await insertJournal(44, 12, 'order-match-1', 'KHR', 12500);
  await insertJournal(44, 12, 'unrelated-reference', 'USD', 12500);

  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const reviewService = createFinancialReconciliationReviewService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync,
    withTransaction: async work => work()
  });
  const result = await reviewService.listBatchReview({ merchantId: 44, storeId: 12, batchId });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].suggestion.status, 'suggested');
  assert.equal(result.items[0].suggestion.reason, 'exact_reference_amount_currency');
  assert.equal(result.items[0].suggestion.journalTransactionId, tenantACandidate);
  assert.equal(result.items[0].matchStatus, 'pending',
    'suggestions must remain non-mutating until an authenticated reviewer confirms a match');
});


test('MySQL integration: manual reconciliation review is transactional, tenant-scoped, and idempotent', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const db = await connectTestDatabase();
  const tables = [
    'financial_reconciliation_review_events',
    'financial_journal_entries',
    'financial_journal_transactions',
    'financial_reconciliation_items',
    'financial_journal_entries',
    'financial_journal_transactions',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await db.connection.end();
    }
  });

  for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
  await db.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    row_count INT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported'
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    matched_journal_transaction_id BIGINT DEFAULT NULL,
    match_reason VARCHAR(100) DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    exception_note VARCHAR(255) DEFAULT NULL,
    CONSTRAINT fk_finance_review_test_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL DEFAULT '',
    CONSTRAINT fk_finance_review_test_journal FOREIGN KEY (transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_review_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    batch_id BIGINT NOT NULL,
    item_id BIGINT NOT NULL,
    journal_transaction_id BIGINT DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    actor_admin_id INT NOT NULL,
    actor_username VARCHAR(100) NOT NULL,
    action VARCHAR(32) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    before_json JSON NOT NULL,
    after_json JSON NOT NULL,
    previous_hash CHAR(64) NOT NULL DEFAULT '',
    event_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_review_test_idempotency (merchant_id,store_id,batch_id,idempotency_key)
  ) ENGINE=InnoDB`);

  const batch = await db.runAsync(
    "INSERT INTO financial_reconciliation_batches (merchant_id,store_id,currency_code,row_count,status) VALUES (44,12,'USD',2,'imported')"
  );
  const batchId = Number(batch.insertId);
  await db.runAsync(
    `INSERT INTO financial_reconciliation_items
      (batch_id,merchant_id,store_id,amount_minor,currency_code,match_status)
     VALUES (?,44,12,12500,'USD','pending'),(?,44,12,10000,'USD','pending')`,
    [batchId, batchId]
  );
  const journal = await db.runAsync(
    `INSERT INTO financial_journal_transactions
      (merchant_id,store_id,currency_code,source_type,source_id,idempotency_key,description,created_by)
     VALUES (44,12,'USD','order_payment','review-order-1','review-journal:order-1','review candidate','integration-test')`
  );
  const journalId = Number(journal.insertId);
  await db.runAsync(
    `INSERT INTO financial_journal_entries
      (transaction_id,merchant_id,store_id,line_no,account_code,direction,amount_minor)
     VALUES (?,44,12,1,'cash','debit',12500),(?,44,12,2,'sales','credit',12500)`,
    [journalId, journalId]
  );

  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const withTransaction = async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };
  const service = createFinancialReconciliationReviewService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const reviewInput = {
    merchantId: 44, storeId: 12, batchId, itemId: 1,
    actorId: 7, actorUsername: 'finance-reviewer',
    action: 'confirm', journalTransactionId: journalId,
    reason: 'Confirm exact bank statement match',
    idempotencyKey: 'mysql-review-confirm-000001'
  };

  const first = await service.reviewItem(reviewInput);
  const replay = await service.reviewItem(reviewInput);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, first.eventId);

  await assert.rejects(service.reviewItem({
    ...reviewInput,
    itemId: 2,
    idempotencyKey: 'mysql-review-mismatch-000002',
    reason: 'Confirm mismatched amount'
  }), error => error.code === 'REVIEW_JOURNAL_MISMATCH');

  const [items] = await db.connection.query(
    'SELECT id,match_status,matched_journal_transaction_id FROM financial_reconciliation_items WHERE batch_id=? ORDER BY id',
    [batchId]
  );
  const [events] = await db.connection.query(
    'SELECT item_id,actor_admin_id,action FROM financial_reconciliation_review_events WHERE batch_id=? ORDER BY id',
    [batchId]
  );
  assert.equal(items[0].match_status, 'matched');
  assert.equal(Number(items[0].matched_journal_transaction_id), journalId);
  assert.equal(items[1].match_status, 'pending',
    'a journal amount mismatch must leave the statement row unchanged');
  assert.equal(items[1].matched_journal_transaction_id, null);
  assert.equal(events.length, 1, 'exact replay must not duplicate audit events and failed review must not write one');
  assert.deepEqual([Number(events[0].item_id), Number(events[0].actor_admin_id), events[0].action],
    [1, 7, 'confirm']);
});


test('MySQL integration: exception workflow transitions persist idempotent hash-linked history', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const db = await connectTestDatabase();
  const tables = [
    'financial_reconciliation_exception_events',
    'financial_reconciliation_exception_cases',
    'financial_reconciliation_items',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await db.connection.end();
    }
  });

  for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
  await db.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported'
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'exception',
    CONSTRAINT fk_finance_exception_test_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  const {
    ensureFinancialExceptionWorkflowSchema
  } = require('../server/db/migrations/financial-month-close');
  await ensureFinancialExceptionWorkflowSchema({ runAsync: db.runAsync, allAsync: db.allAsync });

  const batch = await db.runAsync(
    "INSERT INTO financial_reconciliation_batches (merchant_id,store_id,status) VALUES (44,12,'imported')"
  );
  const batchId = Number(batch.insertId);
  const item = await db.runAsync(
    "INSERT INTO financial_reconciliation_items (batch_id,merchant_id,store_id,match_status) VALUES (?,44,12,'exception')",
    [batchId]
  );
  const itemId = Number(item.insertId);

  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const withTransaction = async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };
  const service = createFinancialReconciliationReviewService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const startInput = {
    merchantId: 44, storeId: 12, batchId, itemId,
    actorId: 7, actorUsername: 'finance-exception-owner',
    action: 'start', reason: 'Start investigation of bank exception',
    idempotencyKey: 'mysql-exception-start-0001'
  };
  const started = await service.transitionExceptionCase(startInput);
  const replay = await service.transitionExceptionCase(startInput);
  assert.equal(started.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, started.eventId);
  assert.equal(started.status, 'in_progress');

  const resolved = await service.transitionExceptionCase({
    ...startInput,
    action: 'resolve',
    reason: 'Resolve after verifying source evidence',
    idempotencyKey: 'mysql-exception-resolve-0001'
  });
  assert.equal(resolved.replayed, false);
  assert.equal(resolved.status, 'resolved');

  const [cases] = await db.connection.query(
    'SELECT status,resolution_note,updated_by_admin_id FROM financial_reconciliation_exception_cases WHERE merchant_id=44 AND store_id=12 AND item_id=?',
    [itemId]
  );
  const [events] = await db.connection.query(
    'SELECT action,actor_admin_id,previous_hash,event_hash FROM financial_reconciliation_exception_events WHERE merchant_id=44 AND store_id=12 AND item_id=? ORDER BY id',
    [itemId]
  );
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, 'resolved');
  assert.equal(cases[0].resolution_note, 'Resolve after verifying source evidence');
  assert.equal(Number(cases[0].updated_by_admin_id), 7);
  assert.equal(events.length, 2, 'an exact start replay must not duplicate the event');
  assert.deepEqual(events.map(row => row.action), ['start', 'resolve']);
  assert.equal(events[0].previous_hash, '');
  assert.equal(events[1].previous_hash, events[0].event_hash);
  assert.ok(events.every(row => /^[a-f0-9]{64}$/.test(row.event_hash)));
});


test('MySQL integration: SLA alert generation, acknowledgement, dismissal, and history are idempotent', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const db = await connectTestDatabase();
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
      for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await db.connection.end();
    }
  });

  for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
  await db.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported',
    imported_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'exception',
    exception_category VARCHAR(64) DEFAULT 'bank_mismatch',
    currency_code CHAR(3) NOT NULL DEFAULT 'USD',
    amount_minor BIGINT NOT NULL DEFAULT 1000,
    external_reference VARCHAR(191) NOT NULL DEFAULT '',
    CONSTRAINT fk_finance_sla_test_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  const { ensureFinancialExceptionWorkflowSchema } = require('../server/db/migrations/financial-month-close');
  const { ensureFinancialExceptionAlertSchema } = require('../server/db/migrations/financial-exception-alerts');
  await ensureFinancialExceptionWorkflowSchema({ runAsync: db.runAsync, allAsync: db.allAsync });
  await ensureFinancialExceptionAlertSchema({ runAsync: db.runAsync, allAsync: db.allAsync });

  const batch = await db.runAsync(
    "INSERT INTO financial_reconciliation_batches (merchant_id,store_id,status,imported_at) VALUES (44,12,'imported',DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 48 HOUR))"
  );
  const batchId = Number(batch.insertId);
  await db.runAsync(
    `INSERT INTO financial_reconciliation_items
      (batch_id,merchant_id,store_id,match_status,exception_category,currency_code,amount_minor,external_reference)
     VALUES (?,44,12,'exception','bank_mismatch','USD',1000,'sla-bank-line-1'),
            (?,44,12,'exception','bank_mismatch','USD',2000,'sla-bank-line-2')`,
    [batchId, batchId]
  );

  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const withTransaction = async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };
  const service = createFinancialReconciliationReviewService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });

  const generated = await service.generateSlaAlerts({
    merchantId: 44, storeId: 12, slaHours: 24, actorId: 7, actorUsername: 'sla-generator'
  });
  assert.equal(generated.scanned, 2);
  assert.equal(generated.created, 2);
  const replayGeneration = await service.generateSlaAlerts({
    merchantId: 44, storeId: 12, slaHours: 24, actorId: 7, actorUsername: 'sla-generator'
  });
  assert.equal(replayGeneration.created, 0);
  assert.equal(replayGeneration.alreadyExisted, 2);

  const queue = await service.listSlaAlerts({ merchantId: 44, storeId: 12, status: 'all' });
  assert.equal(queue.items.length, 2);
  const [firstAlert, secondAlert] = queue.items;
  const ackInput = {
    merchantId: 44, storeId: 12, actorId: 7, actorUsername: 'sla-reviewer',
    alertId: firstAlert.alertId, reason: 'Acknowledged and assigned for investigation',
    idempotencyKey: 'mysql-sla-acknowledge-0001'
  };
  const acknowledged = await service.acknowledgeSlaAlert(ackInput);
  const ackReplay = await service.acknowledgeSlaAlert(ackInput);
  assert.equal(acknowledged.replayed, false);
  assert.equal(ackReplay.replayed, true);
  assert.equal(ackReplay.eventId, acknowledged.eventId);

  const dismissInput = {
    merchantId: 44, storeId: 12, actorId: 7, actorUsername: 'sla-reviewer',
    alertId: secondAlert.alertId, reason: 'Dismissed after verifying exception is resolved',
    idempotencyKey: 'mysql-sla-dismiss-0001'
  };
  const dismissed = await service.dismissSlaAlert(dismissInput);
  const dismissReplay = await service.dismissSlaAlert(dismissInput);
  assert.equal(dismissed.replayed, false);
  assert.equal(dismissReplay.replayed, true);
  assert.equal(dismissReplay.eventId, dismissed.eventId);

  const [alerts] = await db.connection.query(
    'SELECT id,status,acknowledged_by_admin_id FROM financial_reconciliation_exception_alerts WHERE merchant_id=44 AND store_id=12 ORDER BY id'
  );
  const alertsById = new Map(alerts.map(row => [Number(row.id), row]));
  assert.equal(alertsById.get(firstAlert.alertId).status, 'acknowledged');
  assert.equal(alertsById.get(secondAlert.alertId).status, 'dismissed');
  assert.equal(Number(alertsById.get(firstAlert.alertId).acknowledged_by_admin_id), 7);
  const firstHistory = await service.listSlaAlertHistory({
    merchantId: 44, storeId: 12, alertId: firstAlert.alertId
  });
  assert.equal(firstHistory.items.length, 2);
  assert.deepEqual(firstHistory.items.map(row => row.action), ['acknowledged', 'generated']);
  assert.equal(firstHistory.items[0].previousHash, firstHistory.items[1].eventHash);
});


test('MySQL integration: month-close approval enforces maker-checker, readiness retry, and hash history', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const db = await connectTestDatabase();
  const tables = [
    'financial_month_close_events',
    'financial_month_close_periods',
    'financial_reconciliation_items',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await db.connection.end();
    }
  });

  for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
  await db.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    imported_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    CONSTRAINT fk_finance_month_close_test_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  const { ensureFinancialMonthCloseSchema } = require('../server/db/migrations/financial-month-close');
  await ensureFinancialMonthCloseSchema({ runAsync: db.runAsync, allAsync: db.allAsync });

  const batch = await db.runAsync(
    "INSERT INTO financial_reconciliation_batches (merchant_id,store_id,currency_code,imported_at) VALUES (44,12,'USD','2026-11-12 10:00:00.000')"
  );
  const batchId = Number(batch.insertId);
  const item = await db.runAsync(
    "INSERT INTO financial_reconciliation_items (batch_id,merchant_id,store_id,match_status) VALUES (?,44,12,'matched')",
    [batchId]
  );
  const itemId = Number(item.insertId);

  const { createFinancialMonthCloseService } = require('../server/services/financial-month-close');
  const withTransaction = async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };
  const service = createFinancialMonthCloseService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const request = {
    merchantId: 44, storeId: 12, month: '2026-11', currencyCode: 'USD',
    actorId: 7, actorUsername: 'month-maker',
    action: 'request_close', reason: 'Request November month close',
    idempotencyKey: 'mysql-month-close-request-001'
  };
  const requested = await service.transition(request);
  const requestReplay = await service.transition(request);
  assert.equal(requested.status, 'close_pending');
  assert.equal(requested.replayed, false);
  assert.equal(requestReplay.replayed, true);
  assert.equal(requestReplay.eventId, requested.eventId);

  await assert.rejects(service.transition({
    ...request,
    actorId: 7,
    action: 'approve_close',
    reason: 'Approve November month close',
    idempotencyKey: 'mysql-month-close-maker-approve'
  }), error => error.code === 'MONTH_CLOSE_MAKER_CHECKER_REQUIRED');

  await db.runAsync("UPDATE financial_reconciliation_items SET match_status='pending' WHERE id=?", [itemId]);
  const approvalInput = {
    ...request,
    actorId: 8, actorUsername: 'month-checker',
    action: 'approve_close',
    reason: 'Approve November month close after review',
    idempotencyKey: 'mysql-month-close-approval-001'
  };
  await assert.rejects(service.transition(approvalInput),
    error => error.code === 'MONTH_CLOSE_NOT_READY');
  const afterFailedApproval = await service.getPeriod({
    merchantId: 44, storeId: 12, month: '2026-11', currencyCode: 'USD'
  });
  assert.equal(afterFailedApproval.status, 'close_pending',
    'failed readiness approval must roll back without losing the pending request');

  await db.runAsync("UPDATE financial_reconciliation_items SET match_status='matched' WHERE id=?", [itemId]);
  const approved = await service.transition(approvalInput);
  const approvalReplay = await service.transition(approvalInput);
  assert.equal(approved.status, 'locked');
  assert.equal(approved.replayed, false);
  assert.equal(approvalReplay.replayed, true);

  const period = await service.getPeriod({
    merchantId: 44, storeId: 12, month: '2026-11', currencyCode: 'USD'
  });
  const history = await service.listHistory({
    merchantId: 44, storeId: 12, month: '2026-11', currencyCode: 'USD'
  });
  assert.equal(period.status, 'locked');
  assert.equal(period.lockedByAdminId, 8);
  assert.equal(history.items.length, 2);
  assert.deepEqual(history.items.map(row => row.action), ['approve_close', 'request_close']);
  assert.equal(history.items[0].previousHash, history.items[1].eventHash);
  assert.ok(history.items.every(row => /^[a-f0-9]{64}$/.test(row.eventHash)));
});


test('MySQL integration: statement import flows through journal match, review, month close, and CSV export', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 45000
}, async t => {
  const db = await connectTestDatabase();
  const tables = [
    'financial_month_close_events',
    'financial_month_close_periods',
    'financial_reconciliation_review_events',
    'financial_journal_entries',
    'financial_journal_transactions',
    'financial_reconciliation_items',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await db.connection.end();
    }
  });
  for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);

  await db.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    provider_code VARCHAR(40) NOT NULL,
    external_batch_id VARCHAR(191) NOT NULL,
    statement_sha256 CHAR(64) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    row_count INT NOT NULL,
    total_debit_minor BIGINT NOT NULL,
    total_credit_minor BIGINT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported',
    imported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_e2e_batch (merchant_id,store_id,provider_code,external_batch_id)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    row_no INT NOT NULL,
    external_reference VARCHAR(191) NOT NULL,
    transaction_reference VARCHAR(191) NOT NULL DEFAULT '',
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    row_sha256 CHAR(64) NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    match_reason VARCHAR(100) DEFAULT NULL,
    matched_journal_transaction_id BIGINT DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    exception_note VARCHAR(255) DEFAULT NULL,
    UNIQUE KEY unique_finance_e2e_row (batch_id,row_no),
    CONSTRAINT fk_finance_e2e_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_e2e_journal (merchant_id,store_id,idempotency_key)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL DEFAULT '',
    UNIQUE KEY unique_finance_e2e_journal_line (transaction_id,line_no),
    CONSTRAINT fk_finance_e2e_journal FOREIGN KEY (transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_review_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    batch_id BIGINT NOT NULL,
    item_id BIGINT NOT NULL,
    journal_transaction_id BIGINT DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    actor_admin_id INT NOT NULL,
    actor_username VARCHAR(100) NOT NULL,
    action VARCHAR(32) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    before_json JSON NOT NULL,
    after_json JSON NOT NULL,
    previous_hash CHAR(64) NOT NULL DEFAULT '',
    event_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_e2e_review_idempotency (merchant_id,store_id,batch_id,idempotency_key)
  ) ENGINE=InnoDB`);
  await ensureFinancialMonthCloseSchema({ runAsync: db.runAsync, allAsync: db.allAsync });

  const withTransaction = async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };

  const { createFinancialReconciliationService } = require('../server/services/financial-reconciliation');
  const reconciliation = createFinancialReconciliationService({
    runAsync: db.runAsync, getAsync: db.getAsync, withTransaction
  });
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const imported = await reconciliation.importStatementBatch({
    merchantId: 44, storeId: 12, providerCode: 'BANK_STMT',
    externalBatchId: 'mysql-e2e-batch-0001',
    statementSha256: 'e'.repeat(64), currencyCode: 'USD',
    rows: [{
      externalReference: 'mysql-e2e-order-0001',
      transactionReference: 'mysql-e2e-order-0001',
      direction: 'credit', amountMinor: 12500, currencyCode: 'USD',
      occurredAt: today + 'T10:00:00.000Z', description: 'E2E bank settlement'
    }]
  });
  assert.equal(imported.importedRows, 1);
  assert.equal(imported.replayed, false);

  const { createFinancialLedgerService } = require('../server/services/financial-ledger-store');
  const ledger = createFinancialLedgerService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const posted = await ledger.postJournalTransaction({
    merchantId: 44, storeId: 12, currencyCode: 'USD',
    sourceType: 'order_payment', sourceId: 'mysql-e2e-order-0001',
    idempotencyKey: 'mysql-e2e-journal-000001',
    description: 'E2E order settlement', createdBy: 'mysql-e2e',
    entries: [
      { accountCode: 'payment_clearing', direction: 'debit', amountMinor: 12500, memo: 'bank settlement' },
      { accountCode: 'sales_revenue', direction: 'credit', amountMinor: 12500, memo: 'order revenue' }
    ]
  });
  assert.equal(posted.replayed, false);

  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const review = createFinancialReconciliationReviewService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const suggestion = await review.listBatchReview({
    merchantId: 44, storeId: 12, batchId: imported.batchId
  });
  assert.equal(suggestion.items.length, 1);
  assert.equal(suggestion.items[0].suggestion.status, 'suggested');
  assert.equal(suggestion.items[0].suggestion.journalTransactionId, posted.transactionId);

  const item = await db.getAsync(
    'SELECT id FROM financial_reconciliation_items WHERE batch_id=? AND merchant_id=44 AND store_id=12 AND row_no=1',
    [imported.batchId]
  );
  const confirmed = await review.reviewItem({
    merchantId: 44, storeId: 12, batchId: imported.batchId, itemId: Number(item.id),
    actorId: 7, actorUsername: 'mysql-e2e-reviewer',
    action: 'confirm', journalTransactionId: posted.transactionId,
    reason: 'Confirm exact journal and bank statement match',
    idempotencyKey: 'mysql-e2e-review-000001'
  });
  assert.equal(confirmed.replayed, false);
  const preview = await review.getMonthlyClosePreview({
    merchantId: 44, storeId: 12, month
  });
  assert.equal(preview.length, 1);
  assert.equal(preview[0].currencyCode, 'USD');
  assert.equal(preview[0].matchedCount, 1);
  assert.equal(preview[0].unresolvedCount, 0);
  assert.equal(preview[0].closeReady, true);

  const { createFinancialMonthCloseService } = require('../server/services/financial-month-close');
  const monthClose = createFinancialMonthCloseService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const closeRequest = {
    merchantId: 44, storeId: 12, month, currencyCode: 'USD',
    actorId: 7, actorUsername: 'mysql-e2e-maker',
    action: 'request_close', reason: 'Request E2E month close',
    idempotencyKey: 'mysql-e2e-close-request-01'
  };
  const requested = await monthClose.transition(closeRequest);
  assert.equal(requested.status, 'close_pending');
  const approved = await monthClose.transition({
    ...closeRequest,
    actorId: 8, actorUsername: 'mysql-e2e-checker',
    action: 'approve_close', reason: 'Approve E2E month close after review',
    idempotencyKey: 'mysql-e2e-close-approve-01'
  });
  assert.equal(approved.status, 'locked');

  const { createFinancialVoucherExportService } = require('../server/services/financial-voucher-export');
  const exporter = createFinancialVoucherExportService({
    allAsync: db.allAsync, withTransaction
  });
  const exported = await exporter.exportJournalDetails({
    merchantId: 44, storeId: 12, from: today, to: today
  });
  assert.equal(exported.rowCount, 2);
  assert.match(exported.csv, /mysql-e2e-order-0001/);
  assert.match(exported.csv, /12500/);

  const [persistedRows] = await db.connection.query(
    `SELECT b.status AS batch_status, i.match_status, i.matched_journal_transaction_id,
            p.status AS period_status, COUNT(DISTINCT je.id) AS journal_line_count
     FROM financial_reconciliation_batches b
     INNER JOIN financial_reconciliation_items i ON i.batch_id=b.id
       AND i.merchant_id=b.merchant_id AND i.store_id=b.store_id
     INNER JOIN financial_month_close_periods p ON p.merchant_id=b.merchant_id
       AND p.store_id=b.store_id AND p.period_month=? AND p.currency_code=b.currency_code
     INNER JOIN financial_journal_entries je ON je.transaction_id=i.matched_journal_transaction_id
       AND je.merchant_id=i.merchant_id AND je.store_id=i.store_id
     WHERE b.id=? AND b.merchant_id=44 AND b.store_id=12
     GROUP BY b.id,i.id,p.id`,
    [month, imported.batchId]
  );
  const persisted = persistedRows[0];
  assert.ok(persisted, 'end-to-end persisted linkage row must exist');
  assert.equal(persisted.batch_status, 'imported');
  assert.equal(persisted.match_status, 'matched');
  assert.equal(Number(persisted.matched_journal_transaction_id), posted.transactionId);
  assert.equal(persisted.period_status, 'locked');
  assert.equal(Number(persisted.journal_line_count), 2);
});


test('MySQL integration: unmatched statement flows through exception classification, case, and SLA alert', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 45000
}, async t => {
  const db = await connectTestDatabase();
  const tables = [
    'financial_reconciliation_exception_alert_events',
    'financial_reconciliation_exception_alerts',
    'financial_reconciliation_exception_events',
    'financial_reconciliation_exception_cases',
    'financial_reconciliation_review_events',
    'financial_reconciliation_items',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await db.connection.end();
    }
  });
  for (const table of tables) await db.connection.query('DROP TABLE IF EXISTS ' + table);

  await db.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    provider_code VARCHAR(40) NOT NULL,
    external_batch_id VARCHAR(191) NOT NULL,
    statement_sha256 CHAR(64) NOT NULL,
    currency_code CHAR(3) NOT NULL,
    row_count INT NOT NULL,
    total_debit_minor BIGINT NOT NULL,
    total_credit_minor BIGINT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported',
    imported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_exception_e2e_batch (merchant_id,store_id,provider_code,external_batch_id)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    row_no INT NOT NULL,
    external_reference VARCHAR(191) NOT NULL,
    transaction_reference VARCHAR(191) NOT NULL DEFAULT '',
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    row_sha256 CHAR(64) NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    match_reason VARCHAR(100) DEFAULT NULL,
    matched_journal_transaction_id BIGINT DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    exception_note VARCHAR(255) DEFAULT NULL,
    UNIQUE KEY unique_finance_exception_e2e_row (batch_id,row_no),
    CONSTRAINT fk_finance_exception_e2e_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT '',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB`);
  await db.runAsync(`CREATE TABLE financial_reconciliation_review_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    batch_id BIGINT NOT NULL,
    item_id BIGINT NOT NULL,
    journal_transaction_id BIGINT DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    actor_admin_id INT NOT NULL,
    actor_username VARCHAR(100) NOT NULL,
    action VARCHAR(32) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    before_json JSON NOT NULL,
    after_json JSON NOT NULL,
    previous_hash CHAR(64) NOT NULL DEFAULT '',
    event_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_exception_e2e_review_idempotency (merchant_id,store_id,batch_id,idempotency_key)
  ) ENGINE=InnoDB`);

  const { ensureFinancialExceptionWorkflowSchema } = require('../server/db/migrations/financial-month-close');
  const { ensureFinancialExceptionAlertSchema } = require('../server/db/migrations/financial-exception-alerts');
  await ensureFinancialExceptionWorkflowSchema({ runAsync: db.runAsync, allAsync: db.allAsync });
  await ensureFinancialExceptionAlertSchema({ runAsync: db.runAsync, allAsync: db.allAsync });

  const withTransaction = async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };
  const { createFinancialReconciliationService } = require('../server/services/financial-reconciliation');
  const importer = createFinancialReconciliationService({
    runAsync: db.runAsync, getAsync: db.getAsync, withTransaction
  });
  const today = new Date().toISOString().slice(0, 10);
  const imported = await importer.importStatementBatch({
    merchantId: 44, storeId: 12, providerCode: 'BANK_STMT',
    externalBatchId: 'mysql-exception-e2e-0001',
    statementSha256: 'f'.repeat(64), currencyCode: 'USD',
    rows: [{
      externalReference: 'mysql-exception-e2e-line-1',
      transactionReference: 'unposted-order-1',
      direction: 'credit', amountMinor: 8750, currencyCode: 'USD',
      occurredAt: today + 'T09:00:00.000Z', description: 'Unmatched bank settlement'
    }]
  });
  assert.equal(imported.importedRows, 1);
  await db.runAsync(
    'UPDATE financial_reconciliation_batches SET imported_at=DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 48 HOUR) WHERE id=? AND merchant_id=44 AND store_id=12',
    [imported.batchId]
  );

  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const review = createFinancialReconciliationReviewService({
    runAsync: db.runAsync, getAsync: db.getAsync, allAsync: db.allAsync, withTransaction
  });
  const queue = await review.listBatchReview({
    merchantId: 44, storeId: 12, batchId: imported.batchId
  });
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].suggestion.status, 'unmatched');

  const itemId = queue.items[0].id;
  const classified = await review.reviewItem({
    merchantId: 44, storeId: 12, batchId: imported.batchId, itemId,
    actorId: 7, actorUsername: 'mysql-exception-reviewer',
    action: 'classify_exception', exceptionCategory: 'settlement_difference',
    reason: 'Classify unmatched bank settlement for investigation',
    idempotencyKey: 'mysql-exception-e2e-review-01'
  });
  assert.equal(classified.replayed, false);

  const started = await review.transitionExceptionCase({
    merchantId: 44, storeId: 12, batchId: imported.batchId, itemId,
    actorId: 7, actorUsername: 'mysql-exception-owner',
    action: 'start', reason: 'Start investigation of unmatched settlement',
    idempotencyKey: 'mysql-exception-e2e-start-01'
  });
  assert.equal(started.status, 'in_progress');

  const generated = await review.generateSlaAlerts({
    merchantId: 44, storeId: 12, slaHours: 24,
    actorId: 7, actorUsername: 'mysql-exception-sla'
  });
  assert.equal(generated.scanned, 1);
  assert.equal(generated.created, 1);
  const alertQueue = await review.listSlaAlerts({
    merchantId: 44, storeId: 12, status: 'pending'
  });
  assert.equal(alertQueue.items.length, 1);
  const alertId = alertQueue.items[0].alertId;
  const acknowledged = await review.acknowledgeSlaAlert({
    merchantId: 44, storeId: 12, actorId: 8, actorUsername: 'mysql-sla-checker',
    alertId, reason: 'Acknowledge overdue exception for investigation',
    idempotencyKey: 'mysql-exception-e2e-ack-01'
  });
  assert.equal(acknowledged.replayed, false);

  const resolved = await review.transitionExceptionCase({
    merchantId: 44, storeId: 12, batchId: imported.batchId, itemId,
    actorId: 8, actorUsername: 'mysql-exception-resolver',
    action: 'resolve', reason: 'Resolve after verifying settlement evidence',
    idempotencyKey: 'mysql-exception-e2e-resolve-01'
  });
  assert.equal(resolved.status, 'resolved');

  const [itemRows] = await db.connection.query(
    'SELECT match_status,exception_category,exception_note FROM financial_reconciliation_items WHERE id=? AND merchant_id=44 AND store_id=12',
    [itemId]
  );
  const [caseRows] = await db.connection.query(
    'SELECT status,resolution_note,updated_by_admin_id FROM financial_reconciliation_exception_cases WHERE item_id=? AND merchant_id=44 AND store_id=12',
    [itemId]
  );
  const [eventRows] = await db.connection.query(
    'SELECT action,previous_hash,event_hash FROM financial_reconciliation_exception_events WHERE item_id=? AND merchant_id=44 AND store_id=12 ORDER BY id',
    [itemId]
  );
  const alertHistory = await review.listSlaAlertHistory({
    merchantId: 44, storeId: 12, alertId
  });
  assert.equal(itemRows[0].match_status, 'exception');
  assert.equal(itemRows[0].exception_category, 'settlement_difference');
  assert.equal(caseRows[0].status, 'resolved');
  assert.equal(caseRows[0].resolution_note, 'Resolve after verifying settlement evidence');
  assert.equal(Number(caseRows[0].updated_by_admin_id), 8);
  assert.deepEqual(eventRows.map(row => row.action), ['start', 'resolve']);
  assert.equal(eventRows[0].previous_hash, '');
  assert.equal(eventRows[1].previous_hash, eventRows[0].event_hash);
  assert.deepEqual(alertHistory.items.map(row => row.action), ['acknowledged', 'generated']);
  assert.equal(alertHistory.items[0].previousHash, alertHistory.items[1].eventHash);
});


test('MySQL integration: concurrent manual reviews cannot assign one journal transaction twice', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 30000
}, async t => {
  const firstDb = await connectTestDatabase();
  const secondDb = await connectTestDatabase();
  const tables = [
    'financial_reconciliation_review_events',
    'financial_journal_entries',
    'financial_journal_transactions',
    'financial_reconciliation_items',
    'financial_reconciliation_batches'
  ];
  t.after(async () => {
    try {
      for (const table of tables) await firstDb.connection.query('DROP TABLE IF EXISTS ' + table);
    } finally {
      await Promise.all([firstDb.connection.end(), secondDb.connection.end()]);
    }
  });
  for (const table of tables) await firstDb.connection.query('DROP TABLE IF EXISTS ' + table);

  await firstDb.runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    row_count INT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'imported'
  ) ENGINE=InnoDB`);
  await firstDb.runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    batch_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    amount_minor BIGINT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    match_status VARCHAR(24) NOT NULL DEFAULT 'pending',
    matched_journal_transaction_id BIGINT DEFAULT NULL,
    match_reason VARCHAR(100) DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    exception_note VARCHAR(255) DEFAULT NULL,
    CONSTRAINT fk_finance_concurrent_review_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await firstDb.runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    currency_code CHAR(3) NOT NULL,
    source_type VARCHAR(40) NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB`);
  await firstDb.runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL,
    direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT NOT NULL,
    memo VARCHAR(255) NOT NULL DEFAULT '',
    CONSTRAINT fk_finance_concurrent_review_journal FOREIGN KEY (transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await firstDb.runAsync(`CREATE TABLE financial_reconciliation_review_events (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    merchant_id INT NOT NULL,
    store_id INT NOT NULL,
    batch_id BIGINT NOT NULL,
    item_id BIGINT NOT NULL,
    journal_transaction_id BIGINT DEFAULT NULL,
    exception_category VARCHAR(64) DEFAULT NULL,
    actor_admin_id INT NOT NULL,
    actor_username VARCHAR(100) NOT NULL,
    action VARCHAR(32) NOT NULL,
    reason VARCHAR(500) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL,
    before_json JSON NOT NULL,
    after_json JSON NOT NULL,
    previous_hash CHAR(64) NOT NULL DEFAULT '',
    event_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_concurrent_review_idempotency (merchant_id,store_id,batch_id,idempotency_key)
  ) ENGINE=InnoDB`);

  const batch = await firstDb.runAsync(
    "INSERT INTO financial_reconciliation_batches (merchant_id,store_id,currency_code,row_count,status) VALUES (44,12,'USD',2,'imported')"
  );
  const batchId = Number(batch.insertId);
  await firstDb.runAsync(
    `INSERT INTO financial_reconciliation_items
      (batch_id,merchant_id,store_id,amount_minor,currency_code,match_status)
     VALUES (?,44,12,12500,'USD','pending'),(?,44,12,12500,'USD','pending')`,
    [batchId, batchId]
  );
  const [itemRows] = await firstDb.connection.query(
    'SELECT id FROM financial_reconciliation_items WHERE batch_id=? ORDER BY id',
    [batchId]
  );
  const journal = await firstDb.runAsync(
    `INSERT INTO financial_journal_transactions
      (merchant_id,store_id,currency_code,source_type,source_id,idempotency_key,description,created_by)
     VALUES (44,12,'USD','order_payment','concurrent-order-1','concurrent-journal-0001','shared journal','integration-test')`
  );
  const journalId = Number(journal.insertId);
  await firstDb.runAsync(
    `INSERT INTO financial_journal_entries
      (transaction_id,merchant_id,store_id,line_no,account_code,direction,amount_minor)
     VALUES (?,44,12,1,'cash','debit',12500),(?,44,12,2,'sales','credit',12500)`,
    [journalId, journalId]
  );

  const transactionFor = db => async work => {
    await db.connection.beginTransaction();
    try {
      const result = await work();
      await db.connection.commit();
      return result;
    } catch (error) {
      await db.connection.rollback();
      throw error;
    }
  };
  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const serviceA = createFinancialReconciliationReviewService({
    runAsync: firstDb.runAsync, getAsync: firstDb.getAsync, allAsync: firstDb.allAsync,
    withTransaction: transactionFor(firstDb)
  });
  const serviceB = createFinancialReconciliationReviewService({
    runAsync: secondDb.runAsync, getAsync: secondDb.getAsync, allAsync: secondDb.allAsync,
    withTransaction: transactionFor(secondDb)
  });
  const makeInput = (itemId, actorId, suffix) => ({
    merchantId: 44, storeId: 12, batchId, itemId,
    actorId, actorUsername: 'concurrent-reviewer-' + actorId,
    action: 'confirm', journalTransactionId: journalId,
    reason: 'Confirm shared journal candidate under concurrent review',
    idempotencyKey: 'mysql-concurrent-review-' + suffix
  });
  const outcomes = await Promise.allSettled([
    serviceA.reviewItem(makeInput(Number(itemRows[0].id), 7, 'item-0001')),
    serviceB.reviewItem(makeInput(Number(itemRows[1].id), 8, 'item-0002'))
  ]);
  const winners = outcomes.filter(result => result.status === 'fulfilled');
  const losers = outcomes.filter(result => result.status === 'rejected');
  assert.equal(winners.length, 1, 'only one concurrent review may claim the same journal transaction');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, 'REVIEW_DUPLICATE_ASSIGNMENT');

  const [finalItems] = await firstDb.connection.query(
    'SELECT id,match_status,matched_journal_transaction_id FROM financial_reconciliation_items WHERE batch_id=? ORDER BY id',
    [batchId]
  );
  const [events] = await firstDb.connection.query(
    'SELECT item_id,actor_admin_id,action FROM financial_reconciliation_review_events WHERE batch_id=? ORDER BY id',
    [batchId]
  );
  const assigned = finalItems.filter(row => row.match_status === 'matched');
  const pending = finalItems.filter(row => row.match_status === 'pending');
  assert.equal(assigned.length, 1);
  assert.equal(pending.length, 1);
  assert.equal(Number(assigned[0].matched_journal_transaction_id), journalId);
  assert.equal(events.length, 1, 'the losing transaction must not write a review event');
  assert.equal(Number(events[0].item_id), Number(assigned[0].id));
  assert.ok([7, 8].includes(Number(events[0].actor_admin_id)));
});
