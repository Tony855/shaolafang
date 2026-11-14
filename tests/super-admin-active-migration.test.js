'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureSuperAdminActiveSchema } = require('../server/db/migrations/super-admin-active');

test('adds active with enabled default when upgrading a legacy super_admins table', async () => {
  let hasActive = false;
  const statements = [];
  const result = await ensureSuperAdminActiveSchema({
    allAsync: async (_sql, params) => {
      assert.deepEqual(params, ['active']);
      return hasActive ? [{ COLUMN_NAME: 'active' }] : [];
    },
    runAsync: async sql => {
      statements.push(sql);
      hasActive = true;
    },
    logger: null
  });

  assert.deepEqual(result, { changed: true });
  assert.equal(statements.length, 1);
  assert.match(statements[0], /ADD COLUMN active TINYINT\(1\) NOT NULL DEFAULT 1 AFTER display_name/i);
});

test('does not alter a table that already has active', async () => {
  let alterCalls = 0;
  const result = await ensureSuperAdminActiveSchema({
    allAsync: async () => [{ COLUMN_NAME: 'active' }],
    runAsync: async () => { alterCalls += 1; },
    logger: null
  });

  assert.deepEqual(result, { changed: false });
  assert.equal(alterCalls, 0);
});

test('treats a concurrent duplicate-column migration as already applied', async () => {
  const result = await ensureSuperAdminActiveSchema({
    allAsync: async () => [],
    runAsync: async () => {
      const error = new Error('Duplicate column name active');
      error.code = 'ER_DUP_FIELDNAME';
      throw error;
    },
    logger: null
  });

  assert.deepEqual(result, { changed: false });
});

test('rejects incomplete dependencies and propagates unrelated database errors', async () => {
  await assert.rejects(
    () => ensureSuperAdminActiveSchema({ allAsync: async () => [] }),
    /requires allAsync and runAsync/
  );

  const databaseError = new Error('database unavailable');
  await assert.rejects(
    () => ensureSuperAdminActiveSchema({
      allAsync: async () => [],
      runAsync: async () => { throw databaseError; },
      logger: null
    }),
    error => error === databaseError
  );
});
