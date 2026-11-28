'use strict';

const crypto = require('node:crypto');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function loadKey(value = process.env.TELEGRAM_BOT_ENCRYPTION_KEY) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('TELEGRAM_BOT_ENCRYPTION_KEY is required');
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); } catch (_) { key = null; }
  }
  if (!key || key.length !== 32) {
    throw new Error('TELEGRAM_BOT_ENCRYPTION_KEY must encode exactly 32 bytes (64 hex characters or base64)');
  }
  return key;
}

function encryptBotToken(token, options = {}) {
  const plaintext = String(token || '');
  if (!plaintext) throw new TypeError('Bot token is required');
  const key = loadKey(options.key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptBotToken(payload, options = {}) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported encrypted Bot token format');
  const key = loadKey(options.key);
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Invalid encrypted Bot token payload');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function fingerprintBotToken(token) {
  const value = String(token || '');
  if (!value) throw new TypeError('Bot token is required');
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

module.exports = { encryptBotToken, decryptBotToken, fingerprintBotToken, loadKey };
