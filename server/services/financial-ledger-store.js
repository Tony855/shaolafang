'use strict';

const { createProviderEventEnvelope, createJournalDraft } = require('./financial-ledger');
const { safeMinorUnitAmount } = require('./financial-minor-units');

function normalizeProviderEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('normalizedEvent is required for durable processing');
  }
  const allowed = new Set(['orderReference', 'amountMinor', 'currencyCode', 'paymentStatus', 'providerTransactionId']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError('normalizedEvent contains an unsupported field');
  }
  const orderReference = String(value.orderReference || '').trim();
  const amountMinor = Number(value.amountMinor);
  const currencyCode = String(value.currencyCode || '').trim().toUpperCase();
  const paymentStatus = String(value.paymentStatus || '').trim().toLowerCase();
  const providerTransactionId = String(value.providerTransactionId || '').trim();
  if (!orderReference || orderReference.length > 128) throw new TypeError('normalizedEvent.orderReference is invalid');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new TypeError('normalizedEvent.amountMinor is invalid');
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError('normalizedEvent.currencyCode is invalid');
  if (!['paid', 'failed', 'refunded', 'reversed', 'pending'].includes(paymentStatus)) {
    throw new TypeError('normalizedEvent.paymentStatus is invalid');
  }
  if (providerTransactionId.length > 191) throw new TypeError('normalizedEvent.providerTransactionId is invalid');
  return Object.freeze({ orderReference, amountMinor, currencyCode, paymentStatus, providerTransactionId });
}

