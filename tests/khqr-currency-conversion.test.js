'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const khqr = require('../server/services/khqr');
const registerAdminManageRoutes = require('../routes/admin-manage');

function tlv(tag, value) {
  const text = String(value);
  return tag + String(text.length).padStart(2, '0') + text;
}

function staticKhqrPayload() {
  const body = [
    tlv('00', '01'),
    tlv('01', '11'),
    tlv('53', '840'),
    tlv('59', 'FOODFLOW'),
    tlv('60', 'PHNOM PENH')
  ].join('') + '6304';
  return body + khqr.crc16(body);
}

function setup({ rates = [{ code: 'USD', rate: 1 }, { code: 'KHR', rate: 4000 }], lockedOrderOverride = {}, orderTotal = 10 } = {}) {
  const handlers = new Map();
  const calls = [];
  const app = {
    get() {},
    put() {},
    delete() {},
    post(path, ...callbacks) { handlers.set(path, callbacks[callbacks.length - 1]); }
  };
  const provider = {
    id: 'provider-1', enabled: true, isDefault: true, payload: staticKhqrPayload(),
    currency: 'USD', merchantName: 'FoodFlow', bank: 'ABA', label: 'ABA'
  };
  const deps = {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('SELECT id, name FROM stores')) return { id: 9, name: 'Test Store' };
      if (params && params[0] === 'store_9_khqr_providers') return { value: JSON.stringify([provider]) };
      if (params && params[0] === 'store_9_khqr_expire_minutes') return { value: '10' };
      if (sql.includes('FROM orders WHERE id=? AND store_id=?')) {
        const order = {
          id: 42, store_id: 9, status: 'pending', total: orderTotal, awaiting_confirm: 0,
          pay_khqr_ref: '', pay_expires_at: '',
          items: JSON.stringify([{ currency_code: 'KHR', price: 40000, quantity: 1 }]),
          order_no: '110042'
        };
        return sql.includes('FOR UPDATE') ? { ...order, ...lockedOrderOverride } : order;
      }
      return null;
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'run', sql, params });
      return { affectedRows: 1 };
    },
    allAsync: async (sql, params) => {
      calls.push({ type: 'all', sql, params });
      return rates;
    },
    withTransaction: async work => work(),
    syncTableStatus: async () => {},
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
    requireAdminOrCashier: (_req, _res, next) => next(),
    requireAdminOrCashierOrWaiter: (_req, _res, next) => next(),
    requireAdminOrWaiter: (_req, _res, next) => next(),
    hashPassword: value => value,
    verifyPassword: () => true,
    logAudit: async () => {},
    getClientIp: () => '127.0.0.1',
    io: { to: () => ({ emit() {} }) }
  };
  registerAdminManageRoutes(app, deps);
  return { handler: handlers.get('/api/cashier/khqr/generate'), calls };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('KHQR KHR amount converts the normalized USD order total, not the menu display currency', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'KHR' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount, 40000);
  assert.equal(res.body.original_amount, 10);
  assert.equal(res.body.original_currency, 'USD');
  const rateQuery = calls.find(call => call.type === 'all' && call.sql.includes('currencies'));
  assert.deepEqual(rateQuery.params, [77]);
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('pay_khqr_ref')));
});

test('KHQR conversion never falls back to merchant 1 or a fabricated 1:1 KHR rate', async () => {
  const { handler, calls } = setup({ rates: [{ code: 'USD', rate: 1 }] });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'KHR' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /KHR 汇率缺失或无效/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('pay_khqr_ref')), false);
  const rateQuery = calls.find(call => call.type === 'all' && call.sql.includes('currencies'));
  assert.deepEqual(rateQuery.params, [77]);
});


test('concurrent KHQR generation cannot replace a QR created after the initial order read', async () => {
  const { handler, calls } = setup({
    lockedOrderOverride: {
      pay_khqr_ref: 'already-issued-dynamic-payload',
      pay_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    }
  });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'KHR' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /已有有效收款码/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('pay_khqr_ref')), false);
  assert.ok(calls.some(call => call.type === 'get' && call.sql.includes('FOR UPDATE')));
});

test('KHQR generation refuses to replace a QR with an unknown expiry', async () => {
  const { handler, calls } = setup({
    lockedOrderOverride: {
      pay_khqr_ref: 'legacy-dynamic-payload',
      pay_expires_at: ''
    }
  });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'KHR' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /已有有效收款码/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('pay_khqr_ref')), false);
});


test('KHR KHQR amount is rounded to whole riels and matches the encoded payload', async () => {
  const { handler } = setup({
    rates: [{ code: 'USD', rate: 1 }, { code: 'KHR', rate: '4000.005' }],
    orderTotal: '10.01'
  });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'KHR' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount, 40040);
  assert.equal(khqr.extractInfo(khqr.parseTLV(res.body.qr_payload)).amount, '40040');
  assert.equal(res.body.original_amount, 10.01);
});

test('USD KHQR response amount matches the exact two-decimal payload amount', async () => {
  const { handler } = setup({ orderTotal: '10.01' });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'USD' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount, 10.01);
  assert.equal(khqr.extractInfo(khqr.parseTLV(res.body.qr_payload)).amount, '10.01');
});

test('KHR conversion rejects unsupported rate precision instead of returning a mismatched amount', async () => {
  const { handler, calls } = setup({
    rates: [{ code: 'USD', rate: 1 }, { code: 'KHR', rate: '4000.12345678901' }],
    orderTotal: '10.01'
  });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'KHR' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /汇率精度/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('pay_khqr_ref')), false);
});

test('KHQR generation compares locked order totals by exact cents', async () => {
  const { handler, calls } = setup({
    lockedOrderOverride: { total: '10.01' },
    orderTotal: '10.00'
  });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'USD' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /金额已变化/);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('pay_khqr_ref')), false);
});
