'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'pages', 'cashier.js'), 'utf8');

test('cashier hides settlement and refund actions for financially corrupted orders', () => {
  assert.match(source, /const canSettle = !financialDataCorrupted && allowSettle/);
  assert.match(source, /const canRefund = !financialDataCorrupted && allowRefund/);
  assert.match(source, /订单金额或退款记录异常，已禁用收款和退款/);
});

test('cashier refund entry points recheck financial integrity before opening or submitting', () => {
  assert.ok((source.match(/order\.financialDataCorrupted === true/g) || []).length >= 3);
});
