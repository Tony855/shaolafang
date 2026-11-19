'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRouteError } = require('../server/utils/http-error');

test('preserves explicit client error messages for 4xx responses', () => {
  assert.deepEqual(
    normalizeRouteError(Object.assign(new Error('Conflict'), { status: 409 }), 'Fallback'),
    { status: 409, message: 'Conflict', isClientError: true }
  );
  assert.deepEqual(
    normalizeRouteError(Object.assign(new Error('Invalid input'), { statusCode: 400 }), 'Fallback'),
    { status: 400, message: 'Invalid input', isClientError: true }
  );
});

test('masks internal messages for 5xx errors even when status is explicitly set', () => {
  const databaseError = Object.assign(new Error('SQL password=secret; host=db.internal'), { status: 500 });
  assert.deepEqual(
    normalizeRouteError(databaseError, 'Operation failed safely'),
    { status: 500, message: 'Operation failed safely', isClientError: false }
  );
  const serviceError = Object.assign(new Error('provider token leaked'), { statusCode: 503 });
  assert.deepEqual(
    normalizeRouteError(serviceError, 'Service unavailable'),
    { status: 500, message: 'Service unavailable', isClientError: false }
  );
});

test('normalizes missing, malformed and non-error status codes to a masked 500', () => {
  for (const error of [
    new Error('raw internal detail'),
    Object.assign(new Error('raw detail'), { status: 302 }),
    Object.assign(new Error('raw detail'), { status: 'not-a-status' }),
    Object.assign(new Error('raw detail'), { status: 400.5 })
  ]) {
    const result = normalizeRouteError(error, 'Safe fallback');
    assert.equal(result.status, 500);
    assert.equal(result.message, 'Safe fallback');
    assert.equal(result.isClientError, false);
  }
});
