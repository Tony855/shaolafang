/**
 * server/middleware/password.js
 * Password hashing, verification and transparent migration of legacy hashes.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const BCRYPT_ROUNDS = Math.min(14, Math.max(12, Number.parseInt(process.env.BCRYPT_ROUNDS || '12', 10) || 12));

function hashPassword(password) {
  if (typeof password !== 'string' || !password.length) {
    throw new TypeError('Password must be a non-empty string');
  }
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string' || !hash) return false;
  if (hash.startsWith('$2')) {
    try { return bcrypt.compareSync(password, hash); }
    catch (_) { return false; }
  }
  // Legacy SHA-256 hashes are accepted only for migration at successful login.
  if (!/^[a-f0-9]{64}$/i.test(hash)) return false;
  const candidate = crypto.createHash('sha256').update(password).digest();
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(candidate, stored);
}

function isStrongPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];
  return classes.filter(pattern => pattern.test(password)).length >= 3;
}

function needsRehash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('$2')) return true;
  const rounds = Number.parseInt(hash.split('$')[2], 10);
  return !Number.isFinite(rounds) || rounds < BCRYPT_ROUNDS;
}

module.exports = { hashPassword, verifyPassword, needsRehash, isStrongPassword, BCRYPT_ROUNDS };
