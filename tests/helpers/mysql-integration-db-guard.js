'use strict';

function assertSafeIntegrationDatabaseName(databaseName) {
  const name = String(databaseName || '');
  if (!/^[a-z0-9_]+(?:_test|_testing|_integration)$/i.test(name)) {
    throw new Error('Destructive Telegram outbox integration test requires a database name ending in _test, _testing, or _integration');
  }
  return name;
}

module.exports = { assertSafeIntegrationDatabaseName };
