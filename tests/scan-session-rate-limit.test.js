'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanSessionRateLimiter } = require('../server/services/scan-session-rate-limit');

function createSharedStore() {
  const rows = new Map();
  const statements = [];
  let transactionTail = Promise.resolve();

  const withTransaction = work => {
    const next = transactionTail.then(() => work());
    transactionTail = next.catch(() => {});
    return next;
  };

  const runAsync = async (sql, params = []) => {
    statements.push({ sql, params });
    if (sql.startsWith('INSERT INTO scan_session_rate_limits')) {
      assert.match(sql, /ON DUPLICATE KEY UPDATE/);
      assert.match(sql, /request_count=IF\(window_started_at <= DATE_SUB/);
      const key = params[0];
      const now = Date.now();
      const current = rows.get(key);
      if (!current || now - current.startedAt >= 60000) {
        rows.set(key, { startedAt: now, count: 1 });
      } else {
        current.count += 1;
      }
      return { affectedRows: 1 };
    }
    if (sql.startsWith('DELETE FROM scan_session_rate_limits')) return { affectedRows: 0 };
    throw new Error('Unexpected SQL: ' + sql);
  };

  const getAsync = async (sql, params = []) => {
    statements.push({ sql, params });
    assert.match(sql, /FROM scan_session_rate_limits WHERE ip_hash=\? FOR UPDATE/);
    const current = rows.get(params[0]);
    if (!current) return null;
    return {
      request_count: current.count,
      retry_after: Math.max(1, Math.ceil((60000 - (Date.now() - current.startedAt)) / 1000))
    };
  };

  return { rows, statements, runAsync, getAsync, withTransaction };
}

test('scan-session rate limit is shared across instances and caps concurrent requests atomically', async () => {
  const store = createSharedStore();
  const dependencies = {
    getAsync: store.getAsync,
    runAsync: store.runAsync,
    withTransaction: store.withTransaction
  };
  const instanceA = createScanSessionRateLimiter(dependencies);
  const instanceB = createScanSessionRateLimiter(dependencies);

  const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    (index % 2 ? instanceA : instanceB).consume('203.0.113.42')
  ));

  assert.equal(results.filter(value => value === 0).length, 60);
  assert.equal(results.filter(value => value > 0).length, 40);
  assert.equal(store.rows.size, 1);
  const [ipHash] = store.rows.keys();
  assert.match(ipHash, /^[a-f0-9]{64}$/);
  assert.ok(store.statements.every(statement => !statement.params.includes('203.0.113.42')));
  assert.ok(store.statements.some(statement => statement.sql.includes('FOR UPDATE')));
});

test('scan-session rate limiter resets an expired fixed window', async () => {
  const store = createSharedStore();
  const limiter = createScanSessionRateLimiter({
    getAsync: store.getAsync,
    runAsync: store.runAsync,
    withTransaction: store.withTransaction
  });
  const ipHash = require('../server/services/scan-session-rate-limit').hashClientIp('198.51.100.8');
  store.rows.set(ipHash, { startedAt: Date.now() - 61000, count: 60 });

  assert.equal(await limiter.consume('198.51.100.8'), 0);
  assert.equal(store.rows.get(ipHash).count, 1);
});

test('scan-session rate limiter fails closed when shared storage is unavailable', async () => {
  const limiter = createScanSessionRateLimiter({
    getAsync: async () => null,
    runAsync: async () => { throw new Error('database unavailable'); },
    withTransaction: async work => work()
  });

  await assert.rejects(
    limiter.consume('192.0.2.7'),
    error => error.status === 503 && error.code === 'SCAN_RATE_LIMIT_UNAVAILABLE'
  );
});

test('scan-session rate limiter prunes stale counters without storing raw IP addresses', async () => {
  const statements = [];
  const limiter = createScanSessionRateLimiter({
    getAsync: async () => null,
    runAsync: async (sql, params = []) => {
      statements.push({ sql, params });
      return { affectedRows: 1 };
    },
    withTransaction: async work => work()
  });

  await limiter.cleanup();
  assert.match(statements[0].sql, /DELETE FROM scan_session_rate_limits/);
  assert.match(statements[0].sql, /window_started_at < DATE_SUB/);
  assert.deepEqual(statements[0].params, []);
});
