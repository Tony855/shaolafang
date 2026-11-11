'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderEventQueue } = require('../server/services/provider-event-queue');

function memoryQueue(rows) {
  const calls = [];
  async function getAsync(sql, params = []) {
    calls.push({ type: 'get', sql, params });
    if (sql.includes('LIMIT 1 FOR UPDATE')) {
      return rows.find(row => row.auth_status === 'verified' &&
        row.normalized_event_json && row.attempt_count < row.max_attempts &&
        (row.processing_status === 'received' || row.processing_status === 'processing'));
      return row ? { ...row } : null;
    }
    if (sql.includes('SELECT attempt_count, max_attempts')) {
      const row = rows.find(item => item.id === params[0] &&
        item.processing_status === 'processing' && item.lease_token === params[1]);
      return row ? { attempt_count: row.attempt_count, max_attempts: row.max_attempts } : null;
    }
    throw new Error('unexpected query');
  }
  async function runAsync(sql, params = []) {
    calls.push({ type: 'run', sql, params });
    if (sql.includes('SET processing_status=\'processing\'')) {
      const row = rows.find(item => item.id === params[2]);
      if (!row) return { affectedRows: 0 };
      row.processing_status = 'processing'; row.attempt_count += 1;
      row.lease_token = params[0]; return { affectedRows: 1 };
    }
    if (sql.includes("SET processing_status='processed'")) {
      const row = rows.find(item => item.id === params[0] && item.lease_token === params[1]);
      if (!row) return { affectedRows: 0 };
      row.processing_status = 'processed'; row.lease_token = null; return { affectedRows: 1 };
    }
    if (sql.includes('SET processing_status=?')) {
      const row = rows.find(item => item.id === params[3] && item.lease_token === params[4]);
      if (!row) return { affectedRows: 0 };
      row.processing_status = params[0]; row.lease_token = null; row.last_error_code = params[2];
      return { affectedRows: 1 };
    }
    throw new Error('unexpected update');
  }
  return { queue: createProviderEventQueue({
    getAsync, runAsync, withTransaction: work => work(),
    tokenFactory: () => 'a'.repeat(64)
  }), rows, calls };
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
});

test('claimNext validates lease duration and ignores events without normalized data', async () => {
  const db = memoryQueue([]);
  await assert.rejects(db.queue.claimNext({ leaseSeconds: 1 }), /leaseSeconds/);
  assert.equal(await db.queue.claimNext(), null);
});

test('complete requires the active lease token and marks the event processed', async () => {
  const db = memoryQueue([{ id: 8, processing_status: 'processing', lease_token: 'a'.repeat(64) }]);
  assert.deepEqual(await db.queue.complete({ eventId: 8, leaseToken: 'a'.repeat(64) }), { completed: true });
  assert.equal(db.rows[0].processing_status, 'processed');
  await assert.rejects(db.queue.complete({ eventId: 8, leaseToken: 'b'.repeat(64) }),
    error => error.code === 'PROVIDER_EVENT_STALE_LEASE');
});

test('fail schedules retry before the attempt limit and terminally fails at the limit', async () => {
  const retry = memoryQueue([{ id: 1, processing_status: 'processing', lease_token: 'a'.repeat(64), attempt_count: 1, max_attempts: 3 }]);
  assert.deepEqual(await retry.queue.fail({ eventId: 1, leaseToken: 'a'.repeat(64), errorCode: 'TEMPORARY' }),
    { retryScheduled: true, terminal: false });
  assert.equal(retry.rows[0].processing_status, 'received');
  const terminal = memoryQueue([{ id: 2, processing_status: 'processing', lease_token: 'a'.repeat(64), attempt_count: 3, max_attempts: 3 }]);
  assert.deepEqual(await terminal.queue.fail({ eventId: 2, leaseToken: 'a'.repeat(64), errorCode: 'INVALID_STATE' }),
    { retryScheduled: false, terminal: true });
  assert.equal(terminal.rows[0].processing_status, 'failed');
});
