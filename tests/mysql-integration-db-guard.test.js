'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeIntegrationDatabaseName } = require('./helpers/mysql-integration-db-guard');

test('destructive integration database guard accepts dedicated test databases', () => {
  for (const name of ['shaolafang_test', 'telegram_outbox_testing', 'ci_integration', 'APP_TEST']) {
    assert.equal(assertSafeIntegrationDatabaseName(name), name);
  }
});

test('destructive integration database guard rejects production and ambiguous names', () => {
  for (const name of ['production', 'shaolafang', 'test', 'integration', '', 'prod_test_backup']) {
    assert.throws(() => assertSafeIntegrationDatabaseName(name), /requires a database name ending in/);
  }
});
