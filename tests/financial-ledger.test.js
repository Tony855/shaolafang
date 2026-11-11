'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hashWebhookPayload,
  createProviderEventEnvelope,
  createJournalDraft
} = require('../server/services/financial-ledger');

test('provider event envelope hashes raw bytes and never returns the raw payload', () => {
  const rawBody = Buffer.from('provider event body');
  const envelope = createProviderEventEnvelope({
    providerCode: 'aba_payway',
    providerEventId: 'evt-123',
    merchantId: 7,
    storeId: 11,
    eventType: 'payment.completed',
    providerTransactionId: 'txn-456',
    rawBody
  });
  assert.equal(envelope.providerCode, 'ABA_PAYWAY');
  assert.equal(envelope.payloadSha256, hashWebhookPayload(rawBody));
  assert.equal(Object.hasOwn(envelope, 'rawBody'), false);
  assert.equal(Object.hasOwn(envelope, 'signature'), false);
  assert.equal(Object.isFrozen(envelope), true);
});

test('provider event envelope rejects missing identity and invalid scope', () => {
  assert.throws(() => createProviderEventEnvelope({
    providerCode: 'ABA', merchantId: 1, storeId: 1, rawBody: '{}'
  }), /providerEventId/);
  assert.throws(() => createProviderEventEnvelope({
    providerCode: 'A', providerEventId: 'evt-1', merchantId: 1, storeId: 1, rawBody: '{}'
  }), /providerCode/);
  assert.throws(() => createProviderEventEnvelope({
    providerCode: 'ABA', providerEventId: 'evt-1', merchantId: 0, storeId: 1, rawBody: '{}'
  }), /merchantId/);
  assert.throws(() => createProviderEventEnvelope({
    providerCode: 'ABA', providerEventId: 'evt-1', merchantId: 1, storeId: 1, payloadSha256: 'bad'
  }), /payloadSha256/);
});

test('journal draft accepts balanced integer minor-unit entries', () => {
  const draft = createJournalDraft({
    merchantId: 3,
    storeId: 9,
    currencyCode: 'usd',
    sourceType: 'order_payment',
    sourceId: 'order-42',
    idempotencyKey: 'order-payment:42',
    entries: [
      { accountCode: 'cash_clearing', direction: 'debit', amountMinor: 1250 },
      { accountCode: 'sales_revenue', direction: 'credit', amountMinor: 1250 }
    ]
  });
  assert.equal(draft.currencyCode, 'USD');
  assert.equal(draft.debitTotalMinor, 1250);
  assert.equal(draft.creditTotalMinor, 1250);
  assert.deepEqual(draft.entries.map(entry => entry.lineNo), [1, 2]);
  assert.equal(Object.isFrozen(draft.entries), true);
});

test('journal draft rejects unbalanced, fractional, negative, and unsafe amounts', () => {
  const base = {
    merchantId: 1, storeId: 1, currencyCode: 'USD',
    sourceType: 'refund', sourceId: 'r-1', idempotencyKey: 'refund:000001',
    entries: [
      { accountCode: 'refunds', direction: 'debit', amountMinor: 500 },
      { accountCode: 'cash', direction: 'credit', amountMinor: 400 }
    ]
  };
  assert.throws(() => createJournalDraft(base), /must balance/);
  for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const input = { ...base, entries: [
      { accountCode: 'refunds', direction: 'debit', amountMinor },
      { accountCode: 'cash', direction: 'credit', amountMinor: 1 }
    ] };
    assert.throws(() => createJournalDraft(input), /positive safe integer/);
  }
});

test('journal draft validates tenant scope, currency, source, and idempotency key', () => {
  const valid = {
    merchantId: 1, storeId: 1, currencyCode: 'USD',
    sourceType: 'settlement', sourceId: 'settlement-1', idempotencyKey: 'settlement:0001',
    entries: [
      { accountCode: 'bank', direction: 'debit', amountMinor: 10 },
      { accountCode: 'clearing', direction: 'credit', amountMinor: 10 }
    ]
  };
  assert.throws(() => createJournalDraft({ ...valid, currencyCode: 'US' }), /3-letter/);
  assert.throws(() => createJournalDraft({ ...valid, sourceType: 'Invalid Type' }), /sourceType/);
  assert.throws(() => createJournalDraft({ ...valid, idempotencyKey: 'short' }), /idempotencyKey/);
});
