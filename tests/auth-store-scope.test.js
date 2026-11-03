'use strict';

process.env.DB_DATABASE = process.env.DB_DATABASE || 'foodflow_test';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_DATABASE = process.env.DB_DATABASE || 'foodflow_test';
const { pool } = require('../server/db/pool');
const { requireCashier } = require('../server/middleware/auth');

function request() {
  return {
    get(name) {
      if (name === 'X-Cashier-Token') return 'test-cashier-session';
      if (name === 'Authorization') return '';
      return '';
    }
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('cashier session is rejected when its store or merchant is inactive', async () => {
  const originalExecute = pool.execute;
  const queries = [];
  pool.execute = async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM cashier_sessions')) {
      return [[{
        cashier_id: 8,
        store_id: 23,
        merchant_id: 9,
        expires_at: new Date(Date.now() + 60000).toISOString()
      }]];
    }
    if (sql.includes('JOIN merchants')) return [[]];
    throw new Error('Unexpected SQL: ' + sql);
  };

  try {
    const res = response();
    let nextCalled = false;
    await requireCashier(request(), res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
    assert.match(res.body.error, /停用/);
    assert.equal(queries.length, 2);
  } finally {
    pool.execute = originalExecute;
  }
});

test('cashier session keeps its exact positive store and merchant IDs', async () => {
  const originalExecute = pool.execute;
  const queries = [];
  pool.execute = async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM cashier_sessions')) {
      return [[{
        cashier_id: 8,
        store_id: 23,
        merchant_id: 9,
        expires_at: new Date(Date.now() + 60000).toISOString()
      }]];
    }
    if (sql.includes('JOIN merchants')) return [[{ id: 23 }]];
    if (sql.includes("settings")) return [[{ value: JSON.stringify([{ id: 8, active: true }]) }]];
    throw new Error('Unexpected SQL: ' + sql);
  };

  try {
    const res = response();
    let nextCalled = false;
    const req = request();
    await requireCashier(req, res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 200);
    assert.equal(nextCalled, true);
    assert.equal(req.storeId, 23);
    assert.equal(req.merchantId, 9);
    assert.equal(req.cashier.id, 8);
    assert.ok(queries.some(sql => sql.includes('JOIN merchants')));
  } finally {
    pool.execute = originalExecute;
  }
});
