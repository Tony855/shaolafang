'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helperPath = require.resolve('../server/db/helpers');
const authPath = require.resolve('../server/middleware/auth');
const originals = new Map([helperPath, authPath].map(path => [path, require.cache[path]]));
const { hashSessionToken } = require('../server/services/session-token');

const deletes = [];
let superAdminQuery = '';
require.cache[helperPath] = {
  id: helperPath,
  filename: helperPath,
  loaded: true,
  exports: {
    getAsync: async sql => {
      if (sql.includes('FROM super_sessions')) {
        return { super_admin_id: 7, expires_at: new Date(Date.now() + 60_000).toISOString() };
      }
      if (sql.includes('FROM super_admins')) {
        superAdminQuery = sql;
        return null; // Disabled or deleted account.
      }
      return null;
    },
    runAsync: async (sql, params) => {
      deletes.push({ sql, params });
      return { affectedRows: 1 };
    }
  }
};
delete require.cache[authPath];
const { requireSuperAdmin } = require('../server/middleware/auth');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('disabled super-admin accounts immediately lose existing sessions', async () => {
  const token = 'already-issued-super-admin-token';
  const req = { headers: { authorization: 'Bearer ' + token } };
  const res = response();
  let nextCalled = false;

  await requireSuperAdmin(req, res, () => { nextCalled = true; });

  assert.match(superAdminQuery, /WHERE id=\? AND active=1/);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /账号已停用/);
  assert.ok(deletes.some(call =>
    call.sql === 'DELETE FROM super_sessions WHERE token_hash=?' &&
    call.params[0] === hashSessionToken(token)
  ));
});

test.after(() => {
  for (const [path, original] of originals) {
    if (original) require.cache[path] = original;
    else delete require.cache[path];
  }
});
