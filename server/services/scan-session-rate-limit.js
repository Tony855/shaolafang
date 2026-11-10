'use strict';

const crypto = require('crypto');

const RATE_LIMIT = 60;
const WINDOW_SECONDS = 60;

function hashClientIp(ip) {
  const normalized = typeof ip === 'string' && ip.trim() ? ip.trim().toLowerCase() : 'unknown';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function createScanSessionRateLimiter({ getAsync, runAsync, withTransaction }) {
  if (typeof getAsync !== 'function' || typeof runAsync !== 'function' || typeof withTransaction !== 'function') {
    throw new TypeError('getAsync, runAsync and withTransaction are required');
  }

  async function consume(ip) {
    const ipHash = hashClientIp(ip);
    try {
      return await withTransaction(async () => {
        // The upsert takes a row lock and increments the fixed-window counter
        // atomically. Reading it in the same transaction prevents concurrent
        // requests from bypassing the limit on separate application instances.
        await runAsync(
          'INSERT INTO scan_session_rate_limits (ip_hash, window_started_at, request_count, updated_at) ' +
          'VALUES (?, UTC_TIMESTAMP(3), 1, UTC_TIMESTAMP(3)) ' +
          'ON DUPLICATE KEY UPDATE ' +
          'request_count=IF(window_started_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND), 1, request_count + 1), ' +
          'window_started_at=IF(window_started_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND), UTC_TIMESTAMP(3), window_started_at), ' +
          'updated_at=UTC_TIMESTAMP(3)',
          [ipHash]
        );
        const row = await getAsync(
          'SELECT request_count, GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), ' +
          'DATE_ADD(window_started_at, INTERVAL 60 SECOND)))) AS retry_after ' +
          'FROM scan_session_rate_limits WHERE ip_hash=? FOR UPDATE',
          [ipHash]
        );
        const count = Number(row?.request_count);
        if (!row || !Number.isSafeInteger(count) || count < 1) {
          throw new Error('Scan-session rate-limit counter is unavailable');
        }
        if (count <= RATE_LIMIT) return 0;
        return Math.max(1, Math.min(WINDOW_SECONDS, Number(row.retry_after) || WINDOW_SECONDS));
      });
    } catch (_) {
      const error = new Error('Scan-session rate-limit storage is unavailable');
      error.status = 503;
      error.code = 'SCAN_RATE_LIMIT_UNAVAILABLE';
      throw error;
    }
  }

  async function cleanup() {
    await runAsync(
      'DELETE FROM scan_session_rate_limits WHERE window_started_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY)'
    );
  }

  return { consume, cleanup };
}

module.exports = { createScanSessionRateLimiter, hashClientIp };
