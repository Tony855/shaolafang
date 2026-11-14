'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderEventQueue } = require('../server/services/provider-event-queue');

function memoryQueue(rows, options = {}) {
  const calls = [];
  let transactionCount = 0;
  async function getAsync(sql, params = []) {
    calls.push({ type: 'get', sql, params });
    if (sql.includes('LIMIT 1 FOR UPDATE')) {
      const row = rows.find(item => item.auth_status === 'verified' &&
        item.normalized_event_json && item.attempt_count < item.max_attempts &&
        (item.processing_status === 'received' || item.processing_status === 'processing'));
      return row ? { ...row } : null;
    }
    if (sql.includes('SELECT attempt_count, max_attempts')) {
      if (options.expireBeforeFailureUpdate) {
        options.expireBeforeFailureUpdate = false;
        options.expireAfterLock = true;
      }
      const row = rows.find(item => item.id === params[0] &&
        item.processing_status === 'processing' && item.lease_token === params[1] && item.lease_expired !== true);
      return row ? { attempt_count: row.attempt_count, max_attempts: row.max_attempts } : null;
    }
    throw new Error('unexpected query');
  }
  async function runAsync(sql, params = []) {
    calls.push({ type: 'run', sql, params });
    if (sql.includes("SET processing_status='failed', lease_token=NULL")) {
      let affectedRows = 0;
      for (const row of rows) {
        if (row.auth_status === 'verified' && row.processing_status === 'processing' &&
            row.lease_expired === true && row.attempt_count >= row.max_attempts) {
          row.processing_status = 'failed'; row.lease_token = null;
          row.lease_expires_at = null; row.last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS';
          affectedRows += 1;
        }
      }
      return { affectedRows };
    }
    if (sql.includes("SET processing_status='processing'")) {
      const row = rows.find(item => item.id === params[2]);
      if (!row) return { affectedRows: 0 };
      row.processing_status = 'processing'; row.attempt_count += 1;
      row.lease_token = params[0]; return { affectedRows: 1 };
    }
    if (sql.includes('SET lease_expires_at=DATE_ADD')) {
      const row = rows.find(item => item.id === params[1] &&
        item.processing_status === 'processing' && item.lease_token === params[2] &&
        item.lease_expired !== true);
      if (!row) return { affectedRows: 0 };
      row.lease_seconds = params[0];
      return { affectedRows: 1 };
    }
    if (sql.includes("SET processing_status='processed'")) {
      const row = rows.find(item => item.id === params[0] && item.lease_token === params[1] && item.lease_expired !== true);
      if (!row) return { affectedRows: 0 };
      row.processing_status = 'processed'; row.lease_token = null; return { affectedRows: 1 };
    }
    if (sql.includes('SET processing_status=?')) {
      if (options.expireAfterLock) {
        options.expireAfterLock = false;
        const row = rows.find(item => item.id === params[3]);
        if (row) row.lease_expired = true;
      }
      const row = rows.find(item => item.id === params[3] && item.lease_token === params[4] && item.lease_expired !== true);
      if (!row) return { affectedRows: 0 };
      row.processing_status = params[0]; row.lease_token = null; row.last_error_code = params[2];
      return { affectedRows: 1 };
    }
    throw new Error('unexpected update');
  }
  return { queue: createProviderEventQueue({
    getAsync, runAsync, withTransaction: async work => { transactionCount += 1; return work(); },
    tokenFactory: () => 'a'.repeat(64)
  }), rows, calls, get transactionCount() { return transactionCount; } };
}

test('claimNext leases a verified event with normalized payload and increments attempts', async () => {
  const db = memoryQueue([{
    id: 4, provider_code: 'ABA_PAYWAY', provider_event_id: 'evt-4',
    merchant_id: 2, store_id: 7, event_type: 'payment.completed',
    provider_transaction_id: 'txn-4', normalized_event_json: '{"orderReference":"O-4"}',
    attempt_count: 0, max_attempts: 8, auth_status: 'verified', processing_status: 'received'
  }]);
  const claimed = await db.queue.claimNext({ leaseSeconds: 45 });
  assert.equal(claimed.id, 4);
  assert.equal(claimed.attemptCount, 1);
  assert.deepEqual(claimed.normalizedEvent, { orderReference: 'O-4' });
  assert.equal(db.rows[0].lease_token, 'a'.repeat(64));
  assert.equal(db.transactionCount, 1);
});

test('claimNext validates lease duration and ignores events without normalized data', async () => {
  const db = memoryQueue([]);
  await assert.rejects(db.queue.claimNext({ leaseSeconds: 1 }), /leaseSeconds/);
  assert.equal(await db.queue.claimNext(), null);
});

test('complete requires the active lease token and marks the event processed', async () => {
  const db = memoryQueue([{ id: 8, processing_status: 'processing', lease_token: 'a'.repeat(64), lease_expired: false }]);
  assert.deepEqual(await db.queue.complete({ eventId: 8, leaseToken: 'a'.repeat(64) }), { completed: true });
  assert.equal(db.rows[0].processing_status, 'processed');
  await assert.rejects(db.queue.complete({ eventId: 8, leaseToken: 'b'.repeat(64) }),
    error => error.code === 'PROVIDER_EVENT_STALE_LEASE');
});

