'use strict';

const crypto = require('crypto');

function positiveSafeInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(field + ' must be a positive safe integer');
  }
  return number;
}

function hashWebhookPayload(rawBody) {
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
    throw new TypeError('rawBody must be a Buffer or string');
  }
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

// This creates a storage-safe envelope only. It does not authenticate a
// provider, parse a provider-specific payload, or mark an event as verified.
function createProviderEventEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('provider event input is required');
  }
  const providerCode = String(input.providerCode || '').trim().toUpperCase();
  const providerEventId = String(input.providerEventId || '').trim();
  const eventType = String(input.eventType || '').trim();
  const providerTransactionId = String(input.providerTransactionId || '').trim();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(providerCode)) {
    throw new TypeError('providerCode is invalid');
  }
  if (!providerEventId || providerEventId.length > 191) {
    throw new TypeError('providerEventId is invalid');
  }
  if (eventType.length > 100 || providerTransactionId.length > 191) {
    throw new TypeError('provider event metadata is too long');
  }
  const payloadSha256 = input.payloadSha256 || hashWebhookPayload(input.rawBody);
  if (!/^[a-f0-9]{64}$/i.test(String(payloadSha256))) {
    throw new TypeError('payloadSha256 must be a SHA-256 hex digest');
  }
  return Object.freeze({
    providerCode,
    providerEventId,
    merchantId: positiveSafeInteger(input.merchantId, 'merchantId'),
    storeId: positiveSafeInteger(input.storeId, 'storeId'),
    eventType,
    providerTransactionId,
    payloadSha256: String(payloadSha256).toLowerCase()
  });
}

// Journal amounts are integer minor units (for example, USD cents or KHR riel).
// A draft is accepted only when its debit and credit totals balance exactly.
function createJournalDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('journal transaction input is required');
  }
  const merchantId = positiveSafeInteger(input.merchantId, 'merchantId');
  const storeId = positiveSafeInteger(input.storeId, 'storeId');
  const currencyCode = String(input.currencyCode || '').trim().toUpperCase();
  const sourceType = String(input.sourceType || '').trim();
  const sourceId = String(input.sourceId || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError('currencyCode must be a 3-letter code');
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(sourceType)) throw new TypeError('sourceType is invalid');
  if (!sourceId || sourceId.length > 128) throw new TypeError('sourceId is invalid');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new TypeError('idempotencyKey is invalid');
  if (!Array.isArray(input.entries) || input.entries.length < 2 || input.entries.length > 50) {
    throw new TypeError('journal requires between 2 and 50 entries');
  }

  let debitTotal = 0;
  let creditTotal = 0;
  const entries = input.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('journal entry ' + index + ' is invalid');
    }
    const accountCode = String(entry.accountCode || '').trim();
    const direction = String(entry.direction || '').toLowerCase();
    const amountMinor = Number(entry.amountMinor);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(accountCode)) {
      throw new TypeError('journal accountCode is invalid');
    }
    if (direction !== 'debit' && direction !== 'credit') {
      throw new TypeError('journal direction must be debit or credit');
    }
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new TypeError('journal amountMinor must be a positive safe integer');
    }
    if (direction === 'debit') debitTotal += amountMinor;
    else creditTotal += amountMinor;
    if (!Number.isSafeInteger(debitTotal) || !Number.isSafeInteger(creditTotal)) {
      throw new TypeError('journal total exceeds safe integer range');
    }
    const memo = String(entry.memo || '');
    if (memo.length > 255) throw new TypeError('journal memo is too long');
    return Object.freeze({ lineNo: index + 1, accountCode, direction, amountMinor, memo });
  });
  if (debitTotal !== creditTotal) {
    throw new TypeError('journal debits and credits must balance');
  }

  return Object.freeze({
    merchantId,
    storeId,
    currencyCode,
    sourceType,
    sourceId,
    idempotencyKey,
    description: String(input.description || '').slice(0, 255),
    createdBy: String(input.createdBy || '').slice(0, 100),
    debitTotalMinor: debitTotal,
    creditTotalMinor: creditTotal,
    entries: Object.freeze(entries)
  });
}

module.exports = { hashWebhookPayload, createProviderEventEnvelope, createJournalDraft };
