'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encryptBotToken,
  decryptBotToken,
  fingerprintBotToken
} = require('../server/services/telegram-bot-credentials');

const key = '11'.repeat(32);

test('tenant Bot credentials are authenticated-encrypted and decrypt with the same key', () => {
  const token = '123456:telegram-secret-token';
  const encrypted = encryptBotToken(token, { key });
  assert.notEqual(encrypted, token);
  assert.equal(encrypted.split('.').length, 4);
  assert.equal(decryptBotToken(encrypted, { key }), token);
  assert.notEqual(encryptBotToken(token, { key }), encrypted, 'encryption must use a fresh IV');
});

test('tenant Bot credential decryption rejects tampering and wrong keys', () => {
  const encrypted = encryptBotToken('123456:telegram-secret-token', { key });
  const parts = encrypted.split('.');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  assert.throws(() => decryptBotToken(parts.join('.'), { key }));
  assert.throws(() => decryptBotToken(encryptBotToken('token', { key }), { key: '22'.repeat(32) }));
});

test('tenant Bot credential key must be exactly 32 bytes', () => {
  assert.throws(() => encryptBotToken('token', { key: 'too-short' }), /exactly 32 bytes/);
  assert.throws(() => encryptBotToken('token', { key: '' }), /required/);
});

test('Bot token fingerprint is deterministic and does not expose the token', () => {
  const token = '123456:telegram-secret-token';
  const fingerprint = fingerprintBotToken(token);
  assert.equal(fingerprint, fingerprintBotToken(token));
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(fingerprint, token);
});
