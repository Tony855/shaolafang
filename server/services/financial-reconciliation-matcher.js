'use strict';

function positiveSafeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(field + ' must be a positive safe integer');
  }
  return number;
}

function normalizeReference(value) {
  const reference = String(value || '').trim();
  if (reference.length > 191) throw new TypeError('reconciliation reference is too long');
  return reference;
}

function normalizeStatementRow(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('statement row ' + index + ' is invalid');
  }
  const amountMinor = Number(row.amountMinor);
  const currencyCode = String(row.currencyCode || '').trim().toUpperCase();
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError('statement row amountMinor must be a positive safe integer');
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new TypeError('statement row currencyCode must be a three-letter code');
  }
  return Object.freeze({
    rowNo: row.rowNo === undefined ? index + 1 : positiveSafeInteger(row.rowNo, 'rowNo'),
    merchantId: positiveSafeInteger(row.merchantId, 'merchantId'),
    storeId: positiveSafeInteger(row.storeId, 'storeId'),
    externalReference: normalizeReference(row.externalReference),
    transactionReference: normalizeReference(row.transactionReference),
    amountMinor,
    currencyCode
  });
}

function normalizeJournalCandidate(candidate, index) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('journal candidate ' + index + ' is invalid');
  }
  const amountMinor = Number(candidate.amountMinor);
  const currencyCode = String(candidate.currencyCode || '').trim().toUpperCase();
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TypeError('journal candidate amountMinor must be a positive safe integer');
  }
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new TypeError('journal candidate currencyCode must be a three-letter code');
  }
  return Object.freeze({
    journalTransactionId: positiveSafeInteger(candidate.journalTransactionId, 'journalTransactionId'),
    merchantId: positiveSafeInteger(candidate.merchantId, 'merchantId'),
    storeId: positiveSafeInteger(candidate.storeId, 'storeId'),
    sourceId: normalizeReference(candidate.sourceId),
    amountMinor,
    currencyCode
  });
}

// Suggestions are deliberately non-mutating. Exact references, amount, currency,
// and tenant scope are required. Bank debit/credit direction is not interpreted
// because cash-account mappings are provider- and chart-of-accounts-specific.
function suggestReconciliationMatches({ statementRows, journalCandidates }) {
  if (!Array.isArray(statementRows) || statementRows.length > 10000) {
    throw new TypeError('statementRows must be an array of at most 10000 rows');
  }
  if (!Array.isArray(journalCandidates) || journalCandidates.length > 50000) {
    throw new TypeError('journalCandidates must be an array of at most 50000 records');
  }

  const rows = statementRows.map(normalizeStatementRow);
  const candidates = journalCandidates.map(normalizeJournalCandidate);
  return rows.map(row => {
    const references = new Set([row.externalReference, row.transactionReference].filter(Boolean));
    const scoped = candidates.filter(candidate =>
      candidate.merchantId === row.merchantId &&
      candidate.storeId === row.storeId &&
      references.has(candidate.sourceId)
    );
    const byId = new Map(scoped.map(candidate => [candidate.journalTransactionId, candidate]));
    const referenced = [...byId.values()];
    const exact = referenced.filter(candidate =>
      candidate.amountMinor === row.amountMinor &&
      candidate.currencyCode === row.currencyCode
    );

    if (exact.length === 1) {
      return Object.freeze({
        rowNo: row.rowNo,
        status: 'suggested',
        reason: 'exact_reference_amount_currency',
        journalTransactionId: exact[0].journalTransactionId
      });
    }
    if (exact.length > 1) {
      return Object.freeze({
        rowNo: row.rowNo,
        status: 'ambiguous',
        reason: 'multiple_exact_candidates',
        candidateTransactionIds: exact.map(candidate => candidate.journalTransactionId).sort((a, b) => a - b)
      });
    }
    if (referenced.length === 0) {
      return Object.freeze({ rowNo: row.rowNo, status: 'unmatched', reason: 'no_tenant_scoped_reference_match' });
    }
    const sameCurrency = referenced.some(candidate => candidate.currencyCode === row.currencyCode);
    return Object.freeze({
      rowNo: row.rowNo,
      status: 'exception',
      reason: sameCurrency ? 'amount_mismatch' : 'currency_mismatch',
      candidateTransactionIds: referenced.map(candidate => candidate.journalTransactionId).sort((a, b) => a - b)
    });
  });
}

module.exports = { suggestReconciliationMatches };
