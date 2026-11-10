'use strict';

const crypto = require('crypto');

// Every admitted login has its own durable reservation. A successful request
// can clear historical failures, but can never erase another request's pending
// reservation. State transitions are conditional, so retries are idempotent.
function createLoginRateLimiter({ getAsync, runAsync, withTransaction }) {
  if (typeof getAsync !== 'function' || typeof runAsync !== 'function' || typeof withTransaction !== 'function') {
    throw new TypeError('getAsync, runAsync and withTransaction are required');
  }

  function normalizeUsername(username) {
    return String(username == null ? '' : username).normalize('NFKC').trim().toLowerCase().slice(0, 100);
  }

  function normalizeType(type) {
    const value = String(type == null ? '' : type).trim().toLowerCase();
    if (!/^[a-z_]{1,50}$/.test(value)) throw new TypeError('Invalid login type');
    return value;
  }

  async function readPolicy() {
    const [attemptSetting, lockSetting] = await Promise.all([
      getAsync("SELECT value FROM settings WHERE `key` = 'login_max_attempts'"),
      getAsync("SELECT value FROM settings WHERE `key` = 'login_lock_minutes'")
    ]);
    const parse = (value, fallback) => {
      const number = Number.parseInt(value, 10);
      return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 1440) : fallback;
    };
    return { maxAttempts: parse(attemptSetting?.value, 5), lockMinutes: parse(lockSetting?.value, 15) };
  }

  async function ensureRateRow(loginType, key, windowMinutes = 15) {
    await runAsync(
      'INSERT IGNORE INTO login_rate_limits (login_type, username, failed_attempts, window_started_at, locked_until, updated_at) VALUES (?, ?, 0, UTC_TIMESTAMP(3), NULL, UTC_TIMESTAMP(3))',
      [loginType, key]
    );
    const row = await getAsync(
      'SELECT failed_attempts, (locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP(3)) AS is_locked, ' +
      'GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), locked_until) / 60)) AS remaining, ' +
      '(window_started_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE)) AS window_expired ' +
      'FROM login_rate_limits WHERE login_type=? AND username=? FOR UPDATE',
      [windowMinutes, loginType, key]
    );
    if (!row) throw new Error('Login rate-limit row could not be locked');
    return row;
  }

  async function isLoginLocked(username, type) {
    const key = normalizeUsername(username);
    const loginType = normalizeType(type);
    if (!key) return { locked: false, maxAttempts: 5, lockMinutes: 15 };
    const { maxAttempts, lockMinutes } = await readPolicy();

    return withTransaction(async () => {
      const row = await ensureRateRow(loginType, key, lockMinutes);
      if (Number(row.is_locked) === 1) {
        return { locked: true, remaining: Math.max(1, Number(row.remaining) || lockMinutes), maxAttempts, lockMinutes };
      }

      if (Number(row.window_expired) === 1) {
        await runAsync(
          'UPDATE login_rate_limits SET failed_attempts=0, window_started_at=UTC_TIMESTAMP(3), locked_until=NULL, updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
          [loginType, key]
        );
      }

      // Abandoned requests cannot hold a slot forever. A ten-minute lease is
      // deliberately longer than normal password verification and DB work.
      await runAsync(
        "UPDATE login_rate_limit_attempts SET state='expired', updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=? AND state='pending' AND created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE)",
        [loginType, key]
      );
      await runAsync(
        "DELETE FROM login_rate_limit_attempts WHERE login_type=? AND username=? AND state <> 'pending' AND created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)",
        [loginType, key]
      );
      const counts = await getAsync(
        "SELECT COUNT(*) AS pending_count FROM login_rate_limit_attempts WHERE login_type=? AND username=? AND state='pending'",
        [loginType, key]
      );
      const failed = Number(row.window_expired) === 1 ? 0 : Math.max(0, Number(row.failed_attempts) || 0);
      if (failed + Number(counts?.pending_count || 0) >= maxAttempts) {
        await runAsync(
          'UPDATE login_rate_limits SET locked_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
          [lockMinutes, loginType, key]
        );
        return { locked: true, remaining: lockMinutes, maxAttempts, lockMinutes };
      }

      const reservationId = crypto.randomUUID();
      await runAsync(
        "INSERT INTO login_rate_limit_attempts (id, login_type, username, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        [reservationId, loginType, key]
      );
      return { locked: false, maxAttempts, lockMinutes, reservationId };
    });
  }

  async function recordLoginAttempt(username, type, reservationId) {
    const key = normalizeUsername(username);
    const loginType = normalizeType(type);
    if (!key || typeof reservationId !== 'string' || !reservationId) return false;
    const { maxAttempts, lockMinutes } = await readPolicy();
    return withTransaction(async () => {
      await ensureRateRow(loginType, key, lockMinutes);
      const changed = await runAsync(
        "UPDATE login_rate_limit_attempts SET state='failed', updated_at=UTC_TIMESTAMP(3) WHERE id=? AND login_type=? AND username=? AND state='pending'",
        [reservationId, loginType, key]
      );
      if (!changed?.affectedRows) return false;
      await runAsync(
        'UPDATE login_rate_limits SET failed_attempts=failed_attempts+1, locked_until=IF(failed_attempts+1 >= ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), locked_until), updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
        [maxAttempts, lockMinutes, loginType, key]
      );
      return true;
    });
  }

  async function resetLoginAttempts(username, type, reservationId) {
    const key = normalizeUsername(username);
    const loginType = normalizeType(type);
    if (!key || typeof reservationId !== 'string' || !reservationId) return false;
    const { lockMinutes } = await readPolicy();
    return withTransaction(async () => {
      await ensureRateRow(loginType, key, lockMinutes);
      const changed = await runAsync(
        "UPDATE login_rate_limit_attempts SET state='succeeded', updated_at=UTC_TIMESTAMP(3) WHERE id=? AND login_type=? AND username=? AND state='pending'",
        [reservationId, loginType, key]
      );
      if (!changed?.affectedRows) return false;
      await runAsync(
        'UPDATE login_rate_limits SET failed_attempts=0, window_started_at=UTC_TIMESTAMP(3), locked_until=NULL, updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
        [loginType, key]
      );
      return true;
    });
  }

  async function cancelLoginAttempt(username, type, reservationId) {
    const key = normalizeUsername(username);
    const loginType = normalizeType(type);
    if (!key || typeof reservationId !== 'string' || !reservationId) return false;
    const { lockMinutes } = await readPolicy();
    return withTransaction(async () => {
      await ensureRateRow(loginType, key, lockMinutes);
      const changed = await runAsync(
        "UPDATE login_rate_limit_attempts SET state='cancelled', updated_at=UTC_TIMESTAMP(3) WHERE id=? AND login_type=? AND username=? AND state='pending'",
        [reservationId, loginType, key]
      );
      return Boolean(changed?.affectedRows);
    });
  }

  return { isLoginLocked, recordLoginAttempt, resetLoginAttempts, cancelLoginAttempt };
}

module.exports = { createLoginRateLimiter };
