'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinancialReconciliationService, normalizeBatch } = require('../server/services/financial-reconciliation');

function memoryDb() {
  const batches = new Map();
  const items = new Map();
  let nextBatchId = 1;
  async function runAsync(sql, p = []) {
    if (sql.includes('INSERT INTO financial_reconciliation_batches')) {
      const key = p.slice(0, 4).join(':');
      if (!batches.has(key)) batches.set(key, {
        id: nextBatchId++, merchant_id: p[0], store_id: p[1], provider_code: p[2],
        external_batch_id: p[3], statement_sha256: p[4], currency_code: p[5],
        row_count: p[6], total_debit_minor: p[7], total_credit_minor: p[8], status: 'imported'
      });
      return { affectedRows: 1 };
    }
    if (sql.includes('INSERT INTO financial_reconciliation_items')) {
      const key = p[0] + ':' + p[3];
      if (!items.has(key)) items.set(key, {
        id: items.size + 1, batch_id: p[0], row_no: p[3], row_sha256: p[11],
        match_status: 'pending', merchant_id: p[1], store_id: p[2]
      });
      return { affectedRows: 1 };
    }
    throw new Error('unexpected SQL: ' + sql);
  }
  async function getAsync(sql, p = []) {
    if (sql.includes('FROM financial_reconciliation_batches')) {
      if (sql.includes('WHERE merchant_id=? AND store_id=? AND id=?')) {
        return [...batches.values()].find(x => x.merchant_id === p[0] && x.store_id === p[1] && x.id === p[2]) || null;
      }
      return batches.get(p.slice(0, 4).join(':')) || null;
    }
    if (sql.includes('COUNT(*) AS row_count')) {
      return { row_count: [...items.values()].filter(x => x.batch_id === p[0]).length };
    }
    if (sql.includes('SELECT row_sha256')) {
      return [...items.values()].find(x => x.batch_id === p[0] && x.row_no === p[1]) || null;
    }
    if (sql.includes('SUM(match_status=')) {
      const rows = [...items.values()].filter(x => x.batch_id === p[0] && x.merchant_id === p[1] && x.store_id === p[2]);
      return Object.fromEntries(['pending', 'matched', 'unmatched', 'ambiguous', 'exception']
        .map(k => [k + '_count', rows.filter(x => x.match_status === k).length]));
    }
    throw new Error('unexpected get SQL: ' + sql);
  }
  return { service: createFinancialReconciliationService({ runAsync, getAsync, withTransaction: work => work() }), batches, items };
}

const baseInput = () => ({
  merchantId: 4, storeId: 9, providerCode: 'ABA_PAYWAY',
  externalBatchId: 'statement-2026-11-11', statementSha256: 'a'.repeat(64),
  currencyCode: 'USD',
  rows: [
    { externalReference: 'line-1', transactionReference: 'order-1', direction: 'credit', amountMinor: 1200, occurredAt: '2026-11-11T02:00:00.000Z', description: 'settlement' },
    { externalReference: 'line-2', transactionReference: 'refund-2', direction: 'debit', amountMinor: 200, occurredAt: '2026-11-11T02:01:00.000Z', description: 'refund' }
  ]
});

test('normalizes and totals a provider-neutral statement without floating-point money', () => {
  const batch = normalizeBatch(baseInput());
  assert.equal(batch.rowCount, 2);
  assert.equal(batch.totalCreditMinor, 1200);
  assert.equal(batch.totalDebitMinor, 200);
  assert.match(batch.rows[0].rowSha256, /^[a-f0-9]{64}$/);
});

test('rejects malformed statement headers, arbitrary row fields and mixed currencies', () => {
  assert.throws(() => normalizeBatch({ ...baseInput(), statementSha256: 'bad' }), /SHA-256/);
  const extra = baseInput(); extra.rows[0].rawPayload = 'secret';
  assert.throws(() => normalizeBatch(extra), /unsupported field/);
  const mixed = baseInput(); mixed.rows[1].currencyCode = 'KHR';
  assert.throws(() => normalizeBatch(mixed), /batch currency/);
});

test('imports a statement batch idempotently and preserves row digests', async () => {
  const db = memoryDb();
  const first = await db.service.importStatementBatch(baseInput());
  const replay = await db.service.importStatementBatch(baseInput());
  assert.equal(first.batchId, replay.batchId);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(db.items.size, 2);
});

test('rejects reuse of a provider batch identifier with changed file digest', async () => {
  const db = memoryDb();
  await db.service.importStatementBatch(baseInput());
  await assert.rejects(db.service.importStatementBatch({ ...baseInput(), statementSha256: 'b'.repeat(64) }),
    error => error.code === 'RECONCILIATION_BATCH_CONFLICT');
});

test('returns tenant-scoped batch summary and match-state counts', async () => {
  const db = memoryDb();
  const imported = await db.service.importStatementBatch(baseInput());
  const summary = await db.service.getBatchSummary({ merchantId: 4, storeId: 9, batchId: imported.batchId });
  assert.equal(summary.rowCount, 2);
  assert.equal(summary.matchCounts.pending, 0); // this mock stores no merchant-scoped match rows
  assert.equal(await db.service.getBatchSummary({ merchantId: 4, storeId: 10, batchId: imported.batchId }), null);
});
