'use strict';

const crypto = require('crypto');

const SHA256_RE = /^[a-f0-9]{64}$/i;
const CODE_RE = /^[A-Z0-9_-]{2,40}$/;

function positiveId(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(field + ' must be a positive safe integer');
  return number;
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('occurredAt must be a valid date');
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function normalizeStatementRow(row, currencyCode, rowNo) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('statement row must be an object');
  const allowed = new Set(['externalReference', 'transactionReference', 'direction', 'amountMinor', 'currencyCode', 'occurredAt', 'description']);
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) throw new TypeError('statement row contains unsupported field: ' + key);
  }
  const externalReference = String(row.externalReference || '').trim();
  const transactionReference = String(row.transactionReference || '').trim();
  const direction = String(row.direction || '').toLowerCase();
  const amountMinor = Number(row.amountMinor);
  const currency = String(row.currencyCode || currencyCode).trim().toUpperCase();
  const description = String(row.description || '').trim();
  if (!externalReference || externalReference.length > 191) throw new TypeError('externalReference is invalid');
  if (transactionReference.length > 191) throw new TypeError('transactionReference is invalid');
  if (!['debit', 'credit'].includes(direction)) throw new TypeError('direction must be debit or credit');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new TypeError('amountMinor must be a positive safe integer');
  if (currency !== currencyCode) throw new TypeError('all statement rows must use the batch currency');
  if (description.length > 255) throw new TypeError('description must be at most 255 characters');
  const occurredAt = normalizeDate(row.occurredAt);
  const canonical = { rowNo, externalReference, transactionReference, direction, amountMinor, currencyCode: currency, occurredAt, description };
  const rowSha256 = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return Object.freeze({ ...canonical, rowSha256 });
}

function normalizeBatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('batch input is required');
  const merchantId = positiveId(input.merchantId, 'merchantId');
  const storeId = positiveId(input.storeId, 'storeId');
  const providerCode = String(input.providerCode || '').trim().toUpperCase();
  const externalBatchId = String(input.externalBatchId || '').trim();
  const statementSha256 = String(input.statementSha256 || '').toLowerCase();
  const currencyCode = String(input.currencyCode || '').trim().toUpperCase();
  if (!CODE_RE.test(providerCode)) throw new TypeError('providerCode is invalid');
  if (!externalBatchId || externalBatchId.length > 191) throw new TypeError('externalBatchId is invalid');
  if (!SHA256_RE.test(statementSha256)) throw new TypeError('statementSha256 must be a SHA-256 digest');
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError('currencyCode must be a three-letter code');
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 10000) {
    throw new TypeError('rows must contain between 1 and 10000 statement records');
  }
  const rows = input.rows.map((row, index) => normalizeStatementRow(row, currencyCode, index + 1));
  const externalRefs = new Set();
  let totalDebitMinor = 0;
  let totalCreditMinor = 0;
  for (const row of rows) {
    // A provider may legitimately repeat a reference on different statement lines.
    if (row.direction === 'debit') totalDebitMinor += row.amountMinor;
    else totalCreditMinor += row.amountMinor;
    if (!Number.isSafeInteger(totalDebitMinor) || !Number.isSafeInteger(totalCreditMinor)) {
      throw new TypeError('statement totals exceed safe integer precision');
    }
    externalRefs.add(row.externalReference);
  }
  return Object.freeze({
    merchantId, storeId, providerCode, externalBatchId, statementSha256,
    currencyCode, rows, rowCount: rows.length, totalDebitMinor, totalCreditMinor
  });
}