function createFinancialLedgerService({ runAsync, getAsync, allAsync, withTransaction }) {
  for (const [name, fn] of Object.entries({ runAsync, getAsync, allAsync, withTransaction })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' dependency is required');
  }

  async function recordVerifiedProviderEvent(input) {
    const verification = input && input.verification;
    const requestedProviderCode = String(input?.envelope?.providerCode || '').trim().toUpperCase();
    if (!verification || verification.verified !== true ||
        String(verification.providerCode || '').trim().toUpperCase() !== requestedProviderCode) {
      const error = new Error('provider event must be authenticated by its provider adapter');
      error.code = 'PROVIDER_EVENT_NOT_VERIFIED';
      throw error;
    }
    const event = createProviderEventEnvelope(input.envelope);
    const normalizedEvent = normalizeProviderEvent(input.normalizedEvent);
    if (event.providerTransactionId &&
        normalizedEvent.providerTransactionId !== event.providerTransactionId) {
      const error = new Error('provider transaction identity differs between the event envelope and normalized event');
      error.code = 'PROVIDER_EVENT_TRANSACTION_ID_MISMATCH';
      throw error;
    }
    const normalizedJson = JSON.stringify(normalizedEvent);
    if (!normalizedJson || normalizedJson.length > 16000) {
      throw new TypeError('normalizedEvent must serialize to at most 16000 characters');
    }
    return withTransaction(async () => {
      await runAsync(
        `INSERT INTO provider_webhook_events
          (provider_code, provider_event_id, merchant_id, store_id, event_type,
           provider_transaction_id, payload_sha256, normalized_event_json, auth_status, processing_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', 'received')
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
        [event.providerCode, event.providerEventId, event.merchantId, event.storeId,
          event.eventType, event.providerTransactionId, event.payloadSha256, normalizedJson]
      );
      const existing = await getAsync(
        `SELECT id, merchant_id, store_id, payload_sha256, normalized_event_json, auth_status, processing_status
         FROM provider_webhook_events
         WHERE provider_code=? AND provider_event_id=? FOR UPDATE`,
        [event.providerCode, event.providerEventId]
      );
      if (!existing) throw new Error('provider event insert could not be read back');
      if (Number(existing.merchant_id) !== event.merchantId ||
          Number(existing.store_id) !== event.storeId ||
          String(existing.payload_sha256).toLowerCase() !== event.payloadSha256 ||
          JSON.stringify(typeof existing.normalized_event_json === 'string' ? JSON.parse(existing.normalized_event_json) : existing.normalized_event_json) !== normalizedJson) {
        const error = new Error('provider event identity was reused with different content or tenant scope');
        error.code = 'PROVIDER_EVENT_ID_COLLISION';
        throw error;
      }
      if (existing.auth_status === 'rejected') {
        const error = new Error('a previously rejected provider event cannot be reactivated');
        error.code = 'PROVIDER_EVENT_PREVIOUSLY_REJECTED';
        throw error;
      }
      if (existing.auth_status === 'pending') {
        await runAsync(
          "UPDATE provider_webhook_events SET auth_status='verified' WHERE id=? AND auth_status='pending'",
          [existing.id]
        );
      }
      return {
        eventId: Number(existing.id),
        accepted: true,
        processingStatus: existing.processing_status
      };
    });
  }

  async function postJournalTransaction(input) {
    const draft = createJournalDraft(input);
    return withTransaction(async () => {
      await runAsync(
        `INSERT INTO financial_journal_transactions
          (merchant_id, store_id, currency_code, source_type, source_id,
           idempotency_key, description, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
        [draft.merchantId, draft.storeId, draft.currencyCode, draft.sourceType,
          draft.sourceId, draft.idempotencyKey, draft.description, draft.createdBy]
      );
      const transaction = await getAsync(
        `SELECT id, merchant_id, store_id, currency_code, source_type, source_id,
                idempotency_key, description, created_by
         FROM financial_journal_transactions
         WHERE merchant_id=? AND store_id=? AND idempotency_key=? FOR UPDATE`,
        [draft.merchantId, draft.storeId, draft.idempotencyKey]
      );
      if (!transaction) throw new Error('journal transaction insert could not be read back');
      const identityMatches =
        Number(transaction.merchant_id) === draft.merchantId &&
        Number(transaction.store_id) === draft.storeId &&
        transaction.currency_code === draft.currencyCode &&
        transaction.source_type === draft.sourceType &&
        String(transaction.source_id) === draft.sourceId &&
        String(transaction.description || '') === draft.description &&
        String(transaction.created_by || '') === draft.createdBy;
      if (!identityMatches) {
        const error = new Error('journal idempotency key was reused with a different transaction');
        error.code = 'JOURNAL_IDEMPOTENCY_CONFLICT';
        throw error;
      }

      const existingEntries = await allAsync(
        `SELECT line_no, account_code, direction, amount_minor, memo
         FROM financial_journal_entries WHERE transaction_id=? ORDER BY line_no FOR UPDATE`,
        [transaction.id]
      );
      if (existingEntries.length > 0) {
        const same = existingEntries.length === draft.entries.length &&
          existingEntries.every((entry, index) => {
            const expected = draft.entries[index];
            return Number(entry.line_no) === expected.lineNo &&
              entry.account_code === expected.accountCode &&
              entry.direction === expected.direction &&
              safeMinorUnitAmount(entry.amount_minor, 'journalEntryAmountMinor', 'JOURNAL_AMOUNT_PRECISION_UNSAFE') === expected.amountMinor &&
              String(entry.memo || '') === expected.memo;
          });
        if (!same) {
          const error = new Error('journal idempotency key was reused with different entries');
          error.code = 'JOURNAL_IDEMPOTENCY_CONFLICT';
          throw error;
        }
        return { transactionId: Number(transaction.id), replayed: true };
      }

      for (const entry of draft.entries) {
        await runAsync(
          `INSERT INTO financial_journal_entries
            (transaction_id, merchant_id, store_id, line_no, account_code,
             direction, amount_minor, memo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [transaction.id, draft.merchantId, draft.storeId, entry.lineNo,
            entry.accountCode, entry.direction, entry.amountMinor, entry.memo]
        );
      }
      return { transactionId: Number(transaction.id), replayed: false };
    });
  }

  return Object.freeze({ recordVerifiedProviderEvent, postJournalTransaction });
}

module.exports = { createFinancialLedgerService };
