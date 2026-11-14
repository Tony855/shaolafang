'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ensureProviderEventQueueIndexes,
  INDEXES
} = require('../server/db/migrations/provider-event-queue-indexes');

function fakeDatabase({ columns, indexes = [] }) {
  const calls = [];
  const currentIndexes = indexes.map(index => ({ ...index }));
  return {
    calls,
    async allAsync(sql) {
      calls.push({ type: 'all', sql });
      if (sql === 'SHOW COLUMNS FROM provider_webhook_events') {
        return columns.map(Field => ({ Field }));
      }
      if (sql === 'SHOW INDEX FROM provider_webhook_events') return currentIndexes;
      throw new Error('unexpected query: ' + sql);
    },
    async runAsync(sql) {
      calls.push({ type: 'run', sql });
      const match = sql.match(/^CREATE INDEX (\w+) ON provider_webhook_events \(([^)]+)\)$/);
      if (!match) throw new Error('unexpected statement: ' + sql);
      match[2].split(', ').forEach((Column_name, index) => currentIndexes.push({
        Key_name: match[1], Seq_in_index: index + 1, Column_name
      }));
      return { affectedRows: 0 };
    }
  };
}

const requiredColumns = Array.from(new Set(INDEXES.flatMap(index => index.columns)));

test('provider event queue indexes are created with the expected claim paths', async () => {
  const db = fakeDatabase({ columns: requiredColumns });
  const result = await ensureProviderEventQueueIndexes(db);
  assert.deepEqual(result, INDEXES.map(index => ({ created: true, indexName: index.name })));
  assert.equal(db.calls.filter(call => call.type === 'run').length, INDEXES.length);
  for (const index of INDEXES) {
    assert.ok(db.calls.some(call => call.sql.includes(index.name) &&
      call.sql.includes(index.columns.join(', '))));
  }
});

test('provider event queue index migration is idempotent on rerun', async () => {
  const existing = INDEXES.flatMap(index => index.columns.map((Column_name, position) => ({
    Key_name: index.name, Seq_in_index: position + 1, Column_name
  })));
  const db = fakeDatabase({ columns: requiredColumns, indexes: existing });
  const result = await ensureProviderEventQueueIndexes(db);
  assert.deepEqual(result, INDEXES.map(index => ({ created: false, indexName: index.name })));
  assert.equal(db.calls.filter(call => call.type === 'run').length, 0);
});

test('provider event queue index migration fails closed on a mismatched existing index', async () => {
  const db = fakeDatabase({
    columns: requiredColumns,
    indexes: [{ Key_name: INDEXES[0].name, Seq_in_index: 1, Column_name: 'processing_status' }]
  });
  await assert.rejects(
    ensureProviderEventQueueIndexes(db),
    /unexpected definition: idx_provider_event_claim_received/
  );
  assert.equal(db.calls.filter(call => call.type === 'run').length, 0);
});

test('provider event queue index migration reports missing schema columns', async () => {
  const db = fakeDatabase({ columns: ['id', 'processing_status'] });
  await assert.rejects(
    ensureProviderEventQueueIndexes(db),
    /missing queue index columns/
  );
  assert.equal(db.calls.filter(call => call.type === 'run').length, 0);
});
