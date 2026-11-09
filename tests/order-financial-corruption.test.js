'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasCorruptFinancialAmounts } = require('../server/services/order-financial');

test('financial validation accepts valid totals and full refunds', () => {
  assert.equal(hasCorruptFinancialAmounts('10.00', null), false);
  assert.equal(hasCorruptFinancialAmounts('10.00', '0.00'), false);
  assert.equal(hasCorruptFinancialAmounts('10.00', '10.00'), false);
  assert.equal(hasCorruptFinancialAmounts('0.00', null), false);
});

test('financial validation rejects malformed, negative, and sub-cent totals', () => {
  for (const total of [null, undefined, '', '-1.00', 'not-money', '10.001', '1e3']) {
    assert.equal(hasCorruptFinancialAmounts(total, null), true, String(total));
  }
});

test('financial validation rejects malformed, negative, sub-cent, and excessive refunds', () => {
  for (const refund of ['-0.01', '10.01', 'invalid', '1.001', '1e2']) {
    assert.equal(hasCorruptFinancialAmounts('10.00', refund), true, refund);
  }
});
