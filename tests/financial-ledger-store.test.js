'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinancialLedgerService } = require('../server/services/financial-ledger-store');

function createMemoryDb() {
  const events = new Map();
  const journals = new Map();
  const entries = new Map();
  let nextEventId = 1;
  let nextJournalId = 1;

  async function runAsync(sql, p = []) {
    if (sql.includes('INSERT INTO provider_webhook_events')) {
      const key = p[0] + ':' + p[1];
      if (!events.has(key)) events.set(key, {
        id: nextEventId++, provider_code: p[0], provider_event_id: p[1],
        merchant_id: p[2], store_id: p[3], event_type: p[4],
        provider_transaction_id: p[5], payload_sha256: p[6], normalized_event_json: p[7],
        auth_status: 'verified', processing_status: 'received'
      });
      return { insertId: events.get(key).id };
    }
    if (sql.includes("UPDATE provider_webhook_events SET auth_status='verified'")) {
      const row = [...events.values()].find(item => item.id === p[0]);
      if (row) row.auth_status = 'verified';
      return { changes: row ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO financial_journal_transactions')) {
      const key = p[0] + ':' + p[1] + ':' + p[5];
      if (!journals.has(key)) journals.set(key, {
        id: nextJournalId++, merchant_id: p[0], store_id: p[1],
        currency_code: p[2], source_type: p[3], source_id: p[4],
        idempotency_key: p[5], description: p[6], created_by: p[7]
      });
      return { insertId: journals.get(key).id };
    }
    if (sql.includes('INSERT INTO financial_journal_entries')) {
      const row = { transaction_id: p[0], merchant_id: p[1], store_id: p[2],
        line_no: p[3], account_code: p[4], direction: p[5], amount_minor: p[6], memo: p[7] };
      const list = entries.get(p[0]) || [];
      list.push(row);
      entries.set(p[0], list);
      return { insertId: list.length };
    }
    throw new Error('unexpected SQL: ' + sql);
  }

  async function getAsync(sql, p = []) {
    if (sql.includes('FROM provider_webhook_events')) {
      return [...events.values()].find(row => row.provider_code === p[0] && row.provider_event_id === p[1]) || null;
    }
    if (sql.includes('FROM financial_journal_transactions')) {
      return [...journals.values()].find(row => row.merchant_id === p[0] &&
        row.store_id === p[1] && row.idempotency_key === p[2]) || null;
    }
    throw new Error('unexpected get SQL: ' + sql);
  }

  async function allAsync(sql, p = []) {
    if (sql.includes('FROM financial_journal_entries')) return entries.get(p[0]) || [];
    throw new Error('unexpected all SQL: ' + sql);
  }

  async function withTransaction(work) { return work(); }
  return { service: createFinancialLedgerService({ runAsync, getAsync, allAsync, withTransaction }), events, journals, entries };
}

test('provider event inbox requires adapter verification before durable intake', async () => {
  const db = createMemoryDb();
  const envelope = {
    providerCode: 'ABA_PAYWAY', providerEventId: 'event-100',
    merchantId: 2, storeId: 5, rawBody: Buffer.from('raw event')
  };
  const normalizedEvent = { orderReference: 'order-100', amountMinor: 1250, currencyCode: 'USD', paymentStatus: 'paid' };
  const input = { envelope, normalizedEvent, verification: { verified: true, providerCode: 'ABA_PAYWAY' } };
  await assert.rejects(
    db.service.recordVerifiedProviderEvent({ ...input, verification: { verified: false, providerCode: 'ABA_PAYWAY' } }),
    error => error.code === 'PROVIDER_EVENT_NOT_VERIFIED'
  );
  assert.equal(db.events.size, 0);
  const result = await db.service.recordVerifiedProviderEvent(input);
  assert.equal(result.eventId, 1);
  assert.equal(db.events.size, 1);
});

test('provider event duplicate is idempotent and changed payload is rejected', async () => {
  const db = createMemoryDb();
  const verification = { verified: true, providerCode: 'BAKONG' };
  const envelope = { providerCode: 'BAKONG', providerEventId: 'event-200',
    merchantId: 3, storeId: 8, rawBody: 'same body' };
  const normalizedEvent = { orderReference: 'order-200', amountMinor: 990, currencyCode: 'KHR', paymentStatus: 'paid' };
  const first = await db.service.recordVerifiedProviderEvent({ envelope, verification, normalizedEvent });
  const second = await db.service.recordVerifiedProviderEvent({ envelope, verification, normalizedEvent });
  assert.equal(first.eventId, second.eventId);
  assert.equal(db.events.size, 1);
  await assert.rejects(db.service.recordVerifiedProviderEvent({
    envelope: { ...envelope, rawBody: 'tampered body' }, verification, normalizedEvent
  }), error => error.code === 'PROVIDER_EVENT_ID_COLLISION');
});

test('journal posting is balanced, durable, and idempotent on exact replay', async () => {
  const db = createMemoryDb();
  const draft = {
    merchantId: 4, storeId: 10, currencyCode: 'USD',
    sourceType: 'order_payment', sourceId: 'order-77',
    idempotencyKey: 'order-payment:000077', description: 'Order payment',
    entries: [
      { accountCode: 'payment_clearing', direction: 'debit', amountMinor: 2500 },
      { accountCode: 'sales_revenue', direction: 'credit', amountMinor: 2500 }
    ]
  };
  const first = await db.service.postJournalTransaction(draft);
  const replay = await db.service.postJournalTransaction(draft);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.transactionId, replay.transactionId);
  assert.equal(db.entries.get(first.transactionId).length, 2);
});

test('journal posting rejects idempotency-key reuse with different accounting lines', async () => {
  const db = createMemoryDb();
  const draft = {
    merchantId: 1, storeId: 1, currencyCode: 'KHR',
    sourceType: 'refund', sourceId: 'refund-9',
    idempotencyKey: 'refund-post:000009',
    entries: [
      { accountCode: 'refund_liability', direction: 'debit', amountMinor: 900 },
      { accountCode: 'cash_clearing', direction: 'credit', amountMinor: 900 }
    ]
  };
  await db.service.postJournalTransaction(draft);
  await assert.rejects(db.service.postJournalTransaction({
    ...draft,
    entries: [
      { accountCode: 'refund_liability', direction: 'debit', amountMinor: 800 },
      { accountCode: 'cash_clearing', direction: 'credit', amountMinor: 800 }
    ]
  }), error => error.code === 'JOURNAL_IDEMPOTENCY_CONFLICT');
});


test('journal idempotent replay rejects unsafe persisted entry minor-unit values', async () => {
  const db = createMemoryDb();
  const draft = {
    merchantId: 4, storeId: 10, currencyCode: 'USD',
    sourceType: 'order_payment', sourceId: 'order-precision-1',
    idempotencyKey: 'order-payment:precision-0001',
    entries: [
      { accountCode: 'payment_clearing', direction: 'debit', amountMinor: 2500 },
      { accountCode: 'sales_revenue', direction: 'credit', amountMinor: 2500 }
    ]
  };
  const first = await db.service.postJournalTransaction(draft);
  db.entries.get(first.transactionId)[0].amount_minor = '9007199254740992';
  await assert.rejects(
    db.service.postJournalTransaction(draft),
    error => error.code === 'JOURNAL_AMOUNT_PRECISION_UNSAFE'
  );
});
