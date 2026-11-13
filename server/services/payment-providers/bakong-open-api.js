'use strict';

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Bakong Open API baseUrl is required');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Bakong Open API baseUrl must be a valid URL');
  }
  const localHttp = url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new TypeError('Bakong Open API must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('Bakong Open API baseUrl must contain only an origin');
  }
  return url.origin;
}

function normalizeMd5(value) {
  const md5 = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) {
    throw new TypeError('md5 must be a 32-character hexadecimal KHQR digest');
  }
  return md5;
}

function normalizeTransaction(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Bakong transaction data is invalid');
  }
  const currency = String(data.currency || '').toUpperCase();
  const amount = String(data.amount === undefined || data.amount === null ? '' : data.amount);
  const amountNumber = Number(amount);
  const createdDateMs = Number(data.createdDateMs);
  const acknowledgedDateMs = data.acknowledgedDateMs === undefined || data.acknowledgedDateMs === null
    ? null : Number(data.acknowledgedDateMs);
  if (!/^(USD|KHR)$/.test(currency) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) ||
      !Number.isFinite(amountNumber) || amountNumber <= 0 ||
      !Number.isFinite(createdDateMs) || createdDateMs <= 0 ||
      (acknowledgedDateMs !== null && (!Number.isFinite(acknowledgedDateMs) || acknowledgedDateMs <= 0)) ||
      !/^[a-f0-9]{64}$/i.test(String(data.hash || '')) ||
      typeof data.fromAccountId !== 'string' || !data.fromAccountId.trim() ||
      typeof data.toAccountId !== 'string' || !data.toAccountId.trim()) {
    throw new TypeError('Bakong transaction response is missing required verified fields');
  }
  return Object.freeze({
    transactionHash: data.hash,
    fromAccountId: data.fromAccountId,
    toAccountId: data.toAccountId,
    currencyCode: currency,
    amount,
    description: String(data.description || ''),
    createdDateMs,
    acknowledgedDateMs,
    trackingStatus: data.trackingStatus === undefined ? null : data.trackingStatus,
    receiverBank: data.receiverBank === undefined ? null : data.receiverBank,
    receiverBankAccount: data.receiverBankAccount === undefined ? null : data.receiverBankAccount
  });
}

function createBakongOpenApiClient(options) {
  const input = options || {};
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  const fetchImpl = input.fetchImpl || globalThis.fetch;
  const timeoutMs = input.timeoutMs === undefined ? 10000 : Number(input.timeoutMs);
  if (!token) throw new TypeError('Bakong Open API bearer token is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new TypeError('timeoutMs must be an integer between 100 and 60000');
  }

  async function post(path, body) {
    const response = await fetchImpl(baseUrl + path, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response || response.ok !== true) {
      const error = new Error('Bakong Open API request failed');
      error.code = 'BAKONG_HTTP_ERROR';
      error.status = response && Number.isInteger(response.status) ? response.status : null;
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      const error = new Error('Bakong Open API returned invalid JSON');
      error.code = 'BAKONG_RESPONSE_INVALID';
      throw error;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error('Bakong Open API response must be an object');
      error.code = 'BAKONG_RESPONSE_INVALID';
      throw error;
    }
    return payload;
  }

  async function checkTransactionByMd5(value) {
    const md5 = normalizeMd5(value);
    const payload = await post('/v1/check_transaction_by_md5', { md5 });
    if (Number(payload.responseCode) === 0 && payload.data) {
      return Object.freeze({ status: 'SUCCESS', md5, transaction: normalizeTransaction(payload.data) });
    }
    if (Number(payload.errorCode) === 1) return Object.freeze({ status: 'NOT_FOUND', md5, transaction: null });
    if (Number(payload.errorCode) === 2) return Object.freeze({ status: 'STATIC_QR', md5, transaction: null });
    if (Number(payload.errorCode) === 3) return Object.freeze({ status: 'FAILED', md5, transaction: null });
    const error = new Error('Bakong Open API returned an unrecognized transaction status');
    error.code = 'BAKONG_STATUS_UNRECOGNIZED';
    throw error;
  }

  async function checkTransactionByMd5List(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 50) {
      throw new TypeError('md5 list must contain between 1 and 50 values');
    }
    const md5 = values.map(normalizeMd5);
    if (new Set(md5).size !== md5.length) throw new TypeError('md5 list must not contain duplicates');
    const payload = await post('/v1/check_transaction_by_md5_list', { md5 });
    if (Number(payload.responseCode) !== 0 || !Array.isArray(payload.data) || payload.data.length !== md5.length) {
      const error = new Error('Bakong Open API returned an invalid batch response');
      error.code = 'BAKONG_BATCH_RESPONSE_INVALID';
      throw error;
    }
    const byDigest = new Map();
    for (const entry of payload.data) {
      if (!entry || typeof entry !== 'object') throw new TypeError('Bakong batch item is invalid');
      const digest = normalizeMd5(entry.md5);
      if (!md5.includes(digest) || byDigest.has(digest)) {
        const error = new Error('Bakong batch response contains an unknown or duplicate digest');
        error.code = 'BAKONG_BATCH_RESPONSE_INVALID';
        throw error;
      }
      let transaction = null;
      const status = String(entry.status || '').toUpperCase();
      if (status === 'SUCCESS') transaction = normalizeTransaction(entry.data);
      else if (!['NOT_FOUND', 'STATIC_QR', 'FAILED'].includes(status)) {
        const error = new Error('Bakong batch response contains an unrecognized status');
        error.code = 'BAKONG_STATUS_UNRECOGNIZED';
        throw error;
      }
      byDigest.set(digest, Object.freeze({ status, md5: digest, transaction }));
    }
    return md5.map(digest => byDigest.get(digest));
  }

  return Object.freeze({ checkTransactionByMd5, checkTransactionByMd5List });
}

module.exports = { createBakongOpenApiClient, normalizeMd5, normalizeTransaction };
