'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const {
  FINANCIAL_BACKUP_TABLES
} = require('../server/services/backup-schema');
const {
  ensureFinancialMonthCloseSchema,
  ensureFinancialExceptionWorkflowSchema
} = require('../server/db/migrations/financial-month-close');
const { ensureFinancialExceptionAlertSchema } = require('../server/db/migrations/financial-exception-alerts');

const databaseUrl = process.env.MYSQL_INTEGRATION_URL;

async function connectDatabase() {
  const connection = await mysql.createConnection(databaseUrl);
  return {
    connection,
    runAsync: async (sql, params = []) => {
      const [result] = await connection.query(sql, params);
      return result;
    },
    allAsync: async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      return rows;
    }
  };
}

async function readSnapshot(allAsync) {
  const snapshot = {};
  for (const table of FINANCIAL_BACKUP_TABLES) {
    snapshot[table] = await allAsync('SELECT * FROM `' + table + '` ORDER BY id');
  }
  return snapshot;
}

function restoreValue(value) {
  if (value instanceof Date || Buffer.isBuffer(value) || value === null || value === undefined) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

async function replaceSnapshot({ runAsync, snapshot }) {
  for (const table of [...FINANCIAL_BACKUP_TABLES].reverse()) {
    await runAsync('DELETE FROM `' + table + '`');
  }
  for (const table of FINANCIAL_BACKUP_TABLES) {
    for (const row of snapshot[table]) {
      const columns = Object.keys(row);
      if (!columns.length) continue;
      const placeholders = columns.map(() => '?').join(',');
      const values = columns.map(column => restoreValue(row[column]));
      await runAsync(
        'INSERT INTO `' + table + '` (' + columns.map(column => '`' + column + '`').join(',') +
        ') VALUES (' + placeholders + ')',
        values
      );
    }
  }
}

test('MySQL integration: financial backup restores the full journal/reconciliation/exception/SLA/month-close graph atomically', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 180000
}, async t => {
  const db = await connectDatabase();
  const { connection, runAsync, allAsync } = db;
  t.after(async () => {
    try {
      for (const table of [...FINANCIAL_BACKUP_TABLES].reverse()) {
        await connection.query('DROP TABLE IF EXISTS `' + table + '`');
      }
    } finally {
      await connection.end();
    }
  });
  for (const table of [...FINANCIAL_BACKUP_TABLES].reverse()) {
    await connection.query('DROP TABLE IF EXISTS `' + table + '`');
  }

  await runAsync(`CREATE TABLE financial_journal_transactions (
    id BIGINT PRIMARY KEY,
    merchant_id INT NOT NULL, store_id INT NOT NULL, currency_code CHAR(3) NOT NULL,
    source_type VARCHAR(40) NOT NULL, source_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL, description VARCHAR(255) NOT NULL DEFAULT '',
    created_by VARCHAR(100) NOT NULL DEFAULT '', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_backup_journal (merchant_id,store_id,idempotency_key)
  ) ENGINE=InnoDB`);
  await runAsync(`CREATE TABLE financial_journal_entries (
    id BIGINT PRIMARY KEY, transaction_id BIGINT NOT NULL,
    merchant_id INT NOT NULL, store_id INT NOT NULL, line_no INT NOT NULL,
    account_code VARCHAR(64) NOT NULL, direction ENUM('debit','credit') NOT NULL,
    amount_minor BIGINT UNSIGNED NOT NULL, memo VARCHAR(255) NOT NULL DEFAULT '',
    UNIQUE KEY unique_finance_backup_entry (transaction_id,line_no),
    CONSTRAINT fk_finance_backup_entry_tx FOREIGN KEY (transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await runAsync(`CREATE TABLE financial_reconciliation_batches (
    id BIGINT PRIMARY KEY, merchant_id INT NOT NULL, store_id INT NOT NULL,
    provider_code VARCHAR(40) NOT NULL, external_batch_id VARCHAR(191) NOT NULL,
    statement_sha256 CHAR(64) NOT NULL, currency_code CHAR(3) NOT NULL,
    row_count INT UNSIGNED NOT NULL, total_debit_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
    total_credit_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('imported','validated','closed') NOT NULL DEFAULT 'imported',
    imported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    validated_at DATETIME(3) DEFAULT NULL, closed_at DATETIME(3) DEFAULT NULL,
    UNIQUE KEY unique_finance_backup_batch (merchant_id,store_id,provider_code,external_batch_id)
  ) ENGINE=InnoDB`);
  await runAsync(`CREATE TABLE financial_reconciliation_items (
    id BIGINT PRIMARY KEY, batch_id BIGINT NOT NULL, merchant_id INT NOT NULL, store_id INT NOT NULL,
    row_no INT UNSIGNED NOT NULL, external_reference VARCHAR(191) NOT NULL,
    transaction_reference VARCHAR(191) NOT NULL DEFAULT '',
    direction ENUM('debit','credit') NOT NULL, amount_minor BIGINT UNSIGNED NOT NULL,
    currency_code CHAR(3) NOT NULL, occurred_at DATETIME(3) NOT NULL,
    description VARCHAR(255) NOT NULL DEFAULT '', row_sha256 CHAR(64) NOT NULL,
    match_status ENUM('pending','matched','unmatched','ambiguous','exception') NOT NULL DEFAULT 'pending',
    match_reason VARCHAR(128) DEFAULT NULL, matched_journal_transaction_id BIGINT DEFAULT NULL,
    exception_category ENUM('refund','fee','settlement_difference','chargeback','other') DEFAULT NULL,
    exception_note VARCHAR(500) DEFAULT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_backup_row (batch_id,row_no),
    UNIQUE KEY unique_reconciliation_journal_assignment (matched_journal_transaction_id),
    CONSTRAINT fk_finance_backup_item_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT,
    CONSTRAINT fk_finance_backup_item_journal FOREIGN KEY (matched_journal_transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await runAsync(`CREATE TABLE financial_reconciliation_review_events (
    id BIGINT PRIMARY KEY, merchant_id INT NOT NULL, store_id INT NOT NULL,
    batch_id BIGINT NOT NULL, item_id BIGINT NOT NULL, journal_transaction_id BIGINT DEFAULT NULL,
    exception_category ENUM('refund','fee','settlement_difference','chargeback','other') DEFAULT NULL,
    actor_admin_id INT NOT NULL, actor_username VARCHAR(100) NOT NULL,
    action ENUM('confirm','reject','release','reassign','classify_exception') NOT NULL,
    reason VARCHAR(500) NOT NULL, idempotency_key VARCHAR(128) NOT NULL,
    request_sha256 CHAR(64) NOT NULL, before_json JSON NOT NULL, after_json JSON NOT NULL,
    previous_hash CHAR(64) DEFAULT NULL, event_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_review_idempotency (merchant_id,store_id,batch_id,idempotency_key),
    CONSTRAINT fk_finance_backup_review_batch FOREIGN KEY (batch_id)
      REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT,
    CONSTRAINT fk_finance_backup_review_item FOREIGN KEY (item_id)
      REFERENCES financial_reconciliation_items(id) ON DELETE RESTRICT,
    CONSTRAINT fk_finance_backup_review_journal FOREIGN KEY (journal_transaction_id)
      REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
  await ensureFinancialMonthCloseSchema({ runAsync, allAsync });
  await ensureFinancialExceptionWorkflowSchema({ runAsync, allAsync });
  await ensureFinancialExceptionAlertSchema({ runAsync, allAsync });
  await runAsync(`CREATE TABLE provider_webhook_events (
    id BIGINT PRIMARY KEY, provider_code VARCHAR(40) NOT NULL, provider_event_id VARCHAR(191) NOT NULL,
    merchant_id INT NOT NULL, store_id INT NOT NULL, event_type VARCHAR(100) NOT NULL DEFAULT '',
    provider_transaction_id VARCHAR(191) NOT NULL DEFAULT '', payload_sha256 CHAR(64) NOT NULL,
    normalized_event_json JSON NOT NULL, auth_status VARCHAR(24) NOT NULL,
    processing_status VARCHAR(24) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_finance_backup_provider_event (provider_code,provider_event_id)
  ) ENGINE=InnoDB`);

  await runAsync(`INSERT INTO financial_journal_transactions
    (id,merchant_id,store_id,currency_code,source_type,source_id,idempotency_key,description,created_by)
    VALUES (10,4,9,'USD','order_payment','order-1','journal-backup-001','payment','finance-a')`);
  await runAsync(`INSERT INTO financial_journal_entries
    (id,transaction_id,merchant_id,store_id,line_no,account_code,direction,amount_minor,memo)
    VALUES (20,10,4,9,1,'cash_clearing','debit',100,'backup evidence')`);
  await runAsync(
    `INSERT INTO financial_reconciliation_batches
      (id,merchant_id,store_id,provider_code,external_batch_id,statement_sha256,currency_code,row_count,total_debit_minor,total_credit_minor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [30,4,9,'GENERIC','batch-backup-001','a'.repeat(64),'USD',1,100,100]
  );
  await runAsync(`INSERT INTO financial_reconciliation_items
    (id,batch_id,merchant_id,store_id,row_no,external_reference,direction,amount_minor,currency_code,occurred_at,description,row_sha256,match_status,matched_journal_transaction_id,exception_category)
    VALUES (40,30,4,9,1,'bank-ref-1','credit',100,'USD','2026-11-12 10:00:00','matched row','${'b'.repeat(64)}','matched',10,'fee')`);
  await runAsync(`INSERT INTO financial_reconciliation_review_events
    (id,merchant_id,store_id,batch_id,item_id,journal_transaction_id,actor_admin_id,actor_username,action,reason,idempotency_key,request_sha256,before_json,after_json,previous_hash,event_hash)
    VALUES (50,4,9,30,40,10,7,'finance-a','confirm','manual confirmation','backup-review-0001','${'c'.repeat(64)}','{"status":"pending"}','{"status":"matched"}','${'d'.repeat(64)}','${'e'.repeat(64)}')`);
  await runAsync(`INSERT INTO financial_reconciliation_exception_cases
    (id,merchant_id,store_id,batch_id,item_id,status,created_by_admin_id,updated_by_admin_id)
    VALUES (60,4,9,30,40,'resolved',7,7)`);
  await runAsync(`INSERT INTO financial_reconciliation_exception_events
    (id,merchant_id,store_id,batch_id,item_id,actor_admin_id,actor_username,action,reason,before_json,after_json,idempotency_key,request_sha256,previous_hash,event_hash)
    VALUES (70,4,9,30,40,7,'finance-a','resolve','verified','{"status":"open"}','{"status":"resolved"}','backup-exception-0001','${'f'.repeat(64)}','','${'1'.repeat(64)}')`);
  await runAsync(`INSERT INTO financial_reconciliation_exception_alerts
    (id,merchant_id,store_id,batch_id,item_id,sla_hours,status)
    VALUES (80,4,9,30,40,24,'acknowledged')`);
  await runAsync(`INSERT INTO financial_reconciliation_exception_alert_events
    (id,alert_id,merchant_id,store_id,actor_admin_id,actor_username,action,reason,idempotency_key,request_sha256,previous_hash,event_hash)
    VALUES (90,80,4,9,7,'finance-a','acknowledged','reviewed','backup-alert-0001','${'2'.repeat(64)}','','${'3'.repeat(64)}')`);
  await runAsync(`INSERT INTO financial_month_close_periods
    (id,merchant_id,store_id,period_month,currency_code,status)
    VALUES (100,4,9,'2026-11','USD','close_pending')`);
  await runAsync(`INSERT INTO financial_month_close_events
    (id,period_id,merchant_id,store_id,period_month,currency_code,action,actor_admin_id,actor_username,reason,before_status,after_status,idempotency_key,request_sha256,previous_hash,event_hash)
    VALUES (110,100,4,9,'2026-11','USD','request_close',7,'finance-a','close review','open','close_pending','backup-close-0001','${'4'.repeat(64)}','','${'5'.repeat(64)}')`);
  await runAsync(`INSERT INTO provider_webhook_events
    (id,provider_code,provider_event_id,merchant_id,store_id,payload_sha256,normalized_event_json,auth_status,processing_status)
    VALUES (120,'GENERIC','event-backup-001',4,9,'${'6'.repeat(64)}','{"orderReference":"order-1"}','verified','received')`);

  const snapshot = await readSnapshot(allAsync);
  for (const table of FINANCIAL_BACKUP_TABLES) {
    assert.equal(snapshot[table].length, 1, table + ' must be present in the full finance snapshot');
  }

  await connection.beginTransaction();
  try {
    for (const table of [...FINANCIAL_BACKUP_TABLES].reverse()) {
      await runAsync('DELETE FROM `' + table + '`');
    }
    await connection.rollback();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
  const afterInterruptedRestore = await readSnapshot(allAsync);
  for (const table of FINANCIAL_BACKUP_TABLES) {
    assert.equal(afterInterruptedRestore[table].length, 1,
      table + ' must survive an interrupted restore rollback');
  }

  await connection.beginTransaction();
  try {
    await replaceSnapshot({ runAsync, snapshot });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
  const restored = await readSnapshot(allAsync);
  for (const table of FINANCIAL_BACKUP_TABLES) {
    assert.equal(restored[table].length, 1, table + ' must be restored');
    assert.equal(Number(restored[table][0].id), Number(snapshot[table][0].id));
  }
  assert.equal(restored.financial_reconciliation_review_events[0].event_hash, snapshot.financial_reconciliation_review_events[0].event_hash);
  assert.equal(Number(restored.financial_reconciliation_items[0].amount_minor), 100);
  await assert.rejects(
    runAsync('DELETE FROM financial_reconciliation_batches WHERE id=30'),
    error => error && error.code === 'ER_ROW_IS_REFERENCED_2'
  );
});
