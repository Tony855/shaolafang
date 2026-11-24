'use strict';

async function ensureDeliverySchema({ runAsync, allAsync }) {
  if (typeof runAsync !== 'function' || typeof allAsync !== 'function') throw new TypeError('runAsync and allAsync are required');
  await runAsync(`
    CREATE TABLE IF NOT EXISTS delivery_riders (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      username VARCHAR(80) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(120) NOT NULL,
      phone VARCHAR(40) NOT NULL DEFAULT '',
      active TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_delivery_rider_store_username (store_id, username),
      KEY idx_delivery_rider_tenant (merchant_id, store_id, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await runAsync(`
    CREATE TABLE IF NOT EXISTS delivery_rider_sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      rider_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_delivery_rider_session_token (token_hash),
      KEY idx_delivery_rider_session_expiry (rider_id, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await runAsync(`
    CREATE TABLE IF NOT EXISTS delivery_jobs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      order_id INT NOT NULL,
      rider_id BIGINT UNSIGNED DEFAULT NULL,
      recipient_name VARCHAR(120) NOT NULL DEFAULT '',
      recipient_phone VARCHAR(40) NOT NULL DEFAULT '',
      delivery_address VARCHAR(500) NOT NULL,
      status ENUM('assigned','accepted','picked_up','delivering','delivered','cancelled') NOT NULL DEFAULT 'assigned',
      assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      accepted_at DATETIME(3) DEFAULT NULL,
      picked_up_at DATETIME(3) DEFAULT NULL,
      delivered_at DATETIME(3) DEFAULT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_delivery_job_order (order_id),
      KEY idx_delivery_job_rider (rider_id, status, updated_at),
      KEY idx_delivery_job_store (merchant_id, store_id, status, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await runAsync(`
    CREATE TABLE IF NOT EXISTS delivery_order_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      store_id INT NOT NULL,
      idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      customer_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      order_id INT DEFAULT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_delivery_order_request (store_id, idempotency_key_hash),
      UNIQUE KEY uq_delivery_order_request_order (order_id),
      KEY idx_delivery_order_request_customer (store_id, customer_token_hash, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const statusColumn = await allAsync(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    ['delivery_jobs', 'status']
  );
  if (!Array.isArray(statusColumn) || statusColumn.length === 0) {
    throw new Error('delivery_jobs.status column is missing');
  }
  if (!String(statusColumn[0].COLUMN_TYPE || '').includes("'pending_assignment'")) {
    await runAsync("ALTER TABLE delivery_jobs MODIFY COLUMN status ENUM('pending_assignment','assigned','accepted','picked_up','delivering','delivered','cancelled') NOT NULL DEFAULT 'pending_assignment'");
  }
  await runAsync(`
    CREATE TABLE IF NOT EXISTS delivery_rider_locations (
      rider_id BIGINT UNSIGNED NOT NULL,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      accuracy_m DECIMAL(8,2) DEFAULT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (rider_id),
      KEY idx_delivery_location_store (merchant_id, store_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  return { changed: true };
}

module.exports = { ensureDeliverySchema };
