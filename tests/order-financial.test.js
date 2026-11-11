'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toMoneyCents,
  hasCorruptFinancialAmounts,
  hasActiveKhqr,
  calculateOrderTotalCents
} = require('../server/services/order-financial');

test('toMoneyCents accepts only non-negative amounts with at most two decimals', () => {
  assert.equal(toMoneyCents('0'), 0);
  assert.equal(toMoneyCents('12'), 1200);
  assert.equal(toMoneyCents('12.3'), 1230);
  assert.equal(toMoneyCents('12.34'), 1234);
  for (const value of ['-1', '1.001', '1e2', 'NaN', 'Infinity', '']) {
    assert.equal(toMoneyCents(value), null, String(value));
  }
  assert.equal(toMoneyCents(Number.MAX_SAFE_INTEGER), null);
});

test('financial corruption guard rejects invalid and over-refunded amounts', () => {
  assert.equal(hasCorruptFinancialAmounts('10.00', '0'), false);
  assert.equal(hasCorruptFinancialAmounts('10.00', '10.00'), false);
  assert.equal(hasCorruptFinancialAmounts('10.00', '10.01'), true);
  assert.equal(hasCorruptFinancialAmounts('10.00', '-0.01'), true);
  assert.equal(hasCorruptFinancialAmounts('10.001', '0'), true);
  assert.equal(hasCorruptFinancialAmounts('10.00', null), false);
});

test('hasActiveKhqr fails closed for pending confirmation and unknown QR expiry', () => {
  assert.equal(hasActiveKhqr({ awaiting_confirm: 1 }), true);
  assert.equal(hasActiveKhqr({ pay_khqr_ref: 'qr-1', pay_expires_at: 'not-a-date' }), true);
  assert.equal(hasActiveKhqr({ pay_khqr_ref: 'qr-1', pay_expires_at: new Date(Date.now() + 60000).toISOString() }), true);
  assert.equal(hasActiveKhqr({ pay_khqr_ref: 'qr-1', pay_expires_at: new Date(Date.now() - 60000).toISOString() }), false);
  assert.equal(hasActiveKhqr({ pay_khqr_ref: '' }), false);
});

test('calculateOrderTotalCents preserves aggregate rounding and returned quantities', () => {
  assert.equal(calculateOrderTotalCents([{ price: 1.005, quantity: 1 }]), 101);
  assert.equal(calculateOrderTotalCents([{ price: 2.50, quantity: 3, returnedQty: 1 }]), 500);
  assert.equal(calculateOrderTotalCents([{ base_price: 1.25, price: 99, quantity: 2 }]), 250);
  assert.equal(calculateOrderTotalCents([{ price: 0.10, quantity: 3 }]), 30);
});

test('calculateOrderTotalCents rejects malformed or unsafe item quantities and prices', () => {
  assert.equal(calculateOrderTotalCents([]), null);
  assert.equal(calculateOrderTotalCents(null), null);
  assert.equal(calculateOrderTotalCents([{ price: -1, quantity: 1 }]), null);
  assert.equal(calculateOrderTotalCents([{ price: 1, quantity: 0 }]), null);
  assert.equal(calculateOrderTotalCents([{ price: 1, quantity: 1.5 }]), null);
  assert.equal(calculateOrderTotalCents([{ price: 1, quantity: 1, returnedQty: 2 }]), null);
  assert.equal(calculateOrderTotalCents([{ price: 'not-money', quantity: 1 }]), null);
});
