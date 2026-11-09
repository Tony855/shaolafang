'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePositiveRouteId } = require('../server/services/route-id');

test('shared route ID parser accepts only canonical positive safe integers', () => {
  for (const value of ['1', '42', 42]) assert.equal(parsePositiveRouteId(value), Number(value));
  for (const value of ['', '0', '-1', ' 42 ', '42 ', '42abc', '4.2', '4e1', '01', '9007199254740992', true, false, [], {}, null, undefined]) {
    assert.equal(parsePositiveRouteId(value), null, String(value));
  }
});
