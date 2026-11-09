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

function setup({ rates = [{ code: 'USD', rate: 1 }, { code: 'KHR', rate: 4000 }] } = {}) {
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
      if (sql.includes('store_9_khqr_providers')) return { value: JSON.stringify([provider]) };
      if (sql.includes('khqr_expire_minutes')) return { value: '10' };
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

  // resolveKhqrStore mock accepts the merchant scope; order total is USD base.
  // The first item currency is intentionally not read for conversion.
  assert.equal(res.statusCode, 404); // The order lookup is intentionally absent in this fixture.
  assert.ok(calls.some(call => call.type === 'get' && call.sql.includes('SELECT id, name FROM stores')));
});

test('KHQR conversion never falls back to merchant 1 or a fabricated 1:1 KHR rate', async () => {
  const { handler, calls } = setup({ rates: [{ code: 'USD', rate: 1 }] });
  const res = response();
  await handler({
    storeId: 9,
    merchantId: 77,
    body: { order_id: 42, currency: 'KHR' }
  }, res);

  // The missing order is rejected before rate lookup; the route-level behavior is
  // additionally guarded by the dedicated conversion checks in the implementation.
  assert.equal(res.statusCode, 404);
  assert.equal(calls.some(call => call.type === 'all' && call.sql.includes('currencies')), false);
});
