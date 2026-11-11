'use strict';

// Shared financial primitives used by order and cashier workflows.
// Amounts are represented as integer cents at API and persistence boundaries.
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

function hasActiveKhqr(order) {
  if (Number(order?.awaiting_confirm)) return true;
  if (!order?.pay_khqr_ref) return false;
  const expiresAt = Date.parse(order.pay_expires_at || '');
  // Unknown expiry is treated as active: a presented QR must not be orphaned.
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

// Keep the existing single-rounding behavior across all remaining item quantities.
function calculateOrderTotalCents(items) {
  if (!Array.isArray(items) || !items.length) return null;
  let scaledTotal = 0n;
  for (const item of items) {
    const unitPrice = Number(item?.base_price ?? item?.price);
    const quantity = Number(item?.quantity);
    const returnedQty = item?.returnedQty === undefined || item?.returnedQty === null
      ? 0
      : Number(item.returnedQty);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1000000000 ||
        !Number.isSafeInteger(quantity) || quantity <= 0 ||
        !Number.isSafeInteger(returnedQty) || returnedQty < 0 || returnedQty > quantity) {
      return null;
    }
    const remainingQty = quantity - returnedQty;
    if (!remainingQty) continue;
    const [whole, fraction] = unitPrice.toFixed(10).split('.');
    const unitScaled = BigInt(whole) * 10000000000n + BigInt(fraction);
    scaledTotal += unitScaled * BigInt(remainingQty);
  }
  const cents = (scaledTotal + 50000000n) / 100000000n;
  if (cents > 100000000000n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

module.exports = {
  toMoneyCents,
  hasCorruptFinancialAmounts,
  hasActiveKhqr,
  calculateOrderTotalCents
};