test('fail schedules retry before the attempt limit and terminally fails at the limit inside a transaction', async () => {
  const retry = memoryQueue([{ id: 1, processing_status: 'processing', lease_token: 'a'.repeat(64), lease_expired: false, attempt_count: 1, max_attempts: 3 }]);
  assert.deepEqual(await retry.queue.fail({ eventId: 1, leaseToken: 'a'.repeat(64), errorCode: 'TEMPORARY' }),
    { retryScheduled: true, terminal: false });
  assert.equal(retry.rows[0].processing_status, 'received');
  assert.equal(retry.transactionCount, 1);
  const lockedRead = retry.calls.findIndex(call => call.type === 'get' && call.sql.includes('FOR UPDATE'));
  const transition = retry.calls.findIndex(call => call.type === 'run' && call.sql.includes('SET processing_status=?'));
  assert.ok(lockedRead >= 0 && transition > lockedRead,
    'the locked read must precede the state transition within the same transaction');

  const terminal = memoryQueue([{ id: 2, processing_status: 'processing', lease_token: 'a'.repeat(64), lease_expired: false, attempt_count: 3, max_attempts: 3 }]);
  assert.deepEqual(await terminal.queue.fail({ eventId: 2, leaseToken: 'a'.repeat(64), errorCode: 'INVALID_STATE' }),
    { retryScheduled: false, terminal: true });
  assert.equal(terminal.rows[0].processing_status, 'failed');
  assert.equal(terminal.transactionCount, 1);
});

test('claimNext retires an expired final-attempt lease instead of stranding it forever', async () => {
  const db = memoryQueue([{
    id: 19, auth_status: 'verified', processing_status: 'processing',
    lease_token: 'c'.repeat(64), lease_expired: true,
    attempt_count: 3, max_attempts: 3
  }]);
  assert.equal(await db.queue.claimNext(), null);
  assert.equal(db.rows[0].processing_status, 'failed');
  assert.equal(db.rows[0].lease_token, null);
  assert.equal(db.rows[0].last_error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS');
  const cleanup = db.calls.findIndex(call => call.type === 'run' &&
    call.sql.includes("SET processing_status='failed', lease_token=NULL"));
  const claim = db.calls.findIndex(call => call.type === 'get' && call.sql.includes('LIMIT 1 FOR UPDATE'));
  assert.ok(cleanup >= 0 && claim > cleanup, 'expired final leases must be retired before selecting work');
  assert.equal(db.transactionCount, 1);
});


test('complete rejects an expired lease even when no other worker has reclaimed it yet', async () => {
  const db = memoryQueue([{
    id: 29, processing_status: 'processing', lease_token: 'd'.repeat(64), lease_expired: true
  }]);
  await assert.rejects(
    db.queue.complete({ eventId: 29, leaseToken: 'd'.repeat(64) }),
    error => error.code === 'PROVIDER_EVENT_STALE_LEASE'
  );
  assert.equal(db.rows[0].processing_status, 'processing');
});

test('fail rejects an expired lease instead of changing retry state after ownership expired', async () => {
  const db = memoryQueue([{
    id: 30, processing_status: 'processing', lease_token: 'e'.repeat(64),
    lease_expired: true, attempt_count: 1, max_attempts: 3
  }]);
  await assert.rejects(
    db.queue.fail({ eventId: 30, leaseToken: 'e'.repeat(64), errorCode: 'LATE_FAILURE' }),
    error => error.code === 'PROVIDER_EVENT_STALE_LEASE'
  );
  assert.equal(db.rows[0].processing_status, 'processing');
  assert.equal(db.transactionCount, 1);
});


test('fail rechecks lease expiry at the state update after acquiring the row lock', async () => {
  const db = memoryQueue([{
    id: 31, processing_status: 'processing', lease_token: 'f'.repeat(64),
    lease_expired: false, attempt_count: 1, max_attempts: 3
  }], { expireBeforeFailureUpdate: true });
  await assert.rejects(
    db.queue.fail({ eventId: 31, leaseToken: 'f'.repeat(64), errorCode: 'LEASE_RACE' }),
    error => error.code === 'PROVIDER_EVENT_STALE_LEASE'
  );
  assert.equal(db.rows[0].processing_status, 'processing');
  assert.equal(db.rows[0].lease_token, 'f'.repeat(64));
  assert.equal(db.transactionCount, 1);
});


test('renew extends only an active lease and rejects expired ownership', async () => {
  const active = memoryQueue([{
    id: 41, processing_status: 'processing', lease_token: '1'.repeat(64), lease_expired: false
  }]);
  assert.deepEqual(await active.queue.renew({
    eventId: 41, leaseToken: '1'.repeat(64), leaseSeconds: 120
  }), { renewed: true });
  assert.equal(active.rows[0].lease_seconds, 120);
  await assert.rejects(active.queue.renew({
    eventId: 41, leaseToken: '1'.repeat(64), leaseSeconds: 901
  }), /leaseSeconds/);

  const expired = memoryQueue([{
    id: 42, processing_status: 'processing', lease_token: '2'.repeat(64), lease_expired: true
  }]);
  await assert.rejects(
    expired.queue.renew({ eventId: 42, leaseToken: '2'.repeat(64), leaseSeconds: 120 }),
    error => error.code === 'PROVIDER_EVENT_STALE_LEASE'
  );
});
