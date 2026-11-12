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

function createFinancialReconciliationReviewService({ runAsync, getAsync, allAsync, withTransaction, lockFinancialMonthPeriod }) {
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

        if (typeof lockFinancialMonthPeriod === 'function') {
          await lockFinancialMonthPeriod({ merchantId, storeId, batchId });
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





  async function getPeriodSummary({ merchantId, storeId, from, to, period = 'week' }) {
    const merchant=positiveId(merchantId,'merchantId'),store=positiveId(storeId,'storeId');
    const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00.000Z'))&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value;
    const days=(Date.parse(to+'T00:00:00.000Z')-Date.parse(from+'T00:00:00.000Z'))/86400000;
    if(!validDate(from)||!validDate(to)||from>to||days>365){const error=new TypeError('date range must be valid and no longer than 366 days');error.code='REVIEW_DATE_RANGE_INVALID';throw error;}
    if(!['week','month'].includes(period)){const error=new TypeError('period must be week or month');error.code='REVIEW_PERIOD_INVALID';throw error;}
    const endExclusive=new Date(Date.parse(to+'T00:00:00.000Z')+86400000).toISOString().slice(0,10);
    const startExpr=period==='week'?"DATE_SUB(DATE(b.imported_at), INTERVAL WEEKDAY(b.imported_at) DAY)":"DATE_FORMAT(b.imported_at,'%Y-%m-01')";
    const endExpr=period==='week'?"DATE_ADD(DATE_SUB(DATE(b.imported_at), INTERVAL WEEKDAY(b.imported_at) DAY),INTERVAL 6 DAY)":"LAST_DAY(b.imported_at)";
    const rows=await allAsync(`SELECT DATE_FORMAT(${startExpr},'%Y-%m-%d') AS period_start,
      DATE_FORMAT(${endExpr},'%Y-%m-%d') AS period_end,b.currency_code,
      COUNT(*) AS batch_count,SUM(b.row_count) AS statement_row_count,
      SUM(b.total_debit_minor) AS total_debit_minor,SUM(b.total_credit_minor) AS total_credit_minor,
      SUM(COALESCE(i.matched_count,0)) AS matched_count,SUM(COALESCE(i.pending_count,0)) AS pending_count,
      SUM(COALESCE(i.unmatched_count,0)) AS unmatched_count,SUM(COALESCE(i.ambiguous_count,0)) AS ambiguous_count,
      SUM(COALESCE(i.exception_count,0)) AS exception_count
      FROM financial_reconciliation_batches b
      LEFT JOIN (SELECT batch_id,merchant_id,store_id,SUM(match_status='matched') AS matched_count,
        SUM(match_status='pending') AS pending_count,SUM(match_status='unmatched') AS unmatched_count,
        SUM(match_status='ambiguous') AS ambiguous_count,SUM(match_status='exception') AS exception_count
        FROM financial_reconciliation_items GROUP BY batch_id,merchant_id,store_id) i
      ON i.batch_id=b.id AND i.merchant_id=b.merchant_id AND i.store_id=b.store_id
      WHERE b.merchant_id=? AND b.store_id=? AND b.imported_at>=? AND b.imported_at<?
      GROUP BY period_start,period_end,b.currency_code ORDER BY period_start ASC,b.currency_code ASC`,
      [merchant,store,from+' 00:00:00',endExclusive+' 00:00:00']);
    const n=value=>Number(value||0);
    return {period,from,to,rows:rows.map(row=>({periodStart:String(row.period_start).slice(0,10),periodEnd:String(row.period_end).slice(0,10),
      currencyCode:row.currency_code,batchCount:n(row.batch_count),statementRowCount:n(row.statement_row_count),
      totalDebitMinor:n(row.total_debit_minor),totalCreditMinor:n(row.total_credit_minor),matchedCount:n(row.matched_count),
      pendingCount:n(row.pending_count),unmatchedCount:n(row.unmatched_count),ambiguousCount:n(row.ambiguous_count),exceptionCount:n(row.exception_count)}))};
  }

  async function getExceptionOperationsSummary({ merchantId, storeId, slaHours = 24 }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const sla = Number(slaHours);
    if (!Number.isSafeInteger(sla) || sla < 1 || sla > 720) {
      const error = new TypeError('slaHours must be an integer from 1 to 720');
      error.code = 'EXCEPTION_OPERATIONS_SLA_INVALID';
      throw error;
    }
    const activeFilter = "i.merchant_id=? AND i.store_id=? AND i.match_status='exception' AND COALESCE(c.status, 'open') IN ('open','in_progress')";
    const join = `FROM financial_reconciliation_items i
       INNER JOIN financial_reconciliation_batches b
         ON b.id=i.batch_id AND b.merchant_id=i.merchant_id AND b.store_id=i.store_id
       LEFT JOIN financial_reconciliation_exception_cases c
         ON c.item_id=i.id AND c.merchant_id=i.merchant_id AND c.store_id=i.store_id`;
    const statusRows = await allAsync(
      `SELECT COALESCE(c.status, 'open') AS case_status, COUNT(*) AS case_count,
              SUM(TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) >= ? * 3600) AS overdue_count,
              SUM(TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) < 86400) AS age_under_24h,
              SUM(TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) >= 86400
                  AND TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) < 259200) AS age_1_3d,
              SUM(TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) >= 259200
                  AND TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) < 604800) AS age_3_7d,
              SUM(TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) >= 604800) AS age_over_7d
       ${join} WHERE ${activeFilter} GROUP BY COALESCE(c.status, 'open')`,
      [sla, merchant, store]
    );
    const workloadRows = await allAsync(
      `SELECT c.assigned_admin_id, c.assigned_admin_username, COUNT(*) AS active_count,
              SUM(TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) >= ? * 3600) AS overdue_count,
              MAX(TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3))) AS oldest_age_seconds
       ${join} WHERE ${activeFilter}
       GROUP BY c.assigned_admin_id, c.assigned_admin_username
       ORDER BY active_count DESC, c.assigned_admin_username ASC`,
      [sla, merchant, store]
    );
    const overdueRows = await allAsync(
      `SELECT i.id AS item_id, i.batch_id, i.exception_category, i.currency_code,
              i.amount_minor, i.external_reference, c.assigned_admin_id, c.assigned_admin_username,
              b.imported_at, GREATEST(0, TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3))) AS age_seconds
       ${join} WHERE ${activeFilter}
         AND TIMESTAMPDIFF(SECOND, b.imported_at, CURRENT_TIMESTAMP(3)) >= ? * 3600
       ORDER BY b.imported_at ASC, i.id ASC LIMIT 50`,
      [merchant, store, sla]
    );
    const openedRows = await allAsync(
      `SELECT DATE(b.imported_at) AS report_date, COUNT(*) AS opened_count
       FROM financial_reconciliation_items i
       INNER JOIN financial_reconciliation_batches b
         ON b.id=i.batch_id AND b.merchant_id=i.merchant_id AND b.store_id=i.store_id
       WHERE i.merchant_id=? AND i.store_id=? AND i.match_status='exception'
         AND b.imported_at >= DATE_SUB(CURRENT_DATE, INTERVAL 29 DAY)
       GROUP BY DATE(b.imported_at) ORDER BY report_date ASC`,
      [merchant, store]
    );
    const resolvedRows = await allAsync(
      `SELECT DATE(created_at) AS report_date, COUNT(*) AS resolved_event_count
       FROM financial_reconciliation_exception_events
       WHERE merchant_id=? AND store_id=? AND action='resolve'
         AND created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 29 DAY)
       GROUP BY DATE(created_at) ORDER BY report_date ASC`,
      [merchant, store]
    );
    const n = value => Number(value || 0);
    const summary = { openCount: 0, inProgressCount: 0, activeCount: 0, overdueCount: 0,
      ageing: { under24Hours: 0, from1To3Days: 0, from3To7Days: 0, over7Days: 0 } };
    for (const row of statusRows) {
      const count = n(row.case_count);
      summary.activeCount += count;
      summary.overdueCount += n(row.overdue_count);
      if (row.case_status === 'open') summary.openCount += count;
      if (row.case_status === 'in_progress') summary.inProgressCount += count;
      summary.ageing.under24Hours += n(row.age_under_24h);
      summary.ageing.from1To3Days += n(row.age_1_3d);
      summary.ageing.from3To7Days += n(row.age_3_7d);
      summary.ageing.over7Days += n(row.age_over_7d);
    }
    const workload = workloadRows.map(row => ({
      adminId: row.assigned_admin_id === null ? null : n(row.assigned_admin_id),
      username: row.assigned_admin_username || null, activeCount: n(row.active_count),
      overdueCount: n(row.overdue_count), oldestAgeSeconds: n(row.oldest_age_seconds)
    }));
    const trendMap = new Map();
    for (const row of openedRows) {
      const date = String(row.report_date).slice(0, 10);
      trendMap.set(date, { date, openedCount: n(row.opened_count), resolvedEventCount: 0 });
    }
    for (const row of resolvedRows) {
      const date = String(row.report_date).slice(0, 10);
      const item = trendMap.get(date) || { date, openedCount: 0, resolvedEventCount: 0 };
      item.resolvedEventCount = n(row.resolved_event_count);
      trendMap.set(date, item);
    }
    return { slaHours: sla, summary, workload,
      trend: [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      overdueItems: overdueRows.map(row => ({
        itemId: n(row.item_id), batchId: n(row.batch_id), category: row.exception_category || null,
        currencyCode: row.currency_code, amountMinor: n(row.amount_minor),
        externalReference: row.external_reference || null,
        assignedAdminId: row.assigned_admin_id === null ? null : n(row.assigned_admin_id),
        assignedAdminUsername: row.assigned_admin_username || null,
        importedAt: row.imported_at, ageSeconds: n(row.age_seconds)
      }))
    };
  }


  async function getExceptionPerformanceSummary({ merchantId, storeId, slaHours = 24 }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const sla = Number(slaHours);
    if (!Number.isSafeInteger(sla) || sla < 1 || sla > 720) {
      const error = new TypeError('slaHours must be an integer from 1 to 720');
      error.code = 'EXCEPTION_OPERATIONS_SLA_INVALID';
      throw error;
    }
    const activeJoin = `FROM financial_reconciliation_items i
      INNER JOIN financial_reconciliation_batches b
        ON b.id=i.batch_id AND b.merchant_id=i.merchant_id AND b.store_id=i.store_id
      LEFT JOIN financial_reconciliation_exception_cases c
        ON c.item_id=i.id AND c.merchant_id=i.merchant_id AND c.store_id=i.store_id
      WHERE i.merchant_id=? AND i.store_id=? AND i.match_status='exception'
        AND COALESCE(c.status,'open') IN ('open','in_progress')`;
    const currencyRows = await allAsync(
      `SELECT i.currency_code, COUNT(*) AS active_count,
        SUM(TIMESTAMPDIFF(SECOND,b.imported_at,CURRENT_TIMESTAMP(3)) >= ? * 3600) AS overdue_count
        ${activeJoin} GROUP BY i.currency_code ORDER BY i.currency_code`,
      [sla, merchant, store]
    );
    const assigneeRows = await allAsync(
      `SELECT c.assigned_admin_id, c.assigned_admin_username, i.currency_code,
        COUNT(*) AS active_count,
        SUM(TIMESTAMPDIFF(SECOND,b.imported_at,CURRENT_TIMESTAMP(3)) >= ? * 3600) AS overdue_count
        ${activeJoin}
        GROUP BY c.assigned_admin_id,c.assigned_admin_username,i.currency_code
        ORDER BY i.currency_code,active_count DESC,c.assigned_admin_username`,
      [sla, merchant, store]
    );
    const categoryRows = await allAsync(
      `SELECT COALESCE(i.exception_category,'unclassified') AS category,i.currency_code,
        COUNT(*) AS active_count,
        SUM(TIMESTAMPDIFF(SECOND,b.imported_at,CURRENT_TIMESTAMP(3)) >= ? * 3600) AS overdue_count
        ${activeJoin}
        GROUP BY COALESCE(i.exception_category,'unclassified'),i.currency_code
        ORDER BY i.currency_code,active_count DESC,category`,
      [sla, merchant, store]
    );
    const resolutionRows = await allAsync(
      `SELECT i.currency_code,COUNT(e.id) AS resolved_event_count,
        SUM(TIMESTAMPDIFF(SECOND,b.imported_at,e.created_at) <= ? * 3600) AS on_time_resolved_event_count,
        AVG(GREATEST(0,TIMESTAMPDIFF(SECOND,b.imported_at,e.created_at))) AS avg_import_to_resolve_seconds
       FROM financial_reconciliation_exception_events e
       INNER JOIN financial_reconciliation_items i
         ON i.id=e.item_id AND i.merchant_id=e.merchant_id AND i.store_id=e.store_id
       INNER JOIN financial_reconciliation_batches b
         ON b.id=e.batch_id AND b.merchant_id=e.merchant_id AND b.store_id=e.store_id
       WHERE e.merchant_id=? AND e.store_id=? AND e.action='resolve'
       GROUP BY i.currency_code ORDER BY i.currency_code`,
      [sla, merchant, store]
    );
    const n = value => Number(value || 0);
    const percent = (part,total) => total > 0 ? Math.round((part / total) * 10000) / 100 : null;
    const resolutions = new Map(resolutionRows.map(row => [row.currency_code, row]));
    const byCurrency = currencyRows.map(row => {
      const resolved = resolutions.get(row.currency_code) || {};
      const activeCount = n(row.active_count), overdueCount = n(row.overdue_count);
      const resolvedEventCount = n(resolved.resolved_event_count);
      const onTimeResolvedEventCount = n(resolved.on_time_resolved_event_count);
      return {
        currencyCode: row.currency_code, activeCount, overdueActiveCount: overdueCount,
        overdueRatePercent: percent(overdueCount, activeCount),
        resolvedEventCount, onTimeResolvedEventCount,
        onTimeResolutionRatePercent: percent(onTimeResolvedEventCount, resolvedEventCount),
        avgImportToResolveSeconds: resolved.avg_import_to_resolve_seconds === null || resolved.avg_import_to_resolve_seconds === undefined
          ? null : n(resolved.avg_import_to_resolve_seconds)
      };
    });
    return {
      slaHours: sla,
      metricDefinitions: {
        overdueRate: '当前活跃异常中，按批次导入时间计算已超过所选 SLA 阈值的比例',
        onTimeResolutionRate: '不可变 resolve 事件中，从批次导入到该次 resolve 事件不超过 SLA 阈值的比例；按事件计数，重开后再次解决会再次计数',
        avgImportToResolve: '批次导入时间至 resolve 事件时间的平均秒数，不代表员工实际开始处理后的净耗时'
      },
      byCurrency,
      byAssignee: assigneeRows.map(row => {
        const activeCount = n(row.active_count), overdueCount = n(row.overdue_count);
        return { adminId: row.assigned_admin_id === null ? null : n(row.assigned_admin_id),
          username: row.assigned_admin_username || null, currencyCode: row.currency_code,
          activeCount, overdueActiveCount: overdueCount, overdueRatePercent: percent(overdueCount, activeCount) };
      }),
      byCategory: categoryRows.map(row => {
        const activeCount = n(row.active_count), overdueCount = n(row.overdue_count);
        return { category: row.category, currencyCode: row.currency_code,
          activeCount, overdueActiveCount: overdueCount, overdueRatePercent: percent(overdueCount, activeCount) };
      })
    };
  }

  async function generateSlaAlerts({ merchantId, storeId, slaHours = 24, actorId, actorUsername }) {
    const merchant = positiveId(merchantId, 'merchantId'), store = positiveId(storeId, 'storeId');
    const actor = positiveId(actorId, 'actorId'), username = String(actorUsername || '').trim();
    const sla = Number(slaHours);
    if (!Number.isSafeInteger(sla) || sla < 1 || sla > 720) {
      const error = new TypeError('slaHours must be an integer from 1 to 720'); error.code = 'EXCEPTION_ALERT_SLA_INVALID'; throw error;
    }
    if (!username || username.length > 100) throw new TypeError('actorUsername is required');
    const overdue = await allAsync(
      `SELECT i.id AS item_id, i.batch_id
       FROM financial_reconciliation_items i
       INNER JOIN financial_reconciliation_batches b ON b.id=i.batch_id AND b.merchant_id=i.merchant_id AND b.store_id=i.store_id
       LEFT JOIN financial_reconciliation_exception_cases c ON c.item_id=i.id AND c.merchant_id=i.merchant_id AND c.store_id=i.store_id
       WHERE i.merchant_id=? AND i.store_id=? AND i.match_status='exception'
         AND COALESCE(c.status,'open') IN ('open','in_progress')
         AND TIMESTAMPDIFF(SECOND,b.imported_at,CURRENT_TIMESTAMP(3)) >= ? * 3600
       ORDER BY b.imported_at ASC,i.id ASC LIMIT 500`,
      [merchant,store,sla]
    );
    let created=0;
    await withTransaction(async()=>{
      for(const row of overdue){
        const itemId=Number(row.item_id),batchId=Number(row.batch_id);
        const inserted=await runAsync(`INSERT IGNORE INTO financial_reconciliation_exception_alerts
          (merchant_id,store_id,batch_id,item_id,alert_type,sla_hours,status)
          VALUES (?,?,?,?,'sla_overdue',?,'pending')`,[merchant,store,batchId,itemId,sla]);
        if(!Number(inserted?.affectedRows||0)) continue;
        created++;
        const alert=await getAsync('SELECT id FROM financial_reconciliation_exception_alerts WHERE merchant_id=? AND store_id=? AND item_id=? AND alert_type=? AND sla_hours=?',[merchant,store,itemId,'sla_overdue',sla]);
        if(!alert) throw new Error('created SLA alert could not be read');
        const alertId=Number(alert.id),reason='SLA threshold exceeded ('+sla+' hours)',key='generated-'+sla+'-'+itemId;
        const digest=stableHash({merchant,store,alertId,action:'generated',sla});
        const prev=await getAsync('SELECT event_hash FROM financial_reconciliation_exception_alert_events WHERE alert_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',[alertId]);
        const previousHash=prev?.event_hash||'';
        const eventHash=stableHash({alertId,merchant,store,actor,username,action:'generated',reason,key,digest,previousHash});
        await runAsync(`INSERT INTO financial_reconciliation_exception_alert_events
          (alert_id,merchant_id,store_id,actor_admin_id,actor_username,action,reason,idempotency_key,request_sha256,previous_hash,event_hash)
          VALUES (?,?,?,?,?,'generated',?,?,?,?,?)`,
        [alertId,merchant,store,actor,username,reason,key,digest,previousHash,eventHash]);
      }
    });
    return {slaHours:sla,scanned:overdue.length,created,alreadyExisted:overdue.length-created};
  }

  async function listSlaAlerts({ merchantId, storeId, status='pending', limit=50, afterId=0 }) {
    const merchant=positiveId(merchantId,'merchantId'),store=positiveId(storeId,'storeId');
    const bounded=Number(limit),cursor=Number(afterId),normalized=String(status||'pending').toLowerCase();
    if(!Number.isSafeInteger(bounded)||bounded<1||bounded>100||!Number.isSafeInteger(cursor)||cursor<0){
      const error=new TypeError('alert pagination is invalid');error.code='EXCEPTION_ALERT_PAGINATION_INVALID';throw error;
    }
    const filters=['a.merchant_id=?','a.store_id=?','a.id<?'],params=[merchant,store,cursor||Number.MAX_SAFE_INTEGER];
    if(normalized!=='all'){
      if(!['pending','acknowledged','dismissed'].includes(normalized)){const error=new TypeError('alert status is invalid');error.code='EXCEPTION_ALERT_FILTER_INVALID';throw error;}
      filters.push('a.status=?');params.push(normalized);
    }
    const rows=await allAsync(`SELECT a.id,a.batch_id,a.item_id,a.alert_type,a.sla_hours,a.status,a.generated_at,
      a.acknowledged_by_admin_id,a.acknowledged_by_username,a.acknowledged_at,a.acknowledgement_reason,
      i.exception_category,i.currency_code,i.amount_minor,i.external_reference,c.assigned_admin_username,
      GREATEST(0,TIMESTAMPDIFF(SECOND,b.imported_at,CURRENT_TIMESTAMP(3))) AS age_seconds
      FROM financial_reconciliation_exception_alerts a
      INNER JOIN financial_reconciliation_items i ON i.id=a.item_id AND i.merchant_id=a.merchant_id AND i.store_id=a.store_id
      INNER JOIN financial_reconciliation_batches b ON b.id=a.batch_id AND b.merchant_id=a.merchant_id AND b.store_id=a.store_id
      LEFT JOIN financial_reconciliation_exception_cases c ON c.item_id=i.id AND c.merchant_id=i.merchant_id AND c.store_id=i.store_id
      WHERE ${filters.join(' AND ')} ORDER BY a.id DESC LIMIT ?`,[...params,bounded+1]);
    const hasMore=rows.length>bounded;if(hasMore)rows.pop();
    return {nextCursor:hasMore&&rows.length?Number(rows[rows.length-1].id):null,items:rows.map(row=>({
      alertId:Number(row.id),batchId:Number(row.batch_id),itemId:Number(row.item_id),alertType:row.alert_type,
      slaHours:Number(row.sla_hours),status:row.status,generatedAt:row.generated_at,
      acknowledgedByAdminId:row.acknowledged_by_admin_id===null?null:Number(row.acknowledged_by_admin_id),
      acknowledgedByUsername:row.acknowledged_by_username||null,acknowledgedAt:row.acknowledged_at,
      acknowledgementReason:row.acknowledgement_reason,category:row.exception_category||null,
      currencyCode:row.currency_code,amountMinor:Number(row.amount_minor),externalReference:row.external_reference||null,
      assignedAdminUsername:row.assigned_admin_username||null,ageSeconds:Number(row.age_seconds||0)
    }))};
  }


  async function listSlaAlertHistory({ merchantId, storeId, alertId, limit = 50, afterId = 0 }) {
    const merchant=positiveId(merchantId,'merchantId'),store=positiveId(storeId,'storeId'),alert=positiveId(alertId,'alertId');
    const bounded=Number(limit),cursor=Number(afterId);
    if(!Number.isSafeInteger(bounded)||bounded<1||bounded>100||!Number.isSafeInteger(cursor)||cursor<0){const error=new TypeError('alert history pagination is invalid');error.code='EXCEPTION_ALERT_PAGINATION_INVALID';throw error;}
    const owner=await getAsync('SELECT id FROM financial_reconciliation_exception_alerts WHERE id=? AND merchant_id=? AND store_id=?',[alert,merchant,store]);
    if(!owner){const error=new Error('alert not found');error.code='EXCEPTION_ALERT_NOT_FOUND';throw error;}
    const rows=await allAsync(`SELECT id,actor_admin_id,actor_username,action,reason,idempotency_key,request_sha256,previous_hash,event_hash,created_at
      FROM financial_reconciliation_exception_alert_events WHERE alert_id=? AND merchant_id=? AND store_id=? AND id<?
      ORDER BY id DESC LIMIT ?`,[alert,merchant,store,cursor||Number.MAX_SAFE_INTEGER,bounded+1]);
    const hasMore=rows.length>bounded;if(hasMore)rows.pop();
    return {alertId:alert,nextCursor:hasMore&&rows.length?Number(rows[rows.length-1].id):null,items:rows.map(row=>({
      eventId:Number(row.id),actorAdminId:Number(row.actor_admin_id),actorUsername:row.actor_username,action:row.action,
      reason:row.reason,idempotencyKey:row.idempotency_key,requestHash:row.request_sha256,
      previousHash:row.previous_hash||'',eventHash:row.event_hash,createdAt:row.created_at}))};
  }

  async function acknowledgeSlaAlert(input) {
    const merchant=positiveId(input.merchantId,'merchantId'),store=positiveId(input.storeId,'storeId');
    const actor=positiveId(input.actorId,'actorId'),alertId=positiveId(input.alertId,'alertId');
    const username=String(input.actorUsername||'').trim(),reason=normalizeReason(input.reason),key=String(input.idempotencyKey||'').trim();
    if(!/^[A-Za-z0-9._:-]{16,128}$/.test(key)){const error=new TypeError('idempotencyKey must contain 16 to 128 safe characters');error.code='EXCEPTION_ALERT_IDEMPOTENCY_INVALID';throw error;}
    const digest=stableHash({merchant,store,actor,alertId,reason,action:'acknowledged'});
    return withTransaction(async()=>{
      const replay=await getAsync('SELECT id,request_sha256,event_hash FROM financial_reconciliation_exception_alert_events WHERE alert_id=? AND idempotency_key=? FOR UPDATE',[alertId,key]);
      if(replay){if(replay.request_sha256!==digest){const error=new Error('idempotency key conflict');error.code='EXCEPTION_ALERT_IDEMPOTENCY_CONFLICT';throw error;}return {eventId:Number(replay.id),eventHash:replay.event_hash,replayed:true};}
      const alert=await getAsync('SELECT id,status FROM financial_reconciliation_exception_alerts WHERE id=? AND merchant_id=? AND store_id=? FOR UPDATE',[alertId,merchant,store]);
      if(!alert){const error=new Error('alert not found');error.code='EXCEPTION_ALERT_NOT_FOUND';throw error;}
      if(alert.status!=='pending'){const error=new Error('alert is no longer pending');error.code='EXCEPTION_ALERT_STATE_CONFLICT';throw error;}
      await runAsync(`UPDATE financial_reconciliation_exception_alerts SET status='acknowledged',
        acknowledged_by_admin_id=?,acknowledged_by_username=?,acknowledged_at=CURRENT_TIMESTAMP(3),acknowledgement_reason=?
        WHERE id=? AND merchant_id=? AND store_id=? AND status='pending'`,[actor,username,reason,alertId,merchant,store]);
      const prev=await getAsync('SELECT event_hash FROM financial_reconciliation_exception_alert_events WHERE alert_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',[alertId]);
      const previousHash=prev?.event_hash||'',eventHash=stableHash({alertId,merchant,store,actor,username,action:'acknowledged',reason,key,digest,previousHash});
      const result=await runAsync(`INSERT INTO financial_reconciliation_exception_alert_events
        (alert_id,merchant_id,store_id,actor_admin_id,actor_username,action,reason,idempotency_key,request_sha256,previous_hash,event_hash)
        VALUES (?,?,?,?,?,'acknowledged',?,?,?,?,?)`,[alertId,merchant,store,actor,username,reason,key,digest,previousHash,eventHash]);
      return {eventId:Number(result.insertId||result.lastID||0),eventHash,replayed:false};
    });
  }

  async function dismissSlaAlert(input) {
    const merchant=positiveId(input.merchantId,'merchantId'),store=positiveId(input.storeId,'storeId');
    const actor=positiveId(input.actorId,'actorId'),alertId=positiveId(input.alertId,'alertId');
    const username=String(input.actorUsername||'').trim(),reason=normalizeReason(input.reason),key=String(input.idempotencyKey||'').trim();
    if(!username||username.length>100) throw new TypeError('actorUsername is required');
    if(!/^[A-Za-z0-9._:-]{16,128}$/.test(key)){const error=new TypeError('idempotencyKey must contain 16 to 128 safe characters');error.code='EXCEPTION_ALERT_IDEMPOTENCY_INVALID';throw error;}
    const digest=stableHash({merchant,store,actor,alertId,reason,action:'dismissed'});
    return withTransaction(async()=>{
      const replay=await getAsync('SELECT id,request_sha256,event_hash FROM financial_reconciliation_exception_alert_events WHERE alert_id=? AND idempotency_key=? FOR UPDATE',[alertId,key]);
      if(replay){if(replay.request_sha256!==digest){const error=new Error('idempotency key conflict');error.code='EXCEPTION_ALERT_IDEMPOTENCY_CONFLICT';throw error;}return {eventId:Number(replay.id),eventHash:replay.event_hash,replayed:true};}
      const alert=await getAsync('SELECT id,status FROM financial_reconciliation_exception_alerts WHERE id=? AND merchant_id=? AND store_id=? FOR UPDATE',[alertId,merchant,store]);
      if(!alert){const error=new Error('alert not found');error.code='EXCEPTION_ALERT_NOT_FOUND';throw error;}
      if(alert.status!=='pending'){const error=new Error('alert is no longer pending');error.code='EXCEPTION_ALERT_STATE_CONFLICT';throw error;}
      const changed=await runAsync("UPDATE financial_reconciliation_exception_alerts SET status='dismissed' WHERE id=? AND merchant_id=? AND store_id=? AND status='pending'",[alertId,merchant,store]);
      if(Number(changed?.affectedRows??changed?.changes??1)!==1){const error=new Error('alert is no longer pending');error.code='EXCEPTION_ALERT_STATE_CONFLICT';throw error;}
      const prev=await getAsync('SELECT event_hash FROM financial_reconciliation_exception_alert_events WHERE alert_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',[alertId]);
      const previousHash=prev?.event_hash||'',eventHash=stableHash({alertId,merchant,store,actor,username,action:'dismissed',reason,key,digest,previousHash});
      const result=await runAsync(`INSERT INTO financial_reconciliation_exception_alert_events
        (alert_id,merchant_id,store_id,actor_admin_id,actor_username,action,reason,idempotency_key,request_sha256,previous_hash,event_hash)
        VALUES (?,?,?,?,?,'dismissed',?,?,?,?,?)`,[alertId,merchant,store,actor,username,reason,key,digest,previousHash,eventHash]);
      return {eventId:Number(result.insertId||result.lastID||0),eventHash,replayed:false};
    });
  }

  async function transitionExceptionCase({
    merchantId, storeId, batchId, itemId, actorId, actorUsername,
    action, assignedAdminId, reason, idempotencyKey
  }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const batch = positiveId(batchId, 'batchId');
    const item = positiveId(itemId, 'itemId');
    const actor = positiveId(actorId, 'actorId');
    const username = String(actorUsername || '').trim();
    const note = String(reason || '').trim();
    const allowed = ['assign','unassign','start','add_note','resolve','reopen','close'];
    if (!allowed.includes(action)) {
      const error = new TypeError('unsupported exception workflow action');
      error.code = 'EXCEPTION_WORKFLOW_ACTION_INVALID';
      throw error;
    }
    if (username.length < 1 || username.length > 100 || note.length < 5 || note.length > 500) {
      const error = new TypeError('actor username or reason is invalid');
      error.code = 'EXCEPTION_WORKFLOW_INPUT_INVALID';
      throw error;
    }
    const key = String(idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9._:-]{12,128}$/.test(key)) {
      const error = new TypeError('idempotencyKey is invalid');
      error.code = 'EXCEPTION_WORKFLOW_INPUT_INVALID';
      throw error;
    }
    let assigneeId = null;
    let assigneeUsername = null;
    if (action === 'assign') {
      assigneeId = positiveId(assignedAdminId, 'assignedAdminId');
      const target = await getAsync(
        'SELECT id, username FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',
        [assigneeId, merchant]
      );
      if (!target) {
        const error = new Error('assigned administrator is not active in this merchant');
        error.code = 'EXCEPTION_WORKFLOW_ASSIGNEE_INVALID';
        throw error;
      }
      assigneeUsername = String(target.username || '').slice(0, 100);
    } else if (assignedAdminId !== undefined && assignedAdminId !== null && assignedAdminId !== '') {
      const error = new TypeError('assignedAdminId is only allowed for assign');
      error.code = 'EXCEPTION_WORKFLOW_INPUT_INVALID';
      throw error;
    }
    const requestHash = stableHash({
      merchantId: merchant, storeId: store, batchId: batch, itemId: item,
      actorId: actor, action, assignedAdminId: assigneeId, reason: note
    });
    try {
      return await withTransaction(async () => {
        const replay = await getAsync(
          'SELECT id, request_sha256, event_hash, action, actor_admin_id FROM financial_reconciliation_exception_events WHERE merchant_id=? AND store_id=? AND item_id=? AND idempotency_key=? FOR UPDATE',
          [merchant, store, item, key]
        );
        if (replay) {
          if (Number(replay.actor_admin_id) !== actor || replay.request_sha256 !== requestHash) {
            const error = new Error('exception workflow idempotency conflict');
            error.code = 'EXCEPTION_WORKFLOW_IDEMPOTENCY_CONFLICT';
            throw error;
          }
          return { eventId: Number(replay.id), itemId: item, action: replay.action, eventHash: replay.event_hash, replayed: true };
        }
        if (typeof lockFinancialMonthPeriod === 'function') {
          await lockFinancialMonthPeriod({ merchantId: merchant, storeId: store, batchId: batch });
        }
        const itemRow = await getAsync(
          `SELECT i.id, i.batch_id, i.match_status, b.status AS batch_status
           FROM financial_reconciliation_items i
           INNER JOIN financial_reconciliation_batches b
             ON b.id=i.batch_id AND b.merchant_id=i.merchant_id AND b.store_id=i.store_id
           WHERE i.id=? AND i.batch_id=? AND i.merchant_id=? AND i.store_id=? FOR UPDATE`,
          [item, batch, merchant, store]
        );
        if (!itemRow || itemRow.match_status !== 'exception') {
          const error = new Error('exception item not found in this merchant and store');
          error.code = 'EXCEPTION_WORKFLOW_NOT_FOUND';
          throw error;
        }
        if (itemRow.batch_status === 'closed') {
          const error = new Error('closed reconciliation batches cannot be changed');
          error.code = 'EXCEPTION_WORKFLOW_BATCH_CLOSED';
          throw error;
        }
        await runAsync(
          `INSERT INTO financial_reconciliation_exception_cases
             (merchant_id, store_id, batch_id, item_id, status, created_by_admin_id, updated_by_admin_id)
           VALUES (?, ?, ?, ?, 'open', ?, ?)
           ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
          [merchant, store, batch, item, actor, actor]
        );
        const current = await getAsync(
          'SELECT id, batch_id, status, assigned_admin_id, assigned_admin_username, resolution_note FROM financial_reconciliation_exception_cases WHERE merchant_id=? AND store_id=? AND item_id=? FOR UPDATE',
          [merchant, store, item]
        );
        if (!current || Number(current.batch_id || batch) !== batch) {
          const error = new Error('exception case not found');
          error.code = 'EXCEPTION_WORKFLOW_NOT_FOUND';
          throw error;
        }
        const before = {
          status: current.status, assignedAdminId: current.assigned_admin_id === null ? null : Number(current.assigned_admin_id),
          assignedAdminUsername: current.assigned_admin_username || null,
          resolutionNote: current.resolution_note || null
        };
        const after = { ...before };
        if (action === 'assign') {
          if (current.status === 'closed') {
            const error = new Error('closed exception cases cannot be reassigned');
            error.code = 'EXCEPTION_WORKFLOW_STATE_CONFLICT';
            throw error;
          }
          after.assignedAdminId = assigneeId;
          after.assignedAdminUsername = assigneeUsername;
        } else if (action === 'unassign') {
          if (current.status === 'closed' || !current.assigned_admin_id) {
            const error = new Error('exception case cannot be unassigned in its current state');
            error.code = 'EXCEPTION_WORKFLOW_STATE_CONFLICT';
            throw error;
          }
          after.assignedAdminId = null;
          after.assignedAdminUsername = null;
        } else if (action === 'start') {
          if (current.status !== 'open') {
            const error = new Error('only open exception cases can be started');
            error.code = 'EXCEPTION_WORKFLOW_STATE_CONFLICT';
            throw error;
          }
          after.status = 'in_progress';
        } else if (action === 'resolve') {
          if (!['open','in_progress'].includes(current.status)) {
            const error = new Error('only open or in-progress exception cases can be resolved');
            error.code = 'EXCEPTION_WORKFLOW_STATE_CONFLICT';
            throw error;
          }
          after.status = 'resolved';
          after.resolutionNote = note;
        } else if (action === 'close') {
          if (current.status !== 'resolved') {
            const error = new Error('only resolved exception cases can be closed');
            error.code = 'EXCEPTION_WORKFLOW_STATE_CONFLICT';
            throw error;
          }
          after.status = 'closed';
        } else if (action === 'reopen') {
          if (!['resolved','closed'].includes(current.status)) {
            const error = new Error('only resolved or closed exception cases can be reopened');
            error.code = 'EXCEPTION_WORKFLOW_STATE_CONFLICT';
            throw error;
          }
          after.status = 'open';
          after.resolutionNote = null;
        }
        await runAsync(
          `UPDATE financial_reconciliation_exception_cases
           SET status=?, assigned_admin_id=?, assigned_admin_username=?, resolution_note=?, updated_by_admin_id=?
           WHERE id=? AND merchant_id=? AND store_id=? AND item_id=?`,
          [after.status, after.assignedAdminId, after.assignedAdminUsername, after.resolutionNote, actor,
            current.id, merchant, store, item]
        );
        const previous = await getAsync(
          'SELECT event_hash FROM financial_reconciliation_exception_events WHERE merchant_id=? AND store_id=? AND item_id=? ORDER BY id DESC LIMIT 1',
          [merchant, store, item]
        );
        const previousHash = previous?.event_hash || '';
        const eventHash = stableHash({
          previousHash, merchantId: merchant, storeId: store, batchId: batch, itemId: item,
          actorId: actor, actorUsername: username, action, reason: note, before, after,
          idempotencyKey: key, requestHash
        });
        const inserted = await runAsync(
          `INSERT INTO financial_reconciliation_exception_events
            (merchant_id, store_id, batch_id, item_id, actor_admin_id, actor_username, action,
             reason, before_json, after_json, idempotency_key, request_sha256, previous_hash, event_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [merchant, store, batch, item, actor, username, action, note,
            JSON.stringify(before), JSON.stringify(after), key, requestHash, previousHash, eventHash]
        );
        return {
          eventId: Number(inserted.insertId || inserted.lastID), caseId: Number(current.id), itemId: item,
          action, status: after.status, assignedAdminId: after.assignedAdminId,
          assignedAdminUsername: after.assignedAdminUsername, eventHash, replayed: false
        };
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const conflict = new Error('exception workflow idempotency or case conflict');
        conflict.code = 'EXCEPTION_WORKFLOW_IDEMPOTENCY_CONFLICT';
        throw conflict;
      }
      throw error;
    }
  }


  async function listExceptionHistory({ merchantId, storeId, batchId, itemId, limit = 50, afterId = 0 }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const batch = positiveId(batchId, 'batchId');
    const item = positiveId(itemId, 'itemId');
    const boundedLimit = positiveId(limit, 'limit');
    if (boundedLimit > 100) throw new TypeError('limit must not exceed 100');
    const cursor = Number(afterId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('afterId must be a non-negative safe integer');
    const owner = await getAsync(
      `SELECT i.id FROM financial_reconciliation_items i
       INNER JOIN financial_reconciliation_batches b
         ON b.id=i.batch_id AND b.merchant_id=i.merchant_id AND b.store_id=i.store_id
       WHERE i.id=? AND i.batch_id=? AND i.merchant_id=? AND i.store_id=? AND i.match_status='exception'`,
      [item, batch, merchant, store]
    );
    if (!owner) {
      const error = new Error('exception item not found in this merchant and store');
      error.code = 'EXCEPTION_WORKFLOW_NOT_FOUND';
      throw error;
    }
    const rows = await allAsync(
      `SELECT id, actor_admin_id, actor_username, action, reason, before_json, after_json,
              previous_hash, event_hash, created_at
       FROM financial_reconciliation_exception_events
       WHERE merchant_id=? AND store_id=? AND batch_id=? AND item_id=? AND id<?
       ORDER BY id DESC LIMIT ?`,
      [merchant, store, batch, item, cursor || Number.MAX_SAFE_INTEGER, boundedLimit + 1]
    );
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    const parse = value => {
      if (value && typeof value === 'object') return value;
      if (typeof value !== 'string') return null;
      try { return JSON.parse(value); } catch (_) { return null; }
    };
    return {
      nextCursor: hasMore && rows.length ? Number(rows[rows.length - 1].id) : null,
      items: rows.map(row => ({
        eventId: Number(row.id), actorAdminId: Number(row.actor_admin_id),
        actorUsername: row.actor_username, action: row.action, reason: row.reason,
        before: parse(row.before_json), after: parse(row.after_json),
        previousHash: row.previous_hash || '', eventHash: row.event_hash, createdAt: row.created_at
      }))
    };
  }

  async function listExceptions({ merchantId, storeId, category, caseStatus, from, to, limit = 50, afterId = 0 }) {
    const merchant = positiveId(merchantId, 'merchantId');
    const store = positiveId(storeId, 'storeId');
    const boundedLimit = positiveId(limit, 'limit');
    if (boundedLimit > 100) {
      const error = new TypeError('limit must not exceed 100');
      error.code = 'REVIEW_EXCEPTION_PAGINATION_INVALID';
      throw error;
    }
    const cursor = Number(afterId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      const error = new TypeError('afterId must be a non-negative safe integer');
      error.code = 'REVIEW_EXCEPTION_PAGINATION_INVALID';
      throw error;
    }
    const categories = ['refund', 'fee', 'settlement_difference', 'chargeback', 'other'];
    const filters = ['i.merchant_id=?', 'i.store_id=?', "i.match_status='exception'", 'i.id<?'];
    const params = [merchant, store, cursor || Number.MAX_SAFE_INTEGER];
    if (caseStatus !== undefined && caseStatus !== null && caseStatus !== '' && caseStatus !== 'all') {
      const statuses = ['open','in_progress','resolved','closed'];
      const normalizedStatus = String(caseStatus).trim().toLowerCase();
      if (!statuses.includes(normalizedStatus)) {
        const error = new TypeError('unsupported exception case status');
        error.code = 'REVIEW_EXCEPTION_FILTER_INVALID';
        throw error;
      }
      filters.push("COALESCE(c.status, 'open')=?");
      params.push(normalizedStatus);
    }
    if (category !== undefined && category !== null && category !== '') {
      const normalized = String(category).trim().toLowerCase();
      if (!categories.includes(normalized)) {
        const error = new TypeError('unsupported exception category');
        error.code = 'REVIEW_EXCEPTION_FILTER_INVALID';
        throw error;
      }
      filters.push('i.exception_category=?');
      params.push(normalized);
    }
    if ((from === undefined || from === '') !== (to === undefined || to === '')) {
      const error = new TypeError('both from and to dates are required');
      error.code = 'REVIEW_EXCEPTION_DATE_RANGE_INVALID';
      throw error;
    }
    if (from !== undefined && from !== '' && to !== undefined && to !== '') {
      const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value;
      if (!validDate(from) || !validDate(to) || from > to ||
          (Date.parse(to + 'T00:00:00.000Z') - Date.parse(from + 'T00:00:00.000Z')) / 86400000 > 90) {
        const error = new TypeError('date range must be valid and no longer than 91 days');
        error.code = 'REVIEW_EXCEPTION_DATE_RANGE_INVALID';
        throw error;
      }
      const endExclusive = new Date(Date.parse(to + 'T00:00:00.000Z') + 86400000).toISOString().slice(0, 10);
      filters.push('b.imported_at>=?', 'b.imported_at<?');
      params.push(from + ' 00:00:00', endExclusive + ' 00:00:00');
    }
    const rows = await allAsync(
      `SELECT i.id, i.batch_id, i.row_no, i.external_reference, i.transaction_reference,
              i.direction, i.amount_minor, i.currency_code, i.occurred_at, i.description,
              i.exception_category, i.exception_note, i.match_reason,
              b.provider_code, b.external_batch_id, b.imported_at,
              c.id AS case_id, c.status AS case_status, c.assigned_admin_id, c.assigned_admin_username,
              c.resolution_note, c.updated_at AS case_updated_at
       FROM financial_reconciliation_items i
       INNER JOIN financial_reconciliation_batches b
         ON b.id=i.batch_id AND b.merchant_id=i.merchant_id AND b.store_id=i.store_id
       LEFT JOIN financial_reconciliation_exception_cases c
         ON c.item_id=i.id AND c.merchant_id=i.merchant_id AND c.store_id=i.store_id
       WHERE ${filters.join(' AND ')}
       ORDER BY i.id DESC LIMIT ?`,
      [...params, boundedLimit + 1]
    );
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    return {
      nextCursor: hasMore && rows.length ? Number(rows[rows.length - 1].id) : null,
      items: rows.map(row => ({
        itemId: Number(row.id), batchId: Number(row.batch_id), rowNo: Number(row.row_no),
        externalReference: row.external_reference, transactionReference: row.transaction_reference || null,
        direction: row.direction, amountMinor: Number(row.amount_minor), currencyCode: row.currency_code,
        occurredAt: row.occurred_at, description: row.description || '',
        category: row.exception_category, note: row.exception_note || null,
        matchReason: row.match_reason || null, providerCode: row.provider_code,
        externalBatchId: row.external_batch_id, importedAt: row.imported_at,
        caseId: row.case_id === null ? null : Number(row.case_id), caseStatus: row.case_status || 'open',
        assignedAdminId: row.assigned_admin_id === null ? null : Number(row.assigned_admin_id),
        assignedAdminUsername: row.assigned_admin_username || null, resolutionNote: row.resolution_note || null,
        caseUpdatedAt: row.case_updated_at || null
      }))
    };
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

  return Object.freeze({ listBatchReview, reviewItem, getDailySummary, getPeriodSummary, getExceptionOperationsSummary, getExceptionPerformanceSummary, generateSlaAlerts, listSlaAlerts, listSlaAlertHistory, acknowledgeSlaAlert, dismissSlaAlert, listExceptions, transitionExceptionCase, listExceptionHistory, listReviewHistory, getMonthlyClosePreview });
}

module.exports = { createFinancialReconciliationReviewService, normalizeReviewInput, stableHash };
