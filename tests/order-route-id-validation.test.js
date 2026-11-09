'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePositiveOrderRouteId, parseNonNegativeRouteIndex } = require('../routes/orders');

test('order route IDs accept canonical positive safe integers only', () => {
  for (const value of ['1', '42', 42]) assert.equal(parsePositiveOrderRouteId(value), Number(value));
  for (const value of ['', '0', '-1', ' 42 ', '42 ', '42abc', '4.2', '4e1', '9007199254740992', true, false, [], {}, null, undefined]) {
    assert.equal(parsePositiveOrderRouteId(value), null, String(value));
  }
});

test('order item indexes accept canonical non-negative safe integers only', () => {
  for (const value of ['0', '1', '42', 0, 42]) assert.equal(parseNonNegativeRouteIndex(value), Number(value));
  for (const value of ['', '-1', ' 0', '01', '1.0', '1e1', '9007199254740992', true, false, [], {}, null, undefined]) {
    assert.equal(parseNonNegativeRouteIndex(value), null, String(value));
  }
});
