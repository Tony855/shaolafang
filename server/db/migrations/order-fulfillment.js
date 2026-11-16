'use strict';

async function ensureOrderFulfillmentSchema({ allAsync, runAsync }) {
  if (typeof allAsync !== 'function' || typeof runAsync !== 'function') {
    throw new TypeError('allAsync and runAsync are required');
  }
  const columns = await allAsync(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    ['orders', 'fulfillment_type']
  );
  if (!Array.isArray(columns) || columns.length === 0) {
    // Existing orders default to dine_in; never infer delivery from legacy table/notes.
    await runAsync("ALTER TABLE orders ADD COLUMN fulfillment_type VARCHAR(20) NOT NULL DEFAULT 'dine_in'");
  }
  // Allow admin-created takeaway/delivery orders to have no dining table.
  // Inspect metadata first so normal restarts do not repeatedly execute table DDL.
  const tableNameColumn = await allAsync(
    'SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    ['orders', 'table_name']
  );
  if (!Array.isArray(tableNameColumn) || tableNameColumn.length === 0) {
    throw new Error('orders.table_name column is missing');
  }
  if (String(tableNameColumn[0].IS_NULLABLE || '').toUpperCase() !== 'YES') {
    // The existing schema defines this as VARCHAR(50); preserve legacy values.
    await runAsync('ALTER TABLE orders MODIFY COLUMN table_name VARCHAR(50) NULL');
  }
  // Preserve pre-migration delivery jobs: their linked orders are known delivery orders.
  await runAsync("UPDATE orders o INNER JOIN delivery_jobs j ON j.order_id=o.id AND j.store_id=o.store_id AND j.merchant_id=o.merchant_id SET o.fulfillment_type='delivery' WHERE o.fulfillment_type='dine_in'");
  return { changed: true };
}

module.exports = { ensureOrderFulfillmentSchema };
