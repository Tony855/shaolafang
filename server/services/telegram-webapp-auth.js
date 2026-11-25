'use strict';

const crypto = require('node:crypto');

const DEFAULT_MAX_AGE_SECONDS = 10 * 60;
const DEFAULT_FUTURE_SKEW_SECONDS = 30;

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyTelegramWebAppInitData(initData, botToken, {
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  futureSkewSeconds = DEFAULT_FUTURE_SKEW_SECONDS
} = {}) {
  if (typeof initData !== 'string' || initData.length < 1 || initData.length > 16 * 1024 ||
      typeof botToken !== 'string' || !/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(botToken)) return null;
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 ||
      !Number.isSafeInteger(futureSkewSeconds) || futureSkewSeconds < 0) return null;

  let params;
  try { params = new URLSearchParams(initData); } catch (_) { return null; }
  const entries = Array.from(params.entries());
  if (params.getAll('hash').length !== 1 || params.getAll('auth_date').length !== 1 ||
      params.getAll('user').length !== 1 || entries.length < 3) return null;
  const suppliedHash = params.get('hash');
  const authDateRaw = params.get('auth_date');
  if (!/^\d{1,12}$/.test(authDateRaw || '')) return null;
  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + futureSkewSeconds ||
      nowSeconds - authDate > maxAgeSeconds) return null;

  let user;
  try { user = JSON.parse(params.get('user')); } catch (_) { return null; }
  if (!user || typeof user !== 'object' || Array.isArray(user) ||
      !(typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0) &&
      !(typeof user.id === 'string' && /^[1-9]\d{0,19}$/.test(user.id))) return null;

  const dataCheckString = entries
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeEqualHex(suppliedHash, expectedHash)) return null;

  return { user, authDate, queryId: params.get('query_id') || null };
}

module.exports = { verifyTelegramWebAppInitData, DEFAULT_MAX_AGE_SECONDS, DEFAULT_FUTURE_SKEW_SECONDS };
