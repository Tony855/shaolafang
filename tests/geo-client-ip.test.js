const test = require('node:test');
const assert = require('node:assert/strict');
const { getClientIp } = require('../server/services/geo');

test('getClientIp uses Express-resolved req.ip instead of forwarded headers', () => {
  const req = {
    ip: '198.51.100.24',
    headers: {
      'x-forwarded-for': '203.0.113.99, 198.51.100.24',
      'x-real-ip': '192.0.2.77'
    },
    socket: { remoteAddress: '127.0.0.1' }
  };

  assert.equal(getClientIp(req), '198.51.100.24');
});

test('getClientIp ignores spoofed forwarding headers when Express has no resolved IP', () => {
  const req = {
    headers: {
      'x-forwarded-for': '203.0.113.99',
      'x-real-ip': '192.0.2.77'
    },
    socket: { remoteAddress: '10.0.0.8' },
    connection: { remoteAddress: '10.0.0.9' }
  };

  assert.equal(getClientIp(req), '10.0.0.8');
});

test('getClientIp supports legacy connection fallback and unknown requests', () => {
  assert.equal(getClientIp({ connection: { remoteAddress: '::1' }, headers: {} }), '::1');
  assert.equal(getClientIp({ headers: { 'x-forwarded-for': '203.0.113.99' } }), 'unknown');
});
