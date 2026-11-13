'use strict';

const INDEX_NAME = 'idx_finance_exception_queue_cursor';
const INDEX_COLUMNS = ['merchant_id', 'store_id', 'match_status', 'id'];

async function ensureFinancialReconciliationQueueIndex({ runAsync, allAsync }) {
  if (typeof runAsync !== 'function' || typeof allAsync !== 'function') {
    throw new TypeError('runAsync and allAsync are required');
  }

  const columns = await allAsync('SHOW COLUMNS FROM financial_reconciliation_items');
  const available = new Set(columns.map(column => column.Field));
  const missing = INDEX_COLUMNS.filter(column => !available.has(column));
  if (missing.length) {
    throw new Error('financial_reconciliation_items is missing queue index columns: ' + missing.join(', '));
  }

  const indexes = await allAsync('SHOW INDEX FROM financial_reconciliation_items');
  const existing = indexes
    .filter(index => index.Key_name === INDEX_NAME)
    .sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index));

  if (existing.length) {
    const actual = existing.map(index => index.Column_name);
    if (actual.length !== INDEX_COLUMNS.length ||
        actual.some((column, position) => column !== INDEX_COLUMNS[position])) {
      throw new Error('financial reconciliation queue index exists with an unexpected definition');
    }
    return { created: false, indexName: INDEX_NAME };
  }

  await runAsync(
    'CREATE INDEX ' + INDEX_NAME +
    ' ON financial_reconciliation_items (merchant_id, store_id, match_status, id)'
  );
  return { created: true, indexName: INDEX_NAME };
}

module.exports = { ensureFinancialReconciliationQueueIndex, INDEX_NAME, INDEX_COLUMNS };
