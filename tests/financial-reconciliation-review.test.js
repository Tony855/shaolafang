'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');

function memoryDb() {
  const batches = new Map([[1, { id: 1, merchant_id: 4, store_id: 9, status: 'imported' }]]);
  const items = new Map([
    [11, { id: 11, batch_id: 1, merchant_id: 4, store_id: 9, amount_minor: 1200, currency_code: 'USD', match_status: 'pending', matched_journal_transaction_id: null, match_reason: null }],
    [12, { id: 12, batch_id: 1, merchant_id: 4, store_id: 9, amount_minor: 1200, currency_code: 'USD', match_status: 'pending', matched_journal_transaction_id: null, match_reason: null }]
  ]);
  const journals = new Map([[31, { id: 31, merchant_id: 4, store_id: 9, currency_code: 'USD' }]]);
  const totals = new Map([[31, { debit_minor: 1200, credit_minor: 1200 }]]);
  const events = new Map();
  const eventList = [];
  let nextEvent = 1;
  let transactionTail = Promise.resolve();
  let executed = [];

  async function runAsync(sql, p = []) {
    executed.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    if (sql.includes('UPDATE financial_reconciliation_items')) {
      const row = items.get(p[3]);
      if (row) Object.assign(row, { match_status: p[0], matched_journal_transaction_id: p[1], match_reason: p[2] });
      return { affectedRows: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO financial_reconciliation_review_events')) {
      if (events.has(p[9])) { const e = new Error('duplicate'); e.code = 'ER_DUP_ENTRY'; throw e; }
      const event = { id: nextEvent++, merchant_id: p[0], store_id: p[1], batch_id: p[2], item_id: p[3],
        journal_transaction_id: p[4], actor_admin_id: p[5], actor_username: p[6], action: p[7],
        reason: p[8], idempotency_key: p[9], request_sha256: p[10], previous_hash: p[13], event_hash: p[14] };
      events.set(p[9], event); eventList.push(event);
      return { insertId: event.id };
    }
    throw new Error('unexpected SQL: ' + sql);
  }

  async function getAsync(sql, p = []) {
    if (sql.includes('FROM financial_reconciliation_review_events') && sql.includes('idempotency_key')) {
      return events.get(p[2]) || null;
    }
    if (sql.includes('FROM financial_reconciliation_batches')) {
      const b = batches.get(p[0]);
      return b && b.merchant_id === p[1] && b.store_id === p[2] ? b : null;
    }
    if (sql.includes('FROM financial_reconciliation_items')) {
      const row = items.get(p[0]);
      return row && row.batch_id === p[1] && row.merchant_id === p[2] && row.store_id === p[3] ? row : null;
    }
    if (sql.includes('FROM financial_journal_transactions')) {
      const row = journals.get(p[0]);
      return row && row.merchant_id === p[1] && row.store_id === p[2] ? row : null;
    }
    if (sql.includes('FROM financial_journal_entries')) return totals.get(p[0]) || null;
    if (sql.includes('SELECT id FROM financial_reconciliation_items')) {
      return [...items.values()].find(row => row.matched_journal_transaction_id === p[0] && row.id !== p[1]) || null;
    }
    if (sql.includes('SELECT event_hash')) return [...eventList].reverse().find(e => e.batch_id === p[0]) || null;
    throw new Error('unexpected get SQL: ' + sql);
  }
  async function allAsync() { return []; }
  async function withTransaction(work) {
    let release;
    const previous = transactionTail;
    transactionTail = new Promise(resolve => { release = resolve; });
    await previous;
    const snapshot = {
      items: new Map([...items].map(([k,v])=>[k,{...v}])),
      events: new Map(events), eventList: eventList.slice(), nextEvent
    };
    try { return await work(); }
    catch (error) {
      items.clear(); for (const [k,v] of snapshot.items) items.set(k,v);
      events.clear(); for (const [k,v] of snapshot.events) events.set(k,v);
      eventList.splice(0,eventList.length,...snapshot.eventList);
      nextEvent=snapshot.nextEvent;
      throw error;
    } finally { release(); }
  }
  return {
    service: createFinancialReconciliationReviewService({ runAsync, getAsync, allAsync, withTransaction }),
    items, events, eventList, executed
  };
}

const input = (overrides = {}) => ({
  merchantId: 4, storeId: 9, batchId: 1, itemId: 11, actorId: 6, actorUsername: 'finance',
  action: 'confirm', journalTransactionId: 31, reason: 'Verified against bank advice',
  idempotencyKey: 'finance-review-0001', ...overrides
});

test('confirms an exact tenant-scoped journal candidate and appends an audit hash', async () => {
  const db = memoryDb();
  const result = await db.service.reviewItem(input());
  assert.equal(result.replayed, false);
  assert.equal(db.items.get(11).match_status, 'matched');
  assert.equal(db.items.get(11).matched_journal_transaction_id, 31);
  assert.equal(db.eventList.length, 1);
  assert.equal(db.eventList[0].previous_hash, '');
  assert.match(db.eventList[0].event_hash, /^[a-f0-9]{64}$/);
});

test('rejects cross-tenant batch, item, and journal access', async () => {
  const db = memoryDb();
  await assert.rejects(db.service.reviewItem(input({ merchantId: 5 })), e => e.code === 'REVIEW_NOT_FOUND');
  await assert.rejects(db.service.reviewItem(input({ itemId: 99 })), e => e.code === 'REVIEW_NOT_FOUND');
  await assert.rejects(db.service.reviewItem(input({ journalTransactionId: 99 })), e => e.code === 'REVIEW_JOURNAL_NOT_FOUND');
  assert.equal(db.eventList.length, 0);
});

test('rejects a journal transaction already assigned to another statement row', async () => {
  const db = memoryDb();
  await db.service.reviewItem(input());
  await assert.rejects(db.service.reviewItem(input({
    itemId: 12, idempotencyKey: 'finance-review-0002'
  })), e => e.code === 'REVIEW_DUPLICATE_ASSIGNMENT');
  assert.equal(db.items.get(12).match_status, 'pending');
});

test('same idempotency request replays and changed request is rejected', async () => {
  const db = memoryDb();
  const first = await db.service.reviewItem(input());
  const replay = await db.service.reviewItem(input());
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, first.eventId);
  await assert.rejects(db.service.reviewItem(input({ reason: 'Different review reason', idempotencyKey: input().idempotencyKey })),
    e => e.code === 'REVIEW_IDEMPOTENCY_CONFLICT');
});

