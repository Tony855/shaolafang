'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOrder } = require('../server/services/order');

function row(overrides = {}) {
  return {
    id: 1,
    items: '[]',
    total: '10.00',
    refund_amount: null,
    status: 'done',
    ...overrides
  };
}

test('formatOrder marks valid normal and fully refunded amounts as financially sound', () => {
  assert.equal(formatOrder(row()).financialDataCorrupted, false);
  assert.equal(formatOrder(row({ refund_amount: '10.00', status: 'refunded' })).financialDataCorrupted, false);
  assert.equal(formatOrder(row({ total: '0.00', refund_amount: null })).financialDataCorrupted, false);
});

test('formatOrder marks invalid totals and refund amounts as financially corrupted', () => {
  for (const overrides of [
    { total: null },
    { total: '-1.00' },
    { total: 'not-money' },
    { total: '10.001' },
    { refund_amount: '-0.01' },
    { refund_amount: '10.01' },
    { refund_amount: 'invalid' },
    { refund_amount: '1.001' }
  ]) {
    assert.equal(formatOrder(row(overrides)).financialDataCorrupted, true, JSON.stringify(overrides));
  }
});

test('formatOrder preserves item corruption separately from financial corruption', () => {
  const formatted = formatOrder(row({ items: '{invalid' }));
  assert.equal(formatted.dataCorrupted, true);
  assert.equal(formatted.financialDataCorrupted, false);
});
