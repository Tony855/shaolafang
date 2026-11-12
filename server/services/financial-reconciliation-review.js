'use strict';

const crypto = require('crypto');
const { suggestReconciliationMatches } = require('./financial-reconciliation-matcher');

function positiveId(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(field + ' must be a positive safe integer');
  return number;
}

function normalizeReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 5 || reason.length > 500) {
    const error = new TypeError('review reason must contain 5 to 500 characters');
    error.code = 'REVIEW_REASON_INVALID';
    throw error;
  }
  return reason;
}

function normalizeReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('review input is required');
  const action = String(input.action || '').trim().toLowerCase();
  if (!['confirm', 'reject', 'release', 'reassign', 'classify_exception'].includes(action)) {
    const error = new TypeError('unsupported review action');
    error.code = 'REVIEW_ACTION_INVALID';
    throw error;
  }
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    const error = new TypeError('idempotencyKey must contain 16 to 128 safe characters');
    error.code = 'REVIEW_IDEMPOTENCY_INVALID';
    throw error;
  }
  const reason = normalizeReason(input.reason);
  const exceptionCategory = input.exceptionCategory === undefined || input.exceptionCategory === null
    ? null : String(input.exceptionCategory).trim().toLowerCase();
  const categories = ['refund', 'fee', 'settlement_difference', 'chargeback', 'other'];
  if (action === 'classify_exception' && !categories.includes(exceptionCategory)) {
    const error = new TypeError('exceptionCategory is required and must be a supported category');
    error.code = 'REVIEW_EXCEPTION_CATEGORY_INVALID';
    throw error;
  }
  if (action !== 'classify_exception' && exceptionCategory !== null) {
    const error = new TypeError('exceptionCategory is only valid for classify_exception');
    error.code = 'REVIEW_EXCEPTION_CATEGORY_INVALID';
    throw error;
  }
  const journalTransactionId = input.journalTransactionId === undefined || input.journalTransactionId === null
    ? null : positiveId(input.journalTransactionId, 'journalTransactionId');
  if (['confirm', 'reassign'].includes(action) && !journalTransactionId) {
    const error = new TypeError('journalTransactionId is required for this action');
    error.code = 'REVIEW_JOURNAL_REQUIRED';
    throw error;
  }
  if (['reject', 'release'].includes(action) && journalTransactionId !== null) {
    const error = new TypeError('journalTransactionId is not allowed for this action');
    error.code = 'REVIEW_JOURNAL_UNEXPECTED';
    throw error;
  }
  return Object.freeze({ action, idempotencyKey, reason, journalTransactionId, exceptionCategory });
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createFinancialReconciliationReviewService({ runAsync, getAsync, allAsync, withTransaction }) {
  for (const [name, fn] of Object.entries({ runAsync, getAsync, allAsync, withTransaction })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' dependency is required');
  }

  async function listBatchReview({ merchantId, storeId, batchId, limit = 500, afterRowNo = 0 }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const batch = positiveId(batchId, 'batchId');
    const boundedLimit = Math.min(500, Math.max(1, positiveId(limit, 'limit')));
    const cursor = Number(afterRowNo);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('afterRowNo must be a non-negative safe integer');
    const owner = await getAsync(
      'SELECT id, status, currency_code, row_count FROM financial_reconciliation_batches WHERE id=? AND merchant_id=? AND store_id=?',
      [batch, merchant, store]
    );
    if (!owner) return null;

    const rows = await allAsync(
      `SELECT id, batch_id, row_no, external_reference, transaction_reference,
              direction, amount_minor, currency_code, occurred_at, description,
              match_status, match_reason, matched_journal_transaction_id, exception_category, exception_note
       FROM financial_reconciliation_items
       WHERE batch_id=? AND merchant_id=? AND store_id=? AND row_no>?
       ORDER BY row_no ASC LIMIT ?`,
      [batch, merchant, store, cursor, boundedLimit + 1]
    );
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    const referenceSet = new Set();
    for (const row of rows) {
      if (row.external_reference) referenceSet.add(String(row.external_reference));
      if (row.transaction_reference) referenceSet.add(String(row.transaction_reference));
    }
    const references = [...referenceSet];
    const candidates = references.length === 0 ? [] : await allAsync(
      `SELECT j.id AS journalTransactionId, j.merchant_id AS merchantId,
              j.store_id AS storeId, j.source_id AS sourceId,
              j.currency_code AS currencyCode,
              SUM(CASE WHEN e.direction='debit' THEN e.amount_minor ELSE 0 END) AS amountMinor,
              SUM(CASE WHEN e.direction='credit' THEN e.amount_minor ELSE 0 END) AS creditMinor
       FROM financial_journal_transactions j
       INNER JOIN financial_journal_entries e ON e.transaction_id=j.id
         AND e.merchant_id=j.merchant_id AND e.store_id=j.store_id
       WHERE j.merchant_id=? AND j.store_id=? AND j.source_id IN (${references.map(() => '?').join(',')})
       GROUP BY j.id, j.merchant_id, j.store_id, j.source_id, j.currency_code
       HAVING amountMinor=creditMinor AND amountMinor>0
       ORDER BY j.id DESC`,
      [merchant, store, ...references]
    );
    const suggestions = suggestReconciliationMatches({
      statementRows: rows.map(row => ({
        rowNo: Number(row.row_no), merchantId: merchant, storeId: store,
        externalReference: row.external_reference, transactionReference: row.transaction_reference,
        amountMinor: Number(row.amount_minor), currencyCode: row.currency_code
      })),
      journalCandidates: candidates.map(candidate => ({
        journalTransactionId: Number(candidate.journalTransactionId),
        merchantId: Number(candidate.merchantId), storeId: Number(candidate.storeId),
        sourceId: candidate.sourceId, amountMinor: Number(candidate.amountMinor),
        currencyCode: candidate.currencyCode
      }))
    });
    const byRow = new Map(suggestions.map(item => [item.rowNo, item]));
    return {
      batch: { id: Number(owner.id), status: owner.status, currencyCode: owner.currency_code, rowCount: Number(owner.row_count) },
      nextCursor: hasMore && rows.length ? Number(rows[rows.length - 1].row_no) : null,
      items: rows.map(row => ({
        id: Number(row.id), rowNo: Number(row.row_no), externalReference: row.external_reference,
        transactionReference: row.transaction_reference, direction: row.direction,
        amountMinor: Number(row.amount_minor), currencyCode: row.currency_code,
        occurredAt: row.occurred_at, description: row.description,
        matchStatus: row.match_status, matchReason: row.match_reason,
        matchedJournalTransactionId: row.matched_journal_transaction_id === null ? null : Number(row.matched_journal_transaction_id),
        exceptionCategory: row.exception_category || null, exceptionNote: row.exception_note || null,
        suggestion: byRow.get(Number(row.row_no)) || null
      }))
    };
  }

  async function reviewItem(input) {
    const merchantId = positiveId(input.merchantId, 'merchantId');
    const storeId = positiveId(input.storeId, 'storeId');
    const batchId = positiveId(input.batchId, 'batchId');
    const itemId = positiveId(input.itemId, 'itemId');
    const actorId = positiveId(input.actorId, 'actorId');
    const actorUsername = String(input.actorUsername || '').trim();
    if (!actorUsername || actorUsername.length > 100) throw new TypeError('actorUsername is required');
    const review = normalizeReviewInput(input);
    const requestHash = stableHash({
      merchantId, storeId, batchId, itemId, action: review.action, exceptionCategory: review.exceptionCategory,
      journalTransactionId: review.journalTransactionId, reason: review.reason
    });

    try {
      return await withTransaction(async () => {
        const replay = await getAsync(
          'SELECT id, request_sha256, event_hash, action, item_id, actor_admin_id FROM financial_reconciliation_review_events WHERE merchant_id=? AND store_id=? AND batch_id=? AND idempotency_key=? FOR UPDATE',
          [merchantId, storeId, batchId, review.idempotencyKey]
        );
        if (replay) {
          if (Number(replay.actor_admin_id) !== actorId || replay.request_sha256 !== requestHash) {
            const error = new Error('idempotency key was already used with a different review request');
            error.code = 'REVIEW_IDEMPOTENCY_CONFLICT';
            throw error;
          }
          return { eventId: Number(replay.id), itemId: Number(replay.item_id), action: replay.action, eventHash: replay.event_hash, replayed: true };
        }

        const batch = await getAsync(
          'SELECT id, status FROM financial_reconciliation_batches WHERE id=? AND merchant_id=? AND store_id=? FOR UPDATE',
          [batchId, merchantId, storeId]
        );
        if (!batch) {
          const error = new Error('reconciliation batch not found');
          error.code = 'REVIEW_NOT_FOUND';
          throw error;
        }
        if (batch.status === 'closed') {
          const error = new Error('closed reconciliation batches cannot be changed');
          error.code = 'REVIEW_BATCH_CLOSED';
          throw error;
        }
        const item = await getAsync(
          `SELECT id, batch_id, merchant_id, store_id, amount_minor, currency_code,
                  match_status, matched_journal_transaction_id, match_reason, exception_category, exception_note
           FROM financial_reconciliation_items
           WHERE id=? AND batch_id=? AND merchant_id=? AND store_id=? FOR UPDATE`,
          [itemId, batchId, merchantId, storeId]
        );
        if (!item) {
          const error = new Error('reconciliation item not found');
          error.code = 'REVIEW_NOT_FOUND';
          throw error;
        }

        const before = {
          matchStatus: item.match_status,
          matchedJournalTransactionId: item.matched_journal_transaction_id === null ? null : Number(item.matched_journal_transaction_id),
          matchReason: item.match_reason || null,
          exceptionCategory: item.exception_category || null,
          exceptionNote: item.exception_note || null
        };
        let nextStatus;
        let nextJournalId = null;
        if (review.action === 'confirm' || review.action === 'reassign') {
          if (review.action === 'confirm' && item.match_status === 'matched') {
            const error = new Error('item is already matched; use reassign or release');
            error.code = 'REVIEW_STATE_CONFLICT';
            throw error;
          }
          if (review.action === 'reassign' && item.match_status !== 'matched') {
            const error = new Error('only a matched item can be reassigned');
            error.code = 'REVIEW_STATE_CONFLICT';
            throw error;
          }
          const journal = await getAsync(
            'SELECT id, merchant_id, store_id, currency_code FROM financial_journal_transactions WHERE id=? AND merchant_id=? AND store_id=? FOR UPDATE',
            [review.journalTransactionId, merchantId, storeId]
          );
          if (!journal) {
            const error = new Error('journal transaction not found in this merchant/store');
            error.code = 'REVIEW_JOURNAL_NOT_FOUND';
            throw error;
          }
          const totals = await getAsync(
            `SELECT
               SUM(CASE WHEN direction='debit' THEN amount_minor ELSE 0 END) AS debit_minor,
               SUM(CASE WHEN direction='credit' THEN amount_minor ELSE 0 END) AS credit_minor
             FROM financial_journal_entries
             WHERE transaction_id=? AND merchant_id=? AND store_id=?`,
            [review.journalTransactionId, merchantId, storeId]
          );
          const debit = Number(totals?.debit_minor || 0);
          const credit = Number(totals?.credit_minor || 0);
          if (journal.currency_code !== item.currency_code || !Number.isSafeInteger(debit) ||
              debit <= 0 || debit !== credit || debit !== Number(item.amount_minor)) {
            const error = new Error('journal amount or currency does not exactly match the statement item');
            error.code = 'REVIEW_JOURNAL_MISMATCH';
            throw error;
          }
          const used = await getAsync(
            'SELECT id FROM financial_reconciliation_items WHERE matched_journal_transaction_id=? AND id<>? FOR UPDATE',
            [review.journalTransactionId, itemId]
          );
          if (used) {
            const error = new Error('journal transaction is already assigned to another statement row');
            error.code = 'REVIEW_DUPLICATE_ASSIGNMENT';
            throw error;
          }
          if (before.matchedJournalTransactionId === review.journalTransactionId) {
            const error = new Error('statement item is already assigned to this journal transaction');
            error.code = 'REVIEW_STATE_CONFLICT';
            throw error;
          }
          nextStatus = 'matched';
          nextJournalId = review.journalTransactionId;
        } else if (review.action === 'classify_exception') {
          if (item.match_status === 'matched') {
            const error = new Error('release a matched item before classifying an exception');
            error.code = 'REVIEW_STATE_CONFLICT';
            throw error;
          }
          nextStatus = 'exception';
        } else if (review.action === 'reject') {
          if (item.match_status === 'matched') {
            const error = new Error('release a matched item before rejecting it');
            error.code = 'REVIEW_STATE_CONFLICT';
            throw error;
          }
          nextStatus = 'unmatched';
        } else {
          if (item.match_status !== 'matched') {
            const error = new Error('only a matched item can be released');
            error.code = 'REVIEW_STATE_CONFLICT';
            throw error;
          }
          nextStatus = 'pending';
        }

        const nextReason = 'manual_' + review.action;
        const nextExceptionCategory = review.action === 'classify_exception' ? review.exceptionCategory : null;
        const nextExceptionNote = review.action === 'classify_exception' ? review.reason : null;
        const after = { matchStatus: nextStatus, matchedJournalTransactionId: nextJournalId, matchReason: nextReason, exceptionCategory: nextExceptionCategory, exceptionNote: nextExceptionNote };
        await runAsync(
          'UPDATE financial_reconciliation_items SET match_status=?, matched_journal_transaction_id=?, match_reason=?, exception_category=?, exception_note=? WHERE id=? AND batch_id=? AND merchant_id=? AND store_id=?',
          [nextStatus, nextJournalId, nextReason, nextExceptionCategory, nextExceptionNote, itemId, batchId, merchantId, storeId]
        );

        const previous = await getAsync(
          'SELECT event_hash FROM financial_reconciliation_review_events WHERE batch_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',
          [batchId]
        );
        const previousHash = previous?.event_hash || '';
        const eventPayload = {
          merchantId, storeId, batchId, itemId, action: review.action,
          actorId, actorUsername, reason: review.reason,
          idempotencyKey: review.idempotencyKey, requestHash, before, after, previousHash
        };
        const eventHash = stableHash(eventPayload);
        const inserted = await runAsync(
          `INSERT INTO financial_reconciliation_review_events
            (merchant_id, store_id, batch_id, item_id, journal_transaction_id, exception_category,
             actor_admin_id, actor_username, action, reason, idempotency_key,
             request_sha256, before_json, after_json, previous_hash, event_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [merchantId, storeId, batchId, itemId, nextJournalId, nextExceptionCategory, actorId, actorUsername,
            review.action, review.reason, review.idempotencyKey, requestHash,
            JSON.stringify(before), JSON.stringify(after), previousHash, eventHash]
        );
        return { eventId: Number(inserted.insertId || inserted.lastID), itemId, action: review.action, eventHash, replayed: false };
      });
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') {
        const existing = await getAsync(
          'SELECT id, request_sha256, event_hash, action, item_id, actor_admin_id FROM financial_reconciliation_review_events WHERE merchant_id=? AND store_id=? AND batch_id=? AND idempotency_key=?',
          [merchantId, storeId, batchId, review.idempotencyKey]
        );
        if (existing) {
          if (Number(existing.actor_admin_id) === actorId && existing.request_sha256 === requestHash) {
            return { eventId: Number(existing.id), itemId: Number(existing.item_id), action: existing.action, eventHash: existing.event_hash, replayed: true };
          }
          const idempotencyConflict = new Error('idempotency key was already used with a different review request');
          idempotencyConflict.code = 'REVIEW_IDEMPOTENCY_CONFLICT';
          throw idempotencyConflict;
        }
        const assignmentConflict = new Error('journal transaction is already assigned to another statement row');
        assignmentConflict.code = 'REVIEW_DUPLICATE_ASSIGNMENT';
        throw assignmentConflict;
      }
      throw error;
    }
  }

  async function getDailySummary({ merchantId, storeId, from, to }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
    if (!validDate(from) || !validDate(to) || from > to ||
        (Date.parse(to) - Date.parse(from)) / 86400000 > 90) {
      const error = new TypeError('date range must be valid and no longer than 91 days');
      error.code = 'REVIEW_DATE_RANGE_INVALID';
      throw error;
    }
    const endExclusive = new Date(Date.parse(to + 'T00:00:00.000Z') + 86400000).toISOString().slice(0, 10);
    return allAsync(
      `SELECT DATE(b.imported_at) AS report_date, b.currency_code,
              COUNT(*) AS batch_count, SUM(b.row_count) AS statement_row_count,
              SUM(b.total_debit_minor) AS total_debit_minor,
              SUM(b.total_credit_minor) AS total_credit_minor,
              SUM(COALESCE(i.matched_count, 0)) AS matched_count,
              SUM(COALESCE(i.pending_count, 0)) AS pending_count,
              SUM(COALESCE(i.unmatched_count, 0)) AS unmatched_count,
              SUM(COALESCE(i.ambiguous_count, 0)) AS ambiguous_count,
              SUM(COALESCE(i.exception_count, 0)) AS exception_count,
              SUM(COALESCE(i.refund_exception_count, 0)) AS refund_exception_count,
              SUM(COALESCE(i.fee_exception_count, 0)) AS fee_exception_count,
              SUM(COALESCE(i.settlement_difference_exception_count, 0)) AS settlement_difference_exception_count,
              SUM(COALESCE(i.chargeback_exception_count, 0)) AS chargeback_exception_count,
              SUM(COALESCE(i.other_exception_count, 0)) AS other_exception_count
       FROM financial_reconciliation_batches b
       LEFT JOIN (
         SELECT batch_id, merchant_id, store_id,
                SUM(match_status='matched') AS matched_count,
                SUM(match_status='pending') AS pending_count,
                SUM(match_status='unmatched') AS unmatched_count,
                SUM(match_status='ambiguous') AS ambiguous_count,
                SUM(match_status='exception') AS exception_count,
                SUM(match_status='exception' AND exception_category='refund') AS refund_exception_count,
                SUM(match_status='exception' AND exception_category='fee') AS fee_exception_count,
                SUM(match_status='exception' AND exception_category='settlement_difference') AS settlement_difference_exception_count,
                SUM(match_status='exception' AND exception_category='chargeback') AS chargeback_exception_count,
                SUM(match_status='exception' AND exception_category='other') AS other_exception_count
         FROM financial_reconciliation_items
         GROUP BY batch_id, merchant_id, store_id
       ) i ON i.batch_id=b.id AND i.merchant_id=b.merchant_id AND i.store_id=b.store_id
       WHERE b.merchant_id=? AND b.store_id=? AND b.imported_at>=? AND b.imported_at<?
       GROUP BY DATE(b.imported_at), b.currency_code ORDER BY report_date ASC, b.currency_code ASC`,
      [merchant, store, from + ' 00:00:00', endExclusive + ' 00:00:00']
    );
  }


  async function listReviewHistory({ merchantId, storeId, batchId, itemId, limit = 50, afterId = 0 }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const boundedLimit = positiveId(limit, 'limit');
    if (boundedLimit > 200) throw new TypeError('limit must not exceed 200');
    const cursor = Number(afterId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('afterId must be a non-negative safe integer');
    const filters = ['merchant_id=?', 'store_id=?', 'id<?'];
    const params = [merchant, store, cursor || Number.MAX_SAFE_INTEGER];
    if (batchId !== undefined && batchId !== null && batchId !== '') {
      filters.push('batch_id=?');
      params.push(positiveId(batchId, 'batchId'));
    }
    if (itemId !== undefined && itemId !== null && itemId !== '') {
      filters.push('item_id=?');
      params.push(positiveId(itemId, 'itemId'));
    }
    const rows = await allAsync(
      `SELECT id, batch_id, item_id, journal_transaction_id, exception_category,
              actor_admin_id, actor_username, action, reason, idempotency_key,
              before_json, after_json, previous_hash, event_hash, created_at
       FROM financial_reconciliation_review_events
       WHERE ${filters.join(' AND ')}
       ORDER BY id DESC LIMIT ?`,
      [...params, boundedLimit + 1]
    );
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    const parseSnapshot = value => {
      if (value && typeof value === 'object') return value;
      if (typeof value !== 'string') return null;
      try { return JSON.parse(value); } catch (_) { return null; }
    };
    return {
      nextCursor: hasMore && rows.length ? Number(rows[rows.length - 1].id) : null,
      items: rows.map(row => ({
        eventId: Number(row.id), batchId: Number(row.batch_id), itemId: Number(row.item_id),
        journalTransactionId: row.journal_transaction_id === null ? null : Number(row.journal_transaction_id),
        exceptionCategory: row.exception_category || null, actorAdminId: Number(row.actor_admin_id),
        actorUsername: row.actor_username, action: row.action, reason: row.reason,
        idempotencyKey: row.idempotency_key, before: parseSnapshot(row.before_json),
        after: parseSnapshot(row.after_json), previousHash: row.previous_hash || '',
        eventHash: row.event_hash, createdAt: row.created_at
      }))
    };
  }

  async function getMonthlyClosePreview({ merchantId, storeId, month }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      const error = new TypeError('month must use YYYY-MM format');
      error.code = 'REVIEW_MONTH_INVALID';
      throw error;
    }
    const [year, monthNumber] = month.split('-').map(Number);
    const endExclusive = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
    const rows = await allAsync(
      `SELECT b.currency_code,
              COUNT(*) AS batch_count,
              SUM(b.row_count) AS statement_row_count,
              SUM(b.total_debit_minor) AS total_debit_minor,
              SUM(b.total_credit_minor) AS total_credit_minor,
              SUM(b.status='closed') AS closed_batch_count,
              SUM(b.status<>'closed') AS open_batch_count,
              SUM(COALESCE(i.matched_count, 0)) AS matched_count,
              SUM(COALESCE(i.pending_count, 0)) AS pending_count,
              SUM(COALESCE(i.unmatched_count, 0)) AS unmatched_count,
              SUM(COALESCE(i.ambiguous_count, 0)) AS ambiguous_count,
              SUM(COALESCE(i.exception_count, 0)) AS exception_count,
              SUM(COALESCE(i.unresolved_count, 0)) AS unresolved_count
       FROM financial_reconciliation_batches b
       LEFT JOIN (
         SELECT batch_id, merchant_id, store_id,
                SUM(match_status='matched') AS matched_count,
                SUM(match_status='pending') AS pending_count,
                SUM(match_status='unmatched') AS unmatched_count,
                SUM(match_status='ambiguous') AS ambiguous_count,
                SUM(match_status='exception') AS exception_count,
                SUM(match_status<>'matched') AS unresolved_count
         FROM financial_reconciliation_items
         GROUP BY batch_id, merchant_id, store_id
       ) i ON i.batch_id=b.id AND i.merchant_id=b.merchant_id AND i.store_id=b.store_id
       WHERE b.merchant_id=? AND b.store_id=? AND b.imported_at>=? AND b.imported_at<?
       GROUP BY b.currency_code ORDER BY b.currency_code ASC`,
      [merchant, store, month + '-01 00:00:00', endExclusive + ' 00:00:00']
    );
    return rows.map(row => {
      const result = {
        currencyCode: row.currency_code,
        batchCount: Number(row.batch_count || 0),
        statementRowCount: Number(row.statement_row_count || 0),
        totalDebitMinor: Number(row.total_debit_minor || 0),
        totalCreditMinor: Number(row.total_credit_minor || 0),
        closedBatchCount: Number(row.closed_batch_count || 0),
        openBatchCount: Number(row.open_batch_count || 0),
        matchedCount: Number(row.matched_count || 0),
        pendingCount: Number(row.pending_count || 0),
        unmatchedCount: Number(row.unmatched_count || 0),
        ambiguousCount: Number(row.ambiguous_count || 0),
        exceptionCount: Number(row.exception_count || 0),
        unresolvedCount: Number(row.unresolved_count || 0)
      };
      result.reviewComplete = result.batchCount > 0 && result.unresolvedCount === 0;
      result.closeReady = result.reviewComplete;
      return result;
    });
  }

  return Object.freeze({ listBatchReview, reviewItem, getDailySummary, listReviewHistory, getMonthlyClosePreview });
}

module.exports = { createFinancialReconciliationReviewService, normalizeReviewInput, stableHash };
