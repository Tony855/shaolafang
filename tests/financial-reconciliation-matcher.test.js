'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestReconciliationMatches } = require('../server/services/financial-reconciliation-matcher');

const row = (overrides = {}) => ({
  rowNo: 7, merchantId: 4, storeId: 9, externalReference: 'bank-ref-7',
  transactionReference: 'order-77', amountMinor: 1250, currencyCode: 'USD',
  ...overrides
});
const candidate = (overrides = {}) => ({
  journalTransactionId: 31, merchantId: 4, storeId: 9, sourceId: 'order-77',
  amountMinor: 1250, currencyCode: 'USD', ...overrides
});

test('suggests one exact reference, tenant, amount and currency match without mutation', () => {
  const inputRow = row();
  const inputCandidate = candidate();
  const result = suggestReconciliationMatches({ statementRows: [inputRow], journalCandidates: [inputCandidate] });
  assert.deepEqual(result, [{
    rowNo: 7, status: 'suggested', reason: 'exact_reference_amount_currency', journalTransactionId: 31
  }]);
  assert.equal(inputRow.amountMinor, 1250);
  assert.equal(inputCandidate.sourceId, 'order-77');
});

test('does not match across merchant or store boundaries', () => {
  const result = suggestReconciliationMatches({
    statementRows: [row()],
    journalCandidates: [candidate({ merchantId: 5 }), candidate({ storeId: 10 })]
  });
  assert.equal(result[0].status, 'unmatched');
  assert.equal(result[0].reason, 'no_tenant_scoped_reference_match');
});

test('reports multiple exact journal candidates as ambiguous', () => {
  const result = suggestReconciliationMatches({
    statementRows: [row()],
    journalCandidates: [candidate({ journalTransactionId: 32 }), candidate({ journalTransactionId: 31 })]
  });
  assert.equal(result[0].status, 'ambiguous');
  assert.deepEqual(result[0].candidateTransactionIds, [31, 32]);
});

test('reports amount mismatch and currency mismatch instead of suggesting a match', () => {
  const amount = suggestReconciliationMatches({
    statementRows: [row()], journalCandidates: [candidate({ amountMinor: 1249 })]
  });
  const currency = suggestReconciliationMatches({
    statementRows: [row()], journalCandidates: [candidate({ currencyCode: 'KHR' })]
  });
  assert.equal(amount[0].status, 'exception');
  assert.equal(amount[0].reason, 'amount_mismatch');
  assert.equal(currency[0].reason, 'currency_mismatch');
});

test('uses exact external reference as an alternate match key', () => {
  const result = suggestReconciliationMatches({
    statementRows: [row()], journalCandidates: [candidate({ sourceId: 'bank-ref-7' })]
  });
  assert.equal(result[0].status, 'suggested');
});

test('does not infer a match from amount and currency without an exact reference', () => {
  const result = suggestReconciliationMatches({
    statementRows: [row()], journalCandidates: [candidate({ sourceId: 'unrelated-order' })]
  });
  assert.equal(result[0].status, 'unmatched');
});

test('rejects unsafe amounts, malformed currencies and unbounded inputs', () => {
  assert.throws(() => suggestReconciliationMatches({
    statementRows: [row({ amountMinor: 1.5 })], journalCandidates: []
  }), /amountMinor/);
  assert.throws(() => suggestReconciliationMatches({
    statementRows: [row({ currencyCode: 'US' })], journalCandidates: []
  }), /currencyCode/);
  assert.throws(() => suggestReconciliationMatches({
    statementRows: [], journalCandidates: new Array(50001).fill(candidate())
  }), /50000/);
});
