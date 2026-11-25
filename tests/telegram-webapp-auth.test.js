'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyTelegramWebAppInitData } = require('../server/services/telegram-webapp-auth');

const token = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
const now = 1_800_000_000;

function signedInitData(overrides = {}) {
  const values = new Map([
    ['auth_date', String(now)],
    ['query_id', 'AAE-test-query'],
    ['user', JSON.stringify({ id: 987654321, first_name: 'Test' })],
    ...Object.entries(overrides)
  ]);
  const data = Array.from(values.entries()).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  values.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return new URLSearchParams(Array.from(values.entries()).sort(([a], [b]) => a.localeCompare(b))).toString();
}

test('valid Telegram WebApp initData verifies with the tenant bot token', () => {
  const result = verifyTelegramWebAppInitData(signedInitData(), token, { nowSeconds: now });
  assert.equal(result.user.id, 987654321);
  assert.equal(result.authDate, now);
});

test('initData signed by a different tenant bot token is rejected', () => {
  assert.equal(verifyTelegramWebAppInitData(signedInitData(), '654321:zyxwvutsrqponmlkjihgfedcbaABCDE', { nowSeconds: now }), null);
});

test('initData rejects tampering, duplicate security fields, and malformed users', () => {
  const valid = signedInitData();
  assert.equal(verifyTelegramWebAppInitData(valid.replace('first_name%22%3A%22Test', 'first_name%22%3A%22Evil'), token, { nowSeconds: now }), null);
  assert.equal(verifyTelegramWebAppInitData(valid + '&hash=' + '0'.repeat(64), token, { nowSeconds: now }), null);
  assert.equal(verifyTelegramWebAppInitData(signedInitData({ user: JSON.stringify({ id: 0 }) }), token, { nowSeconds: now }), null);
});

test('initData enforces auth_date age and future clock skew', () => {
  assert.equal(verifyTelegramWebAppInitData(signedInitData({ auth_date: String(now - 601) }), token, { nowSeconds: now }), null);
  assert.equal(verifyTelegramWebAppInitData(signedInitData({ auth_date: String(now + 31) }), token, { nowSeconds: now }), null);
  assert.ok(verifyTelegramWebAppInitData(signedInitData({ auth_date: String(now - 600) }), token, { nowSeconds: now }));
});

test('initData rejects invalid token, oversized payload, and missing required fields', () => {
  assert.equal(verifyTelegramWebAppInitData(signedInitData(), 'not-a-token', { nowSeconds: now }), null);
  assert.equal(verifyTelegramWebAppInitData('x'.repeat(16385), token, { nowSeconds: now }), null);
  assert.equal(verifyTelegramWebAppInitData('query_id=x&hash=' + '0'.repeat(64), token, { nowSeconds: now }), null);
});
