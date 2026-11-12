'use strict';

async function ensureFinancialExceptionAlertSchema({ runAsync, allAsync }) {
  if (typeof runAsync !== 'function' || typeof allAsync !== 'function') throw new TypeError('runAsync and allAsync are required');
  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_reconciliation_exception_alerts (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL, store_id INT NOT NULL, batch_id BIGINT NOT NULL, item_id BIGINT NOT NULL,
      alert_type ENUM('sla_overdue') NOT NULL DEFAULT 'sla_overdue',
      sla_hours SMALLINT UNSIGNED NOT NULL,
      status ENUM('pending','acknowledged','dismissed') NOT NULL DEFAULT 'pending',
      generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      acknowledged_by_admin_id INT DEFAULT NULL, acknowledged_by_username VARCHAR(100) DEFAULT NULL,
      acknowledged_at DATETIME(3) DEFAULT NULL, acknowledgement_reason VARCHAR(500) DEFAULT NULL,
      UNIQUE KEY unique_finance_exception_alert (merchant_id,store_id,item_id,alert_type,sla_hours),
      KEY idx_finance_exception_alert_queue (merchant_id,store_id,status,generated_at,id),
      CONSTRAINT fk_finance_exception_alert_item FOREIGN KEY (item_id)
        REFERENCES financial_reconciliation_items(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_reconciliation_exception_alert_events (
      id BIGINT PRIMARY KEY AUTO_INCREMENT, alert_id BIGINT NOT NULL,
      merchant_id INT NOT NULL, store_id INT NOT NULL, actor_admin_id INT NOT NULL,
      actor_username VARCHAR(100) NOT NULL,
      action ENUM('generated','acknowledged','dismissed') NOT NULL,
      reason VARCHAR(500) NOT NULL,
      idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      previous_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
      event_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_finance_exception_alert_event (alert_id,idempotency_key),
      KEY idx_finance_exception_alert_history (merchant_id,store_id,alert_id,id),
      CONSTRAINT fk_finance_exception_alert_event FOREIGN KEY (alert_id)
        REFERENCES financial_reconciliation_exception_alerts(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const alertCols = await allAsync('SHOW COLUMNS FROM financial_reconciliation_exception_alerts');
  const requiredAlert = ['id','merchant_id','store_id','batch_id','item_id','alert_type','sla_hours','status','generated_at','acknowledged_by_admin_id','acknowledged_by_username','acknowledged_at','acknowledgement_reason'];
  const missingAlert = requiredAlert.filter(name => !alertCols.some(col => col.Field === name));
  if (missingAlert.length) throw new Error('financial exception alert schema is incomplete: ' + missingAlert.join(', '));
  const eventCols = await allAsync('SHOW COLUMNS FROM financial_reconciliation_exception_alert_events');
  const requiredEvent = ['id','alert_id','merchant_id','store_id','actor_admin_id','actor_username','action','reason','idempotency_key','request_sha256','previous_hash','event_hash','created_at'];
  const missingEvent = requiredEvent.filter(name => !eventCols.some(col => col.Field === name));
  if (missingEvent.length) throw new Error('financial exception alert event schema is incomplete: ' + missingEvent.join(', '));
}

module.exports = { ensureFinancialExceptionAlertSchema };
