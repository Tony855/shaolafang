const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { hashPassword, verifyPassword, needsRehash, BCRYPT_ROUNDS } = require('../server/middleware/password');

test('new password hashes use the configured secure bcrypt work factor', () => {
  const hash = hashPassword('a-long-test-password-2026');
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(Number(hash.split('$')[2]), BCRYPT_ROUNDS);
  assert.ok(BCRYPT_ROUNDS >= 12);
  assert.equal(verifyPassword('a-long-test-password-2026', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
  assert.equal(needsRehash(hash), false);
});

test('legacy SHA-256 password hashes remain verifiable only for transparent migration', () => {
  const password = 'legacy-test-password';
  const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
  assert.equal(verifyPassword(password, legacyHash), true);
  assert.equal(verifyPassword('wrong-password', legacyHash), false);
  assert.equal(needsRehash(legacyHash), true);
});

test('weak bcrypt hashes are flagged for rehash after successful authentication', () => {
  const weakHash = bcrypt.hashSync('old-bcrypt-password', 8);
  assert.equal(verifyPassword('old-bcrypt-password', weakHash), true);
  assert.equal(needsRehash(weakHash), true);
});
