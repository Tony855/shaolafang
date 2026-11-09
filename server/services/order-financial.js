'use strict';

function toMoneyCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function hasCorruptFinancialAmounts(total, refundAmount) {
  const totalCents = toMoneyCents(total);
  const refundedCents = refundAmount === null || refundAmount === undefined || refundAmount === ''
    ? 0
    : toMoneyCents(refundAmount);
  return totalCents === null || totalCents < 0 ||
    refundedCents === null || refundedCents < 0 || refundedCents > totalCents;
}

module.exports = { hasCorruptFinancialAmounts };