function createFinancialReconciliationService({ runAsync, getAsync, withTransaction, lockFinancialMonthPeriod }) {
  for (const [name, fn] of Object.entries({ runAsync, getAsync, withTransaction })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' dependency is required');
  }

  async function importStatementBatch(input) {
    const batch = normalizeBatch(input);
    return withTransaction(async () => {
      if (typeof lockFinancialMonthPeriod === 'function') {
        await lockFinancialMonthPeriod({
          merchantId: batch.merchantId, storeId: batch.storeId, currencyCode: batch.currencyCode,
          providerCode: batch.providerCode, externalBatchId: batch.externalBatchId
        });
      }
      await runAsync(
        `INSERT INTO financial_reconciliation_batches
          (merchant_id, store_id, provider_code, external_batch_id, statement_sha256,
           currency_code, row_count, total_debit_minor, total_credit_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
        [batch.merchantId, batch.storeId, batch.providerCode, batch.externalBatchId,
          batch.statementSha256, batch.currencyCode, batch.rowCount,
          batch.totalDebitMinor, batch.totalCreditMinor]
      );
      const existing = await getAsync(
        `SELECT id, merchant_id, store_id, provider_code, external_batch_id,
                statement_sha256, currency_code, row_count, total_debit_minor,
                total_credit_minor, status
         FROM financial_reconciliation_batches
         WHERE merchant_id=? AND store_id=? AND provider_code=? AND external_batch_id=?
         FOR UPDATE`,
        [batch.merchantId, batch.storeId, batch.providerCode, batch.externalBatchId]
      );
      if (!existing) throw new Error('reconciliation batch could not be read after insert');
      const headerMatches =
        Number(existing.merchant_id) === batch.merchantId &&
        Number(existing.store_id) === batch.storeId &&
        existing.provider_code === batch.providerCode &&
        existing.external_batch_id === batch.externalBatchId &&
        String(existing.statement_sha256).toLowerCase() === batch.statementSha256 &&
        existing.currency_code === batch.currencyCode &&
        Number(existing.row_count) === batch.rowCount &&
        Number(existing.total_debit_minor) === batch.totalDebitMinor &&
        Number(existing.total_credit_minor) === batch.totalCreditMinor;
      if (!headerMatches) {
        const error = new Error('reconciliation batch identity was reused with different statement content');
        error.code = 'RECONCILIATION_BATCH_CONFLICT';
        throw error;
      }
      const storedRows = await getAsync(
        `SELECT COUNT(*) AS row_count FROM financial_reconciliation_items WHERE batch_id=?`,
        [existing.id]
      );
      const alreadyImported = Number(storedRows?.row_count || 0) > 0;
      for (const row of batch.rows) {
        await runAsync(
          `INSERT INTO financial_reconciliation_items
            (batch_id, merchant_id, store_id, row_no, external_reference,
             transaction_reference, direction, amount_minor, currency_code,
             occurred_at, description, row_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
          [existing.id, batch.merchantId, batch.storeId, row.rowNo,
            row.externalReference, row.transactionReference, row.direction,
            row.amountMinor, row.currencyCode, row.occurredAt, row.description, row.rowSha256]
        );
        const stored = await getAsync(
          `SELECT row_sha256 FROM financial_reconciliation_items WHERE batch_id=? AND row_no=? FOR UPDATE`,
          [existing.id, row.rowNo]
        );
        if (!stored || String(stored.row_sha256).toLowerCase() !== row.rowSha256) {
          const error = new Error('reconciliation row number was reused with different normalized content');
          error.code = 'RECONCILIATION_ROW_CONFLICT';
          throw error;
        }
      }
      const finalCount = await getAsync(
        `SELECT COUNT(*) AS row_count FROM financial_reconciliation_items WHERE batch_id=?`,
        [existing.id]
      );
      if (Number(finalCount?.row_count || 0) !== batch.rowCount) {
        const error = new Error('reconciliation batch row count does not match imported records');
        error.code = 'RECONCILIATION_ROW_COUNT_MISMATCH';
        throw error;
      }
      return {
        batchId: Number(existing.id),
        importedRows: batch.rowCount,
        replayed: alreadyImported,
        status: existing.status,
        totals: { debitMinor: batch.totalDebitMinor, creditMinor: batch.totalCreditMinor, currencyCode: batch.currencyCode }
      };
    });
  }

  async function getBatchSummary({ merchantId, storeId, batchId }) {
    const owner = [positiveId(merchantId, 'merchantId'), positiveId(storeId, 'storeId'), positiveId(batchId, 'batchId')];
    const batch = await getAsync(
      `SELECT id, provider_code, external_batch_id, currency_code, row_count,
              total_debit_minor, total_credit_minor, status, imported_at, validated_at, closed_at
       FROM financial_reconciliation_batches
       WHERE merchant_id=? AND store_id=? AND id=?`,
      owner
    );
    if (!batch) return null;
    const counts = await getAsync(
      `SELECT
         SUM(match_status='pending') AS pending_count,
         SUM(match_status='matched') AS matched_count,
         SUM(match_status='unmatched') AS unmatched_count,
         SUM(match_status='ambiguous') AS ambiguous_count,
         SUM(match_status='exception') AS exception_count
       FROM financial_reconciliation_items WHERE batch_id=? AND merchant_id=? AND store_id=?`,
      [owner[2], owner[0], owner[1]]
    );
    return {
      batchId: Number(batch.id), providerCode: batch.provider_code,
      externalBatchId: batch.external_batch_id, currencyCode: batch.currency_code,
      rowCount: Number(batch.row_count), totalDebitMinor: Number(batch.total_debit_minor),
      totalCreditMinor: Number(batch.total_credit_minor), status: batch.status,
      matchCounts: Object.fromEntries(['pending', 'matched', 'unmatched', 'ambiguous', 'exception']
        .map(key => [key, Number(counts?.[key + '_count'] || 0)]))
    };
  }

  return Object.freeze({ importStatementBatch, getBatchSummary });
}

module.exports = { createFinancialReconciliationService, normalizeStatementRow, normalizeBatch };
