'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPayWayCallbackSignature,
  getPayWaySignature,
  verifyPayWayPaymentCallback
} = require('../server/services/payment-providers/aba-payway');
const {
  createBakongOpenApiClient
} = require('../server/services/payment-providers/bakong-open-api');

test('PayWay callback verifier authenticates the documented sorted-value HMAC-SHA512 signature', () => {
  const secretKey = 'test-only-secret';
  const payload = {
    tran_id: 'payway-txn-1001',
    status: '0',
    apv: '123456',
    original_amount: '12.50',
    original_currency: 'USD',
    payment_amount: '12.50',
    payment_currency: 'USD'
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = buildPayWayCallbackSignature(payload, secretKey);
  const result = verifyPayWayPaymentCallback({ rawBody, signature, secretKey });
  assert.equal(result.providerCode, 'ABA_PAYWAY');
  assert.equal(result.authenticated, true);
  assert.equal(result.transactionId, 'payway-txn-1001');
  assert.equal(result.paymentStatusCode, '0');
  assert.match(result.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, 'rawBody'), false);
  assert.equal(Object.hasOwn(result, 'payload'), false);
});

test('PayWay callback verifier rejects tampering and extracts the documented header case-insensitively', () => {
  const secretKey = 'test-only-secret';
  const payload = { tran_id: 'payway-txn-1002', status: '0', apv: '654321' };
  const rawBody = JSON.stringify(payload);
  const signature = buildPayWayCallbackSignature(payload, secretKey);
  assert.equal(getPayWaySignature({ 'X-PAYWAY-HMAC-SHA512': signature }), signature);
  assert.equal(getPayWaySignature({ 'x-payway-hmac-sha512': signature }), signature);
  assert.equal(verifyPayWayPaymentCallback({
    rawBody: JSON.stringify({ ...payload, status: '1' }), signature, secretKey
  }).authenticated, false);
});

test('PayWay callback verifier fails closed on missing secret, invalid JSON and nested fields', () => {
  assert.throws(() => verifyPayWayPaymentCallback({
    rawBody: '{}', signature: 'x', secretKey: ''
  }), error => error.code === 'PAYWAY_CALLBACK_SECRET_MISSING');
  assert.throws(() => verifyPayWayPaymentCallback({
    rawBody: '{bad', signature: 'x', secretKey: 'secret'
  }), error => error.code === 'PAYWAY_CALLBACK_JSON_INVALID');
  assert.throws(() => buildPayWayCallbackSignature({ tran_id: 'x', nested: { a: 1 } }, 'secret'),
    error => error.code === 'PAYWAY_CALLBACK_VALUE_UNSUPPORTED');
});

test('Bakong Open API client checks a dynamic KHQR transaction and preserves provider amount text', async () => {
  const calls = [];
  const client = createBakongOpenApiClient({
    baseUrl: 'https://sit-api-bakong.nbc.gov.kh',
    token: 'test-bearer-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          responseCode: 0,
          data: {
            hash: 'a'.repeat(64),
            fromAccountId: 'payer@bank',
            toAccountId: 'merchant@bank',
            currency: 'USD',
            amount: 12.5,
            description: 'invoice 100',
            createdDateMs: 1760000000000,
            acknowledgedDateMs: 1760000001000
          }
        })
      };
    }
  });
  const result = await client.checkTransactionByMd5('b'.repeat(32));
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.transaction.amount, '12.5');
  assert.equal(result.transaction.currencyCode, 'USD');
  assert.equal(calls[0].url, 'https://sit-api-bakong.nbc.gov.kh/v1/check_transaction_by_md5');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-bearer-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { md5: 'b'.repeat(32) });
});

test('Bakong Open API client maps not-found and failed results without treating them as paid', async () => {
  const responses = [
    { responseCode: 1, errorCode: 1, data: null },
    { responseCode: 1, errorCode: 3, data: null }
  ];
  const client = createBakongOpenApiClient({
    baseUrl: 'https://sit-api-bakong.nbc.gov.kh',
    token: 'test-token',
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });
  assert.equal((await client.checkTransactionByMd5('c'.repeat(32))).status, 'NOT_FOUND');
  assert.equal((await client.checkTransactionByMd5('d'.repeat(32))).status, 'FAILED');
});

test('Bakong batch verification enforces the 50-item limit and maps responses by digest', async () => {
  const first = '1'.repeat(32);
  const second = '2'.repeat(32);
  const client = createBakongOpenApiClient({
    baseUrl: 'https://sit-api-bakong.nbc.gov.kh',
    token: 'test-token',
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), [first, second]);
      return {
        ok: true,
        json: async () => ({
          responseCode: 0,
          data: [
            { md5: second, status: 'NOT_FOUND', data: null },
            { md5: first, status: 'SUCCESS', data: {
              hash: 'c'.repeat(64), fromAccountId: 'payer@bank', toAccountId: 'merchant@bank',
              currency: 'KHR', amount: '1000', createdDateMs: 1760000000000
            } }
          ]
        })
      };
    }
  });
  const result = await client.checkTransactionByMd5List([first, second]);
  assert.deepEqual(result.map(row => row.status), ['SUCCESS', 'NOT_FOUND']);
  assert.equal(result[0].transaction.amount, '1000');
  await assert.rejects(client.checkTransactionByMd5List(Array(51).fill(first)),
    /between 1 and 50/);
});

test('Bakong client bounds request time and rejects zero or malformed transaction data', async () => {
  assert.throws(() => createBakongOpenApiClient({
    baseUrl: 'https://sit-api-bakong.nbc.gov.kh',
    token: 'test-token',
    timeoutMs: 99,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) })
  }), /timeoutMs/);
  const client = createBakongOpenApiClient({
    baseUrl: 'https://sit-api-bakong.nbc.gov.kh',
    token: 'test-token',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        responseCode: 0,
        data: {
          hash: 'f'.repeat(64), fromAccountId: 'payer@bank', toAccountId: 'merchant@bank',
          currency: 'USD', amount: '0', createdDateMs: 1760000000000
        }
      })
    })
  });
  await assert.rejects(client.checkTransactionByMd5('a'.repeat(32)),
    /missing required verified fields/);
});

test('Bakong client rejects unsafe URLs, invalid digests, duplicate batch IDs and provider errors', async () => {
  assert.throws(() => createBakongOpenApiClient({
    baseUrl: 'http://example.com', token: 'x', fetchImpl: async () => ({})
  }), /HTTPS/);
  assert.throws(() => createBakongOpenApiClient({
    baseUrl: 'https://example.com/path', token: 'x', fetchImpl: async () => ({})
  }), /only an origin/);
  const client = createBakongOpenApiClient({
    baseUrl: 'https://sit-api-bakong.nbc.gov.kh',
    token: 'test-token',
    fetchImpl: async () => ({ ok: false, status: 401 })
  });
  await assert.rejects(client.checkTransactionByMd5('not-md5'), /32-character/);
  await assert.rejects(client.checkTransactionByMd5('e'.repeat(32)), error => error.code === 'BAKONG_HTTP_ERROR');
});
