'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
const authPath = require.resolve('../server/middleware/admin-auth');
const originals = new Map([helperPath, authPath].map(file => [file, require.cache[file]]));
const { hashSessionToken } = require('../server/services/session-token');

const state = {
  session: null,
  admin: { id: 7, merchant_id: 4, can_manage_financial_reconciliation: 1 },
  merchant: { id: 4, status: 1 },
  deletes: []
};

require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: {
    getAsync: async (sql, params = []) => {
      if (sql.includes('FROM admin_sessions')) return state.session;
      if (sql.includes('FROM merchant_admins') && sql.includes('active=1')) return state.admin;
      if (sql.includes('FROM merchants') && sql.includes('status=1')) return state.merchant;
      if (sql.includes("admin_access_key_hash")) return null;
      if (sql.includes("admin_access_key_store_id")) return null;
      return null;
    },
    runAsync: async (sql, params = []) => {
      state.deletes.push({ sql, params });
      return { affectedRows: 1 };
    },
    allAsync: async () => []
  }
};
delete require.cache[authPath];
const { requireAdminKey, requirePermission } = require('../server/middleware/admin-auth');

function response() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

async function authenticate(token) {
  const req = {
    get(name) {
      if (name === 'Authorization') return 'Bearer ' + token;
      return undefined;
    }
  };
  const res = response();
  let nextCalls = 0;
  await requireAdminKey(req, res, () => { nextCalls += 1; });
  return { req, res, nextCalls };
}

test('disabled merchant administrator cannot retain financial permissions through an existing session', async () => {
  const token = 'finance-disabled-admin-session-token';
  state.session = { admin_id: 7, expires_at: new Date(Date.now() + 60_000).toISOString() };
  state.admin = null; // Query is constrained by active=1.
  state.merchant = { id: 4, status: 1 };

  const { res, nextCalls } = await authenticate(token);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalls, 0);
  assert.equal(res.body.error, '未登录或登录已过期');
});

test('administrator session is rejected when the merchant is inactive', async () => {
  const token = 'finance-inactive-merchant-session-token';
  state.session = { admin_id: 7, expires_at: new Date(Date.now() + 60_000).toISOString() };
  state.admin = { id: 7, merchant_id: 4, can_manage_financial_reconciliation: 1 };
  state.merchant = null; // Query is constrained by status=1.

  const { res, nextCalls } = await authenticate(token);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalls, 0);
});

test('expired administrator sessions are rejected and their token hash is revoked', async () => {
  const token = 'finance-expired-admin-session-token';
  state.session = { admin_id: 7, expires_at: new Date(Date.now() - 60_000).toISOString() };
  state.admin = { id: 7, merchant_id: 4, can_manage_financial_reconciliation: 1 };
  state.merchant = { id: 4, status: 1 };
  state.deletes.length = 0;

  const { res, nextCalls } = await authenticate(token);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalls, 0);
  assert.match(res.body.error, /登录已过期/);
  assert.ok(state.deletes.some(call =>
    call.sql === 'DELETE FROM admin_sessions WHERE token_hash=?' &&
    call.params[0] === hashSessionToken(token)
  ));
});

test('finance permission is not granted when the admin authentication context is absent', () => {
  const res = response();
  let nextCalls = 0;
  requirePermission('can_manage_financial_reconciliation')({}, res, () => { nextCalls += 1; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalls, 0);
});

test.after(() => {
  for (const [file, original] of originals) {
    if (original) require.cache[file] = original;
    else delete require.cache[file];
  }
});
