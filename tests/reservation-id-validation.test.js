'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePositiveReservationId } = require('../routes/calls');

test('reservation IDs accept only canonical positive safe integers', () => {
  for (const value of ['1', '42', 42]) {
    assert.equal(parsePositiveReservationId(value), Number(value));
  }
  for (const value of ['', '0', '-1', ' 42 ', '42abc', '4.2', '4e1', '9007199254740992', true, false, [], {}, null, undefined]) {
    assert.equal(parsePositiveReservationId(value), null, String(value));
  }
});
