'use strict';

const crypto = require('crypto');

function parseNormalizedEvent(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('stored normalized provider event is invalid');
  }
  return parsed;
}

function createProviderEventQueue({ getAsync, runAsync, withTransaction, now = () => new Date(), tokenFactory = () => crypto.randomBytes(32).toString('hex') }) {
  for (const [name, fn] of Object.entries({ getAsync, runAsync, withTransaction, now, tokenFactory })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' dependency is required');
  }

  async function claimNext({ leaseSeconds = 60 } = {}) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 900) {
      throw new TypeError('leaseSeconds must be an integer between 5 and 900');
    }
    return withTransaction(async () => {
      // A worker may crash after claiming its final permitted attempt. Such a
      // row is no longer eligible for another claim, so retire its expired
      // lease explicitly instead of leaving it stranded in "processing".
      await runAsync(
        `UPDATE provider_webhook_events
         SET processing_status='failed', lease_token=NULL, lease_expires_at=NULL,
             last_error_code='LEASE_EXPIRED_MAX_ATTEMPTS'
         WHERE auth_status='verified' AND processing_status='processing'
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= NOW(3)
           AND attempt_count >= max_attempts`
      );
      const row = await getAsync(
        `SELECT id, provider_code, provider_event_id, merchant_id, store_id,
                event_type, provider_transaction_id, normalized_event_json,
                attempt_count, max_attempts
         FROM provider_webhook_events
         WHERE auth_status='verified'
           AND normalized_event_json IS NOT NULL
           AND attempt_count < max_attempts
           AND ((processing_status='received' AND next_attempt_at <= NOW(3))
             OR (processing_status='processing' AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= NOW(3)))
         ORDER BY received_at ASC, id ASC
         LIMIT 1 FOR UPDATE`
      );
      if (!row) return null;
      const leaseToken = tokenFactory();
      if (!/^[a-f0-9]{64}$/i.test(leaseToken)) throw new TypeError('tokenFactory must return 64 hex characters');
      const result = await runAsync(
        `UPDATE provider_webhook_events
         SET processing_status='processing', attempt_count=attempt_count+1,
             lease_token=?, lease_expires_at=DATE_ADD(NOW(3), INTERVAL ? SECOND)
         WHERE id=? AND auth_status='verified'`,
        [leaseToken, leaseSeconds, row.id]
      );
      if (result.affectedRows !== undefined && Number(result.affectedRows) !== 1) {
        const error = new Error('provider event lease could not be acquired');
        error.code = 'PROVIDER_EVENT_LEASE_CONFLICT';
        throw error;
      }
      return Object.freeze({
        id: Number(row.id),
        providerCode: row.provider_code,
        providerEventId: row.provider_event_id,
        merchantId: Number(row.merchant_id),
        storeId: Number(row.store_id),
        eventType: row.event_type,
        providerTransactionId: row.provider_transaction_id,
        attemptCount: Number(row.attempt_count) + 1,
        maxAttempts: Number(row.max_attempts),
        leaseToken,
        normalizedEvent: parseNormalizedEvent(row.normalized_event_json)
      });
    });
  }

  async function complete({ eventId, leaseToken }) {
    if (!Number.isSafeInteger(Number(eventId)) || Number(eventId) <= 0 ||
        !/^[a-f0-9]{64}$/i.test(String(leaseToken || ''))) {
      throw new TypeError('eventId and leaseToken are required');
    }
    const result = await runAsync(
      `UPDATE provider_webhook_events
       SET processing_status='processed', processed_at=NOW(3),
           lease_token=NULL, lease_expires_at=NULL, last_error_code=NULL
       WHERE id=? AND processing_status='processing' AND lease_token=?`,
      [Number(eventId), leaseToken]
    );
    if (Number(result.affectedRows) !== 1) {
      const error = new Error('provider event lease is stale or no longer owned');
      error.code = 'PROVIDER_EVENT_STALE_LEASE';
      throw error;
    }
    return { completed: true };
  }

  async function fail({ eventId, leaseToken, errorCode, retryDelaySeconds }) {
    if (!Number.isSafeInteger(Number(eventId)) || Number(eventId) <= 0 ||
        !/^[a-f0-9]{64}$/i.test(String(leaseToken || ''))) {
      throw new TypeError('eventId and leaseToken are required');
    }
    const safeCode = String(errorCode || 'PROCESSING_ERROR').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'PROCESSING_ERROR';
    const delay = retryDelaySeconds === undefined ? 30 : retryDelaySeconds;
    if (!Number.isInteger(delay) || delay < 1 || delay > 86400) {
      throw new TypeError('retryDelaySeconds must be between 1 and 86400');
    }

    // The row lock must remain held until the retry/terminal transition commits.
    // Without this transaction boundary, SELECT ... FOR UPDATE may release its
    // lock immediately (or provide no protection when autocommit is enabled).
    return withTransaction(async () => {
      const row = await getAsync(
        `SELECT attempt_count, max_attempts FROM provider_webhook_events
         WHERE id=? AND processing_status='processing' AND lease_token=? FOR UPDATE`,
        [Number(eventId), leaseToken]
      );
      if (!row) {
        const error = new Error('provider event lease is stale or no longer owned');
        error.code = 'PROVIDER_EVENT_STALE_LEASE';
        throw error;
      }
      const terminal = Number(row.attempt_count) >= Number(row.max_attempts);
      const result = await runAsync(
        `UPDATE provider_webhook_events
         SET processing_status=?, next_attempt_at=DATE_ADD(NOW(3), INTERVAL ? SECOND),
             lease_token=NULL, lease_expires_at=NULL, last_error_code=?
         WHERE id=? AND processing_status='processing' AND lease_token=?`,
        [terminal ? 'failed' : 'received', delay, safeCode, Number(eventId), leaseToken]
      );
      if (Number(result.affectedRows) !== 1) {
        const error = new Error('provider event lease changed during failure handling');
        error.code = 'PROVIDER_EVENT_STALE_LEASE';
        throw error;
      }
      return { retryScheduled: !terminal, terminal };
    });
  }

  return Object.freeze({ claimNext, complete, fail });
}

module.exports = { createProviderEventQueue };
