'use strict';

// Database-backed login throttling. The composite InnoDB row lock serializes
// attempts for the same normalized account across workers and application nodes.
function createLoginRateLimiter({ getAsync, runAsync, withTransaction }) {
  if (typeof getAsync !== 'function' || typeof runAsync !== 'function' || typeof withTransaction !== 'function') {
    throw new TypeError('getAsync, runAsync and withTransaction are required');
  }

  function normalizeUsername(username) {
    return String(username == null ? '' : username)
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .slice(0, 100);
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
    return {
      maxAttempts: parse(attemptSetting?.value, 5),
      lockMinutes: parse(lockSetting?.value, 15)
    };
  }

  async function isLoginLocked(username, type) {
    const key = normalizeUsername(username);
    const loginType = normalizeType(type);
    if (!key) return { locked: false, maxAttempts: 5, lockMinutes: 15 };
    const { maxAttempts, lockMinutes } = await readPolicy();

    return withTransaction(async () => {
      await runAsync(
        'INSERT IGNORE INTO login_rate_limits (login_type, username, failed_attempts, window_started_at, locked_until, updated_at) VALUES (?, ?, 0, UTC_TIMESTAMP(3), NULL, UTC_TIMESTAMP(3))',
        [loginType, key]
      );
      const row = await getAsync(
        'SELECT failed_attempts, ' +
        '(locked_until IS NOT NULL AND locked_until > UTC_TIMESTAMP(3)) AS is_locked, ' +
        'GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), locked_until) / 60)) AS remaining, ' +
        '(window_started_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? MINUTE)) AS window_expired ' +
        'FROM login_rate_limits WHERE login_type=? AND username=? FOR UPDATE',
        [lockMinutes, loginType, key]
      );
      if (!row) throw new Error('Login rate-limit row could not be locked');

      if (Number(row.is_locked) === 1) {
        return {
          locked: true,
          remaining: Math.max(1, Number(row.remaining) || lockMinutes),
          maxAttempts,
          lockMinutes
        };
      }

      const expired = Number(row.window_expired) === 1;
      const currentAttempts = expired ? 0 : Math.max(0, Number(row.failed_attempts) || 0);
      if (currentAttempts >= maxAttempts) {
        await runAsync(
          'UPDATE login_rate_limits SET locked_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
          [lockMinutes, loginType, key]
        );
        return { locked: true, remaining: lockMinutes, maxAttempts, lockMinutes };
      }

      const nextAttempts = currentAttempts + 1;
      if (expired) {
        await runAsync(
          'UPDATE login_rate_limits SET failed_attempts=?, window_started_at=UTC_TIMESTAMP(3), locked_until=IF(? >= ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), NULL), updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
          [nextAttempts, nextAttempts, maxAttempts, lockMinutes, loginType, key]
        );
      } else {
        await runAsync(
          'UPDATE login_rate_limits SET failed_attempts=?, locked_until=IF(? >= ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE), NULL), updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
          [nextAttempts, nextAttempts, maxAttempts, lockMinutes, loginType, key]
        );
      }
      // The current request is allowed; once its failure is recorded, the
      // pre-set lock blocks every subsequent concurrent request immediately.
      return { locked: false, maxAttempts, lockMinutes };
    });
  }

  async function resetLoginAttempts(username, type) {
    const key = normalizeUsername(username);
    const loginType = normalizeType(type);
    if (!key) return;
    await withTransaction(async () => {
      await runAsync(
        'UPDATE login_rate_limits SET failed_attempts=0, window_started_at=UTC_TIMESTAMP(3), locked_until=NULL, updated_at=UTC_TIMESTAMP(3) WHERE login_type=? AND username=?',
        [loginType, key]
      );
    });
  }

  return { isLoginLocked, resetLoginAttempts };
}

module.exports = { createLoginRateLimiter };
