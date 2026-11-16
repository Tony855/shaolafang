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
  return { changed: true };
}

module.exports = { ensureOrderFulfillmentSchema };
