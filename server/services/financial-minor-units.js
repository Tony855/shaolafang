'use strict';

function safeMinorUnitTotal(value, field = 'minorUnitTotal', errorCode = 'FINANCE_MINOR_UNIT_PRECISION_UNSAFE') {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    const error = new RangeError(field + ' exceeds JavaScript safe integer precision');
    error.code = errorCode;
    throw error;
  }
  const raw = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^\d+$/.test(raw)) {
    const error = new TypeError(field + ' must be a non-negative integer minor-unit value');
    error.code = errorCode;
    throw error;
  }
  const exact = BigInt(raw);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    const error = new RangeError(field + ' exceeds JavaScript safe integer precision');
    error.code = errorCode;
    throw error;
  }
  return Number(exact);
}

function safeMinorUnitAmount(value, field = 'minorUnitAmount', errorCode = 'FINANCE_MINOR_UNIT_PRECISION_UNSAFE') {
  const amount = safeMinorUnitTotal(value, field, errorCode);
  if (amount <= 0) {
    const error = new TypeError(field + ' must be a positive integer minor-unit amount');
    error.code = 'FINANCE_MINOR_UNIT_AMOUNT_INVALID';
    throw error;
  }
  return amount;
}

module.exports = { safeMinorUnitTotal, safeMinorUnitAmount };
