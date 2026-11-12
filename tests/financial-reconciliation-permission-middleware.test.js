'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// The auth module imports the shared MySQL pool; provide a harmless database name so this unit test never needs a live DB.
process.env.DB_DATABASE = process.env.DB_DATABASE || 'finance_permission_test';
const { requirePermission } = require('../server/middleware/admin-auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('finance permission denies missing, disabled, and legacy API-key-only administrator scopes', () => {
  const middleware = requirePermission('can_manage_financial_reconciliation');
  const deniedRequests = [
    { isPrimaryAdmin: false, adminPermissions: undefined },
    { isPrimaryAdmin: false, adminPermissions: {} },
    { isPrimaryAdmin: false, adminPermissions: { can_manage_financial_reconciliation: 0 } },
    { isPrimaryAdmin: false, adminPermissions: { can_manage_financial_reconciliation: false } },
    { isPrimaryAdmin: false, legacyApiKey: true }
  ];

  for (const req of deniedRequests) {
    const res = response();
    let nextCalls = 0;
    middleware(req, res, () => { nextCalls += 1; });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: '没有操作权限' });
    assert.equal(nextCalls, 0);
  }
});

test('finance permission allows an explicitly enabled finance permission and the primary merchant administrator', () => {
  const middleware = requirePermission('can_manage_financial_reconciliation');
  const allowedRequests = [
    { isPrimaryAdmin: false, adminPermissions: { can_manage_financial_reconciliation: 1 } },
    { isPrimaryAdmin: false, adminPermissions: { can_manage_financial_reconciliation: true } },
    { isPrimaryAdmin: true, adminPermissions: { can_manage_financial_reconciliation: 0 } }
  ];

  for (const req of allowedRequests) {
    const res = response();
    let nextCalls = 0;
    middleware(req, res, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);
  }
});
