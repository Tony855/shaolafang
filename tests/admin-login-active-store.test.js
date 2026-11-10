'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('admin login returns the first active store, never an inactive one', async () => {
  const routes = new Map();
  const app = {
    post(path, ...handlers) { routes.set(path, handlers); }
  };
  let storeQuery = '';
  const admin = {
    id: 11, merchant_id: 9, username: 'admin', password_hash: 'hash',
    active: 1, display_name: 'Admin',
    can_manage_menu: 1, can_manage_table: 1, can_manage_order: 1,
    can_delete_order: 1, can_edit_order: 1, can_manage_store: 1,
    can_manage_waiter: 1, can_manage_currency: 1, can_manage_printer: 1,
    can_manage_admin: 1, can_view_logs: 1, can_manage_cashier: 1
  };
  const writes = [];
  require('../routes/auth')(app, {
    getAsync: async sql => {
      if (sql.includes('FROM merchant_admins WHERE username')) return admin;
      if (sql.includes('FROM merchants WHERE id')) return { id: 9, status: 1, name: 'Merchant' };
      if (sql.includes("admin_idle_timeout")) return null;
      if (sql.includes('FROM stores WHERE merchant_id')) {
        storeQuery = sql;
        // The active store is ID 27; the merchant's lower-ID store is inactive.
        return { id: 27 };
      }
      if (sql.includes('FROM merchant_admins WHERE merchant_id')) return { id: 11 };
      return null;
    },
    runAsync: async (sql, params) => {
      writes.push({ sql, params });
      return { affectedRows: 1, insertId: 1 };
    },
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt() {},
    resetLoginAttempts() {},
    cancelLoginAttempt() {},
    verifyPassword: () => true,
    getClientIp: () => '127.0.0.1',
    getLocationByIp: async () => '',
    requireAdminKey: (_req, _res, next) => next()
  });

  const handler = routes.get('/api/admin/login')[0];
  const res = response();
  await handler({
    body: { username: 'admin', password: 'password' },
    get: name => name === 'User-Agent' ? 'test-agent' : ''
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.storeId, 27);
  assert.match(storeQuery, /active\s*=\s*1/);
  assert.ok(writes.some(item => item.sql.includes('INSERT INTO admin_sessions')));
});
