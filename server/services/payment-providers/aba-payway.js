'use strict';

const crypto = require('crypto');

function rawBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  throw new TypeError('rawBody must be a Buffer or string');
}

function parseCallbackBody(rawBody) {
  const bytes = rawBodyBuffer(rawBody);
  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    const error = new TypeError('PayWay callback body must be valid JSON');
    error.code = 'PAYWAY_CALLBACK_JSON_INVALID';
    throw error;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new TypeError('PayWay callback body must be a JSON object');
    error.code = 'PAYWAY_CALLBACK_BODY_INVALID';
    throw error;
  }
  return { bytes, payload };
}

// ABA PayWay's published callback example sorts top-level keys and concatenates
// their values before computing a base64 HMAC-SHA512 signature. Current payment
// callback fields are scalar strings/numbers; reject nested values rather than
// guessing provider-specific JSON serialization rules.
function canonicalizePayWayCallback(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('PayWay callback payload must be an object');
  }
  return Object.keys(payload).sort().map(key => {
    const value = payload[key];
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? '1' : '';
    const error = new TypeError('PayWay callback contains an unsupported nested value');
    error.code = 'PAYWAY_CALLBACK_VALUE_UNSUPPORTED';
    throw error;
  }).join('');
}

function buildPayWayCallbackSignature(payload, secretKey) {
  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    throw new TypeError('PayWay callback secret is required');
  }
  const canonical = canonicalizePayWayCallback(payload);
  return crypto.createHmac('sha512', secretKey).update(canonical, 'utf8').digest('base64');
}

function getPayWaySignature(headers) {
  if (!headers || typeof headers !== 'object') return '';
  const key = Object.keys(headers).find(name => name.toLowerCase() === 'x-payway-hmac-sha512');
  const value = key ? headers[key] : '';
  return typeof value === 'string' ? value.trim() : '';
}

function verifyPayWayPaymentCallback(input) {
  if (!input || typeof input !== 'object') throw new TypeError('callback verification input is required');
  const secretKey = input.secretKey;
  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    const error = new TypeError('PayWay callback secret is required');
    error.code = 'PAYWAY_CALLBACK_SECRET_MISSING';
    throw error;
  }
  const parsed = parseCallbackBody(input.rawBody);
  const receivedSignature = typeof input.signature === 'string' ? input.signature.trim() : '';
  const expectedSignature = buildPayWayCallbackSignature(parsed.payload, secretKey);
  const expected = Buffer.from(expectedSignature, 'ascii');
  const received = Buffer.from(receivedSignature, 'ascii');
  const authenticated = received.length === expected.length &&
    crypto.timingSafeEqual(received, expected);
  const transactionId = typeof parsed.payload.tran_id === 'string'
    ? parsed.payload.tran_id.trim() : String(parsed.payload.tran_id || '').trim();
  if (!transactionId || transactionId.length > 20) {
    const error = new TypeError('PayWay callback tran_id is missing or invalid');
    error.code = 'PAYWAY_CALLBACK_TRANSACTION_ID_INVALID';
    throw error;
  }
  return Object.freeze({
    providerCode: 'ABA_PAYWAY',
    authenticated,
    transactionId,
    approvalCode: typeof parsed.payload.apv === 'string' ? parsed.payload.apv : '',
    callbackStatusCode: String(parsed.payload.status === undefined ? '' : parsed.payload.status),
    payloadSha256: crypto.createHash('sha256').update(parsed.bytes).digest('hex')
  });
}

module.exports = {
  buildPayWayCallbackSignature,
  canonicalizePayWayCallback,
  getPayWaySignature,
  verifyPayWayPaymentCallback
};
