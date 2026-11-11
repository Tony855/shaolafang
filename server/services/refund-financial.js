'use strict';

const crypto = require('crypto');

// Idempotency keys are scoped by store in the database unique constraint.
function isValidRefundIdempotencyKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{16,128}$/.test(value);
}

// Preserve the existing request-hash payload and property order for compatibility.
function createRefundRequestHash({ orderId, amountCents, reason, note, cashier }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    orderId,
    amountCents,
    reason,
    note,
    cashier: String(cashier || '')
  })).digest('hex');
}

// All calculations use integer cents. A reason code lets the route preserve
// its existing HTTP status and localized error response.
function calculateRefundAllocation({ orderTotalCents, alreadyRefundedCents, requestedRefundCents }) {
  if (!Number.isSafeInteger(orderTotalCents) || orderTotalCents <= 0 ||
      !Number.isSafeInteger(alreadyRefundedCents) || alreadyRefundedCents < 0 ||
      alreadyRefundedCents > orderTotalCents ||
      (requestedRefundCents !== null && requestedRefundCents !== undefined &&
        (!Number.isSafeInteger(requestedRefundCents) || requestedRefundCents <= 0))) {
    return null;
  }

  const availableCents = orderTotalCents - alreadyRefundedCents;
  if (availableCents <= 0) {
    return { reason: 'no-balance', availableCents, refundAmountCents: 0,
      totalRefundedCents: alreadyRefundedCents, remainingCents: 0 };
  }

  const refundAmountCents = requestedRefundCents === null || requestedRefundCents === undefined
    ? availableCents
    : requestedRefundCents;
  if (refundAmountCents > availableCents) {
    return { reason: 'exceeds-balance', availableCents, refundAmountCents,
      totalRefundedCents: alreadyRefundedCents, remainingCents: availableCents };
  }

  const totalRefundedCents = alreadyRefundedCents + refundAmountCents;
  const remainingCents = orderTotalCents - totalRefundedCents;
  if (!Number.isSafeInteger(totalRefundedCents) || !Number.isSafeInteger(remainingCents)) return null;

  return {
    reason: null,
    availableCents,
    refundAmountCents,
    totalRefundedCents,
    remainingCents
  };
}

module.exports = {
  isValidRefundIdempotencyKey,
  createRefundRequestHash,
  calculateRefundAllocation
};
