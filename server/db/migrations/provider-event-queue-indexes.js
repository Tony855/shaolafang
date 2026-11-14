'use strict';

const INDEXES = Object.freeze([
  {
    name: 'idx_provider_event_claim_received',
    columns: ['auth_status', 'processing_status', 'next_attempt_at', 'received_at', 'id']
  },
  {
    name: 'idx_provider_event_claim_lease',
    columns: ['auth_status', 'processing_status', 'lease_expires_at', 'attempt_count', 'id']
  }
]);

async function ensureProviderEventQueueIndexes({ runAsync, allAsync }) {
  if (typeof runAsync !== 'function' || typeof allAsync !== 'function') {
    throw new TypeError('runAsync and allAsync are required');
  }

  const columns = await allAsync('SHOW COLUMNS FROM provider_webhook_events');
  const available = new Set(columns.map(column => column.Field));
  const requiredColumns = new Set(INDEXES.flatMap(index => index.columns));
  const missing = Array.from(requiredColumns).filter(column => !available.has(column));
  if (missing.length) {
    throw new Error('provider_webhook_events is missing queue index columns: ' + missing.join(', '));
  }

  const indexes = await allAsync('SHOW INDEX FROM provider_webhook_events');
  const results = [];
  for (const definition of INDEXES) {
    const existing = indexes
      .filter(index => index.Key_name === definition.name)
      .sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index));
    if (existing.length) {
      const actual = existing.map(index => index.Column_name);
      if (actual.length !== definition.columns.length ||
          actual.some((column, position) => column !== definition.columns[position])) {
        throw new Error('provider event queue index exists with an unexpected definition: ' + definition.name);
      }
      results.push({ created: false, indexName: definition.name });
      continue;
    }

    await runAsync(
      'CREATE INDEX ' + definition.name +
      ' ON provider_webhook_events (' + definition.columns.join(', ') + ')'
    );
    results.push({ created: true, indexName: definition.name });
  }
  return results;
}

module.exports = { ensureProviderEventQueueIndexes, INDEXES };
