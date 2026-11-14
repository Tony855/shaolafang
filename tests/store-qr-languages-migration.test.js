'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureStoreQrLanguagesSchema } = require('../server/db/migrations/store-qr-languages');

test('adds stores.qr_languages when the column is missing', async () => {
  const calls = [];
  const result = await ensureStoreQrLanguagesSchema({
    allAsync: async (sql, params) => {
      calls.push({ type: 'check', sql, params });
      return [];
    },
    runAsync: async (sql, params) => {
      calls.push({ type: 'alter', sql, params });
    },
    logger: { log: message => calls.push({ type: 'log', message }) }
  });

  assert.deepEqual(result, { changed: true });
  assert.equal(calls.filter(call => call.type === 'alter').length, 1);
  assert.match(calls.find(call => call.type === 'alter').sql, /ADD COLUMN qr_languages VARCHAR\(50\)/);
});

test('does not alter stores when qr_languages already exists', async () => {
  let alterCalls = 0;
  const result = await ensureStoreQrLanguagesSchema({
    allAsync: async () => [{ Field: 'qr_languages', Type: 'varchar(50)' }],
    runAsync: async () => { alterCalls += 1; },
    logger: { log() {} }
  });

  assert.deepEqual(result, { changed: false });
  assert.equal(alterCalls, 0);
});

test('rejects missing database helpers instead of silently skipping migration', async () => {
  await assert.rejects(
    () => ensureStoreQrLanguagesSchema({}),
    /requires allAsync and runAsync/
  );
});
