'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginRateLimiter } = require('../server/services/login-rate-limit');

function setup({ maxAttempts = 5, lockMinutes = 15 } = {}) {
  const rows = new Map();
  let now = Date.UTC(2026, 10, 10, 12, 0, 0);
  let tail = Promise.resolve();
  const keyOf = (type, username) => type + ':' + username;
  const withTransaction = async work => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  };
  const getAsync = async (sql, params = []) => {
    if (sql.includes("login_max_attempts")) return { value: String(maxAttempts) };
    if (sql.includes("login_lock_minutes")) return { value: String(lockMinutes) };
    if (sql.includes('FROM login_rate_limits')) {
      const [minutes, type, username] = params;
      const row = rows.get(keyOf(type, username));
      if (!row) return null;
      const isLocked = row.lockedUntil !== null && row.lockedUntil > now;
      return {
        failed_attempts: row.failedAttempts,
        is_locked: isLocked ? 1 : 0,
        remaining: isLocked ? Math.max(1, Math.ceil((row.lockedUntil - now) / 60000)) : 0,
        window_expired: row.windowStartedAt <= now - minutes * 60000 ? 1 : 0
      };
    }
    throw new Error('Unexpected SELECT: ' + sql);
  };
  const runAsync = async (sql, params = []) => {
    if (sql.startsWith('INSERT IGNORE INTO login_rate_limits')) {
      const [type, username] = params;
      const key = keyOf(type, username);
      if (!rows.has(key)) rows.set(key, { failedAttempts: 0, windowStartedAt: now, lockedUntil: null });
      return { affectedRows: 1 };
    }
    if (sql.includes('SET failed_attempts=0')) {
      const [type, username] = params;
      const row = rows.get(keyOf(type, username));
      if (row) Object.assign(row, { failedAttempts: 0, windowStartedAt: now, lockedUntil: null });
      return { affectedRows: row ? 1 : 0 };
    }
    if (sql.includes('SET locked_until=DATE_ADD')) {
      const [minutes, type, username] = params;
      const row = rows.get(keyOf(type, username));
      row.lockedUntil = now + minutes * 60000;
      return { affectedRows: 1 };
    }
    if (sql.includes('SET failed_attempts=?')) {
      const expired = sql.includes('window_started_at=UTC_TIMESTAMP');
      const [count, lockCount, maximum, minutes, type, username] = expired
        ? params
        : [params[0], params[1], params[2], params[3], params[4], params[5]];
      const row = rows.get(keyOf(type, username));
      row.failedAttempts = count;
      if (expired) row.windowStartedAt = now;
      row.lockedUntil = lockCount >= maximum ? now + minutes * 60000 : null;
      return { affectedRows: 1 };
    }
    throw new Error('Unexpected write: ' + sql);
  };
  const limiter = createLoginRateLimiter({ getAsync, runAsync, withTransaction });
  return { ...limiter, rows, advance: ms => { now += ms; } };
}

test('concurrent failed login attempts cannot exceed the configured allowance', async () => {
  const limiter = setup({ maxAttempts: 5 });
  const results = await Promise.all(Array.from({ length: 25 }, () => limiter.isLoginLocked('Admin', 'super_admin')));
  assert.equal(results.filter(result => !result.locked).length, 5);
  assert.equal(results.filter(result => result.locked).length, 20);
});

test('successful authentication resets the account lock across subsequent requests', async () => {
  const limiter = setup({ maxAttempts: 2 });
  assert.equal((await limiter.isLoginLocked('Admin', 'super_admin')).locked, false);
  assert.equal((await limiter.isLoginLocked('Admin', 'super_admin')).locked, false);
  assert.equal((await limiter.isLoginLocked('Admin', 'super_admin')).locked, true);
  await limiter.resetLoginAttempts('Admin', 'super_admin');
  assert.equal((await limiter.isLoginLocked('Admin', 'super_admin')).locked, false);
});

test('rate limits are isolated by login role and normalized username', async () => {
  const limiter = setup({ maxAttempts: 1 });
  assert.equal((await limiter.isLoginLocked('Ａdmin', 'super_admin')).locked, false);
  assert.equal((await limiter.isLoginLocked('admin', 'super_admin')).locked, true);
  assert.equal((await limiter.isLoginLocked('admin', 'merchant_admin')).locked, false);
});

test('expired lock window permits a new attempt window', async () => {
  const limiter = setup({ maxAttempts: 1, lockMinutes: 2 });
  assert.equal((await limiter.isLoginLocked('admin', 'waiter')).locked, false);
  assert.equal((await limiter.isLoginLocked('admin', 'waiter')).locked, true);
  limiter.advance(120001);
  assert.equal((await limiter.isLoginLocked('admin', 'waiter')).locked, false);
});
