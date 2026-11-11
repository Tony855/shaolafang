'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  isValidRefundIdempotencyKey,
  createRefundRequestHash,
  calculateRefundAllocation
} = require('../server/services/refund-financial');

test('refund idempotency keys accept only bounded ASCII-safe values', () => {
  for (const key of ['refund-request-0001', 'a'.repeat(16), 'A._:-0123456789']) {
    assert.equal(isValidRefundIdempotencyKey(key), true);
  }
  for (const key of ['', 'short', 'a'.repeat(129), 'contains space 123', '非ASCII退款标识123', null, undefined, 123]) {
    assert.equal(isValidRefundIdempotencyKey(key), false);
  }
});

test('refund request hash remains compatible with the previous route payload', () => {
  const input = {
    orderId: 42,
    amountCents: 1234,
    reason: 'customer request',
    note: 'note',
    cashier: 'qa-cashier'
  };
  const expected = crypto.createHash('sha256').update(JSON.stringify({
    orderId: 42,
    amountCents: 1234,
    reason: 'customer request',
    note: 'note',
    cashier: 'qa-cashier'
  })).digest('hex');
  assert.equal(createRefundRequestHash(input), expected);
  assert.equal(createRefundRequestHash({ ...input, amountCents: 1235 }), 
    createRefundRequestHash({ ...input, amountCents: 1235 }));
  assert.notEqual(createRefundRequestHash(input), createRefundRequestHash({ ...input, orderId: 43 }));
});

test('refund allocation supports full and partial refunds using integer cents', () => {
  assert.deepEqual(calculateRefundAllocation({
    orderTotalCents: 10000,
    alreadyRefundedCents: 0,
    requestedRefundCents: 2500
  }), {
    reason: null,
    availableCents: 10000,
    refundAmountCents: 2500,
    totalRefundedCents: 2500,
    remainingCents: 7500
  });
  assert.deepEqual(calculateRefundAllocation({
    orderTotalCents: 10000,
    alreadyRefundedCents: 2500,
    requestedRefundCents: null
  }), {
    reason: null,
    availableCents: 7500,
    refundAmountCents: 7500,
    totalRefundedCents: 10000,
    remainingCents: 0
  });
});

test('refund allocation identifies exhausted and overdrawn balances', () => {
  assert.equal(calculateRefundAllocation({
    orderTotalCents: 10000,
    alreadyRefundedCents: 10000,
    requestedRefundCents: 100
  }).reason, 'no-balance');
  assert.equal(calculateRefundAllocation({
    orderTotalCents: 10000,
    alreadyRefundedCents: 9000,
    requestedRefundCents: 1001
  }).reason, 'exceeds-balance');
});

test('refund allocation rejects malformed, negative, fractional and unsafe cent values', () => {
  const invalid = [
    { orderTotalCents: 0, alreadyRefundedCents: 0, requestedRefundCents: null },
    { orderTotalCents: 10000, alreadyRefundedCents: -1, requestedRefundCents: null },
    { orderTotalCents: 10000, alreadyRefundedCents: 10001, requestedRefundCents: null },
    { orderTotalCents: 10000, alreadyRefundedCents: 0, requestedRefundCents: 0 },
    { orderTotalCents: 10000, alreadyRefundedCents: 0, requestedRefundCents: 1.5 },
    { orderTotalCents: Number.MAX_SAFE_INTEGER + 1, alreadyRefundedCents: 0, requestedRefundCents: null }
  ];
  for (const args of invalid) assert.equal(calculateRefundAllocation(args), null);
});
