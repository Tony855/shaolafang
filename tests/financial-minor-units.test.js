'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeMinorUnitTotal, safeMinorUnitAmount } = require('../server/services/financial-minor-units');

test('minor-unit totals preserve exact integer boundaries and allow empty totals', () => {
  assert.equal(safeMinorUnitTotal(null), 0);
  assert.equal(safeMinorUnitTotal(undefined), 0);
  assert.equal(safeMinorUnitTotal(''), 0);
  assert.equal(safeMinorUnitTotal('0'), 0);
  assert.equal(safeMinorUnitTotal(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(safeMinorUnitTotal(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('minor-unit totals reject unsafe, fractional, negative, and malformed persisted values', () => {
  for (const value of ['9007199254740992', 9007199254740992, '1.25', '-1', '1e3', 'not-a-number']) {
    assert.throws(
      () => safeMinorUnitTotal(value, 'totalDebitMinor'),
      error => error.code === 'FINANCE_MINOR_UNIT_PRECISION_UNSAFE'
    );
  }
});

test('individual minor-unit amounts must be positive and exactly representable', () => {
  assert.equal(safeMinorUnitAmount('1250'), 1250);
  assert.equal(safeMinorUnitAmount(1250), 1250);
  assert.throws(() => safeMinorUnitAmount(0), error => error.code === 'FINANCE_MINOR_UNIT_AMOUNT_INVALID');
  assert.throws(() => safeMinorUnitAmount(null), error => error.code === 'FINANCE_MINOR_UNIT_AMOUNT_INVALID');
  assert.throws(
    () => safeMinorUnitAmount('9007199254740992'),
    error => error.code === 'FINANCE_MINOR_UNIT_PRECISION_UNSAFE'
  );
});