test('releases a match and appends a second hash-linked audit event', async () => {
  const db = memoryDb();
  await db.service.reviewItem(input());
  const released = await db.service.reviewItem(input({
    action: 'release', journalTransactionId: undefined, idempotencyKey: 'finance-review-0003',
    reason: 'Releasing incorrect assignment'
  }));
  assert.equal(db.items.get(11).match_status, 'pending');
  assert.equal(db.items.get(11).matched_journal_transaction_id, null);
  assert.equal(db.eventList.length, 2);
  assert.equal(db.eventList[1].previous_hash, db.eventList[0].event_hash);
  assert.equal(released.action, 'release');
});

test('failed review rolls back item state and does not create an audit row', async () => {
  const db = memoryDb();
  await assert.rejects(db.service.reviewItem(input({ journalTransactionId: 31, itemId: 99 })));
  assert.equal(db.eventList.length, 0);
  assert.equal(db.items.get(11).match_status, 'pending');
});

test('concurrent assignment of one journal transaction is serialized and only one succeeds', async () => {
  const db = memoryDb();
  const results = await Promise.allSettled([
    db.service.reviewItem(input({ itemId: 11, idempotencyKey: 'finance-review-0004' })),
    db.service.reviewItem(input({ itemId: 12, idempotencyKey: 'finance-review-0005' }))
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal([...db.items.values()].filter(row => row.match_status === 'matched').length, 1);
});

test('rejects malformed actions, reasons, and idempotency keys', async () => {
  const db = memoryDb();
  await assert.rejects(db.service.reviewItem(input({ action: 'auto_pay' })), e => e.code === 'REVIEW_ACTION_INVALID');
  await assert.rejects(db.service.reviewItem(input({ reason: 'no' })), e => e.code === 'REVIEW_REASON_INVALID');
  await assert.rejects(db.service.reviewItem(input({ idempotencyKey: 'short' })), e => e.code === 'REVIEW_IDEMPOTENCY_INVALID');
});

test('review event writes are append-only at service boundary', async () => {
  const db = memoryDb();
  await db.service.reviewItem(input());
  assert.deepEqual(db.executed.filter(sql => /^(UPDATE|DELETE) financial_reconciliation_review_events/i.test(sql)), []);
  assert.equal(db.executed.filter(sql => /^INSERT INTO financial_reconciliation_review_events/i.test(sql)).length, 1);
});
