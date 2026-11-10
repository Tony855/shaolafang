'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginRateLimiter } = require('../server/services/login-rate-limit');

function setup({ maxAttempts = 5, lockMinutes = 15 } = {}) {
  const rows = new Map();
  const reservations = new Map();
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
    if (sql.includes('COUNT(*) AS pending_count')) {
      const [type, username] = params;
      return { pending_count: [...reservations.values()].filter(r =>
        r.type === type && r.username === username && r.state === 'pending').length };
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
    if (sql.startsWith('DELETE FROM login_rate_limit_attempts')) return { affectedRows: 0 };
    if (sql.includes("SET state='expired'")) {
      const [type, username] = params;
      let affectedRows = 0;
      for (const r of reservations.values()) {
        if (r.type === type && r.username === username && r.state === 'pending' && r.createdAt < now - 600000) {
          r.state = 'expired'; affectedRows++;
        }
      }
      return { affectedRows };
    }
    if (sql.includes("INSERT INTO login_rate_limit_attempts")) {
      const [id, type, username] = params;
      reservations.set(id, { type, username, state: 'pending', createdAt: now });
      return { affectedRows: 1 };
    }
    if (sql.includes("SET state='failed'") || sql.includes("SET state='succeeded'") || sql.includes("SET state='cancelled'")) {
      const state = sql.includes("SET state='failed'") ? 'failed' :
        (sql.includes("SET state='succeeded'") ? 'succeeded' : 'cancelled');
      const [id, type, username] = params;
      const reservation = reservations.get(id);
      if (!reservation || reservation.type !== type || reservation.username !== username || reservation.state !== 'pending') {
        return { affectedRows: 0 };
      }
      reservation.state = state;
      return { affectedRows: 1 };
    }
    if (sql.includes('SET failed_attempts=failed_attempts+1')) {
      const [maximum, minutes, type, username] = params;
      const row = rows.get(keyOf(type, username));
      row.failedAttempts += 1;
      if (row.failedAttempts >= maximum) row.lockedUntil = now + minutes * 60000;
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
    throw new Error('Unexpected write: ' + sql);
  };
  return {
    ...createLoginRateLimiter({ getAsync, runAsync, withTransaction }),
    rows, reservations,
    advance: ms => { now += ms; }
  };
}

test('concurrent reservations cannot exceed the configured in-flight allowance', async () => {
  const limiter = setup({ maxAttempts: 5 });
  const results = await Promise.all(Array.from({ length: 25 }, () => limiter.isLoginLocked('Admin', 'super_admin')));
  assert.equal(results.filter(result => !result.locked).length, 5);
  assert.equal(results.filter(result => result.locked).length, 20);
  assert.equal([...limiter.reservations.values()].filter(r => r.state === 'pending').length, 5);
});

test('success only completes its own reservation and cannot erase other in-flight attempts', async () => {
  const limiter = setup({ maxAttempts: 2 });
  const first = await limiter.isLoginLocked('Admin', 'super_admin');
  const second = await limiter.isLoginLocked('Admin', 'super_admin');
  assert.ok(first.reservationId);
  assert.ok(second.reservationId);

  assert.equal(await limiter.resetLoginAttempts('Admin', 'super_admin', first.reservationId), true);
  const third = await limiter.isLoginLocked('Admin', 'super_admin');
  assert.equal(third.locked, false);
  const fourth = await limiter.isLoginLocked('Admin', 'super_admin');
  assert.equal(fourth.locked, true);

  assert.equal(await limiter.recordLoginAttempt('Admin', 'super_admin', second.reservationId), true);
  assert.equal(await limiter.recordLoginAttempt('Admin', 'super_admin', second.reservationId), false);
  assert.equal(await limiter.recordLoginAttempt('Admin', 'super_admin', third.reservationId), true);
  assert.equal((await limiter.isLoginLocked('Admin', 'super_admin')).locked, true);
});

test('successful authentication clears failures without clearing unrelated pending reservations', async () => {
  const limiter = setup({ maxAttempts: 3 });
  const failed = await limiter.isLoginLocked('Admin', 'super_admin');
  await limiter.recordLoginAttempt('Admin', 'super_admin', failed.reservationId);

  const pending = await limiter.isLoginLocked('Admin', 'super_admin');
  const success = await limiter.isLoginLocked('Admin', 'super_admin');
  assert.equal(success.locked, false);
  assert.equal(await limiter.resetLoginAttempts('Admin', 'super_admin', success.reservationId), true);

  const third = await limiter.isLoginLocked('Admin', 'super_admin');
  assert.equal(third.locked, false);
  const fourth = await limiter.isLoginLocked('Admin', 'super_admin');
  assert.equal(fourth.locked, false);
  const fifth = await limiter.isLoginLocked('Admin', 'super_admin');
  assert.equal(fifth.locked, true);
  assert.equal(limiter.reservations.get(pending.reservationId).state, 'pending');
});

test('cancelled and expired reservations do not count as failures', async () => {
  const limiter = setup({ maxAttempts: 1 });
  const cancelled = await limiter.isLoginLocked('Admin', 'merchant_admin');
  assert.equal(await limiter.cancelLoginAttempt('Admin', 'merchant_admin', cancelled.reservationId), true);
  assert.equal((await limiter.isLoginLocked('Admin', 'merchant_admin')).locked, false);

  limiter.advance(10 * 60 * 1000 + 1);
  const current = await limiter.isLoginLocked('Admin', 'waiter');
  limiter.advance(10 * 60 * 1000 + 1);
  const replacement = await limiter.isLoginLocked('Admin', 'waiter');
  assert.equal(replacement.locked, false);
  assert.equal(limiter.reservations.get(current.reservationId).state, 'expired');
});

test('rate limits remain isolated by role and normalized username', async () => {
  const limiter = setup({ maxAttempts: 1 });
  const first = await limiter.isLoginLocked('Ａdmin', 'super_admin');
  assert.equal(first.locked, false);
  await limiter.recordLoginAttempt('admin', 'super_admin', first.reservationId);
  assert.equal((await limiter.isLoginLocked('admin', 'super_admin')).locked, true);
  assert.equal((await limiter.isLoginLocked('admin', 'merchant_admin')).locked, false);
});

test('expired failed-attempt window permits a fresh reservation', async () => {
  const limiter = setup({ maxAttempts: 1, lockMinutes: 2 });
  const first = await limiter.isLoginLocked('admin', 'waiter');
  await limiter.recordLoginAttempt('admin', 'waiter', first.reservationId);
  assert.equal((await limiter.isLoginLocked('admin', 'waiter')).locked, true);
  limiter.advance(120001);
  assert.equal((await limiter.isLoginLocked('admin', 'waiter')).locked, false);
});
