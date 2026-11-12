'use strict';

const crypto = require('crypto');

const ACTIONS = Object.freeze([
  'request_close', 'approve_close', 'reject_close',
  'request_reopen', 'approve_reopen', 'reject_reopen'
]);

function positiveId(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(field + ' must be a positive safe integer');
  }
  return number;
}

function normalizeMonth(value) {
  const month = String(value || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const error = new TypeError('month must use YYYY-MM');
    error.code = 'MONTH_CLOSE_MONTH_INVALID';
    throw error;
  }
  return month;
}

function normalizeCurrency(value) {
  const currencyCode = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    const error = new TypeError('currencyCode must be a three-letter code');
    error.code = 'MONTH_CLOSE_CURRENCY_INVALID';
    throw error;
  }
  return currencyCode;
}

function normalizeReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 5 || reason.length > 500) {
    const error = new TypeError('reason must contain 5 to 500 characters');
    error.code = 'MONTH_CLOSE_REASON_INVALID';
    throw error;
  }
  return reason;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) {
    const error = new TypeError('idempotency key must contain 16 to 128 safe characters');
    error.code = 'MONTH_CLOSE_IDEMPOTENCY_INVALID';
    throw error;
  }
  return key;
}

function monthBounds(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  return { start: month + '-01 00:00:00', end: end + ' 00:00:00' };
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stateConflict(message) {
  const error = new Error(message);
  error.code = 'MONTH_CLOSE_STATE_CONFLICT';
  return error;
}

function assertDifferentApprover(period, actorId) {
  if (Number(period.pending_actor_admin_id) === actorId) {
    const error = new Error('the requester cannot approve or reject their own request');
    error.code = 'MONTH_CLOSE_MAKER_CHECKER_REQUIRED';
    throw error;
  }
}

function createFinancialMonthCloseService({ runAsync, getAsync, allAsync, withTransaction }) {
  for (const [name, fn] of Object.entries({ runAsync, getAsync, allAsync, withTransaction })) {
    if (typeof fn !== 'function') throw new TypeError(name + ' dependency is required');
  }

  async function ensurePeriod({ merchantId, storeId, month, currencyCode }) {
    await runAsync(
      `INSERT INTO financial_month_close_periods
        (merchant_id, store_id, period_month, currency_code, status)
       VALUES (?, ?, ?, ?, 'open')
       ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
      [merchantId, storeId, month, currencyCode]
    );
    const period = await getAsync(
      `SELECT id, merchant_id, store_id, period_month, currency_code, status,
              pending_action, pending_actor_admin_id, pending_actor_username,
              pending_reason, locked_by_admin_id, locked_at
       FROM financial_month_close_periods
       WHERE merchant_id=? AND store_id=? AND period_month=? AND currency_code=?
       FOR UPDATE`,
      [merchantId, storeId, month, currencyCode]
    );
    if (!period) throw new Error('financial month close period could not be locked');
    return period;
  }

  async function getReadiness({ merchantId, storeId, month, currencyCode }) {
    const bounds = monthBounds(month);
    const row = await getAsync(
      `SELECT COUNT(DISTINCT b.id) AS batch_count,
              COUNT(i.id) AS statement_row_count,
              COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND i.match_status<>'matched' THEN 1 ELSE 0 END), 0) AS unresolved_count
       FROM financial_reconciliation_batches b
       LEFT JOIN financial_reconciliation_items i
         ON i.batch_id=b.id AND i.merchant_id=b.merchant_id AND i.store_id=b.store_id
       WHERE b.merchant_id=? AND b.store_id=? AND b.currency_code=?
         AND b.imported_at>=? AND b.imported_at<?`,
      [merchantId, storeId, currencyCode, bounds.start, bounds.end]
    );
    return {
      batchCount: Number(row?.batch_count || 0),
      statementRowCount: Number(row?.statement_row_count || 0),
      unresolvedCount: Number(row?.unresolved_count || 0)
    };
  }

  async function appendEvent({ period, action, actorId, actorUsername, reason, beforeStatus, afterStatus, idempotencyKey, requestHash }) {
    const previous = await getAsync(
      'SELECT event_hash FROM financial_month_close_events WHERE period_id=? ORDER BY id DESC LIMIT 1 FOR UPDATE',
      [period.id]
    );
    const previousHash = previous?.event_hash || '';
    const eventHash = stableHash({
      periodId: Number(period.id), action, actorId, actorUsername, reason,
      beforeStatus, afterStatus, idempotencyKey, requestHash, previousHash
    });
    const result = await runAsync(
      `INSERT INTO financial_month_close_events
        (period_id, merchant_id, store_id, period_month, currency_code, action,
         actor_admin_id, actor_username, reason, before_status, after_status,
         idempotency_key, request_sha256, previous_hash, event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [period.id, period.merchant_id, period.store_id, period.period_month,
        period.currency_code, action, actorId, actorUsername, reason,
        beforeStatus, afterStatus, idempotencyKey, requestHash, previousHash, eventHash]
    );
    return { eventId: Number(result.insertId || result.lastID), eventHash, previousHash };
  }

  async function transition(input) {
    const merchantId = positiveId(input.merchantId, 'merchantId');
    const storeId = positiveId(input.storeId, 'storeId');
    const actorId = positiveId(input.actorId, 'actorId');
    const actorUsername = String(input.actorUsername || '').trim();
    if (!actorUsername || actorUsername.length > 100) throw new TypeError('actorUsername is required');
    const month = normalizeMonth(input.month);
    const currencyCode = normalizeCurrency(input.currencyCode);
    const action = String(input.action || '').trim().toLowerCase();
    if (!ACTIONS.includes(action)) {
      const error = new TypeError('unsupported month close action');
      error.code = 'MONTH_CLOSE_ACTION_INVALID';
      throw error;
    }
    const reason = normalizeReason(input.reason);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const requestHash = stableHash({ merchantId, storeId, month, currencyCode, action, reason });

    return withTransaction(async () => {
      const period = await ensurePeriod({ merchantId, storeId, month, currencyCode });
      const replay = await getAsync(
        `SELECT id, actor_admin_id, request_sha256, event_hash, action
         FROM financial_month_close_events
         WHERE period_id=? AND idempotency_key=? FOR UPDATE`,
        [period.id, idempotencyKey]
      );
      if (replay) {
        if (Number(replay.actor_admin_id) !== actorId || replay.request_sha256 !== requestHash) {
          const error = new Error('idempotency key was already used by another actor or request');
          error.code = 'MONTH_CLOSE_IDEMPOTENCY_CONFLICT';
          throw error;
        }
        return {
          periodId: Number(period.id), eventId: Number(replay.id),
          action: replay.action, status: period.status, eventHash: replay.event_hash, replayed: true
        };
      }

      const beforeStatus = period.status;
      let afterStatus = beforeStatus;
      let updateSql;
      let updateParams;

      if (action === 'request_close') {
        if (beforeStatus !== 'open') throw stateConflict('only an open month can request close');
        const readiness = await getReadiness({ merchantId, storeId, month, currencyCode });
        if (readiness.batchCount < 1 || readiness.statementRowCount < 1 || readiness.unresolvedCount !== 0) {
          const error = new Error('month close requires at least one batch and every statement row matched');
          error.code = 'MONTH_CLOSE_NOT_READY';
          error.readiness = readiness;
          throw error;
        }
        afterStatus = 'close_pending';
        updateSql = `UPDATE financial_month_close_periods
          SET status=?, pending_action='close', pending_actor_admin_id=?,
              pending_actor_username=?, pending_reason=? WHERE id=?`;
        updateParams = [afterStatus, actorId, actorUsername, reason, period.id];
      } else if (action === 'approve_close' || action === 'reject_close') {
        if (beforeStatus !== 'close_pending' || period.pending_action !== 'close') {
          throw stateConflict('there is no pending close request');
        }
        assertDifferentApprover(period, actorId);
        if (action === 'approve_close') {
          const readiness = await getReadiness({ merchantId, storeId, month, currencyCode });
          if (readiness.batchCount < 1 || readiness.statementRowCount < 1 || readiness.unresolvedCount !== 0) {
            const error = new Error('month close readiness changed while approval was pending');
            error.code = 'MONTH_CLOSE_NOT_READY';
            error.readiness = readiness;
            throw error;
          }
          afterStatus = 'locked';
          updateSql = `UPDATE financial_month_close_periods
            SET status=?, pending_action=NULL, pending_actor_admin_id=NULL,
                pending_actor_username=NULL, pending_reason=NULL,
                locked_by_admin_id=?, locked_at=CURRENT_TIMESTAMP(3) WHERE id=?`;
          updateParams = [afterStatus, actorId, period.id];
        } else {
          afterStatus = 'open';
          updateSql = `UPDATE financial_month_close_periods
            SET status=?, pending_action=NULL, pending_actor_admin_id=NULL,
                pending_actor_username=NULL, pending_reason=NULL WHERE id=?`;
          updateParams = [afterStatus, period.id];
        }
      } else if (action === 'request_reopen') {
        if (beforeStatus !== 'locked') throw stateConflict('only a locked month can request reopening');
        afterStatus = 'reopen_pending';
        updateSql = `UPDATE financial_month_close_periods
          SET status=?, pending_action='reopen', pending_actor_admin_id=?,
              pending_actor_username=?, pending_reason=? WHERE id=?`;
        updateParams = [afterStatus, actorId, actorUsername, reason, period.id];
      } else {
        if (beforeStatus !== 'reopen_pending' || period.pending_action !== 'reopen') {
          throw stateConflict('there is no pending reopen request');
        }
        assertDifferentApprover(period, actorId);
        if (action === 'approve_reopen') {
          afterStatus = 'open';
          updateSql = `UPDATE financial_month_close_periods
            SET status=?, pending_action=NULL, pending_actor_admin_id=NULL,
                pending_actor_username=NULL, pending_reason=NULL,
                locked_by_admin_id=NULL, locked_at=NULL WHERE id=?`;
          updateParams = [afterStatus, period.id];
        } else {
          afterStatus = 'locked';
          updateSql = `UPDATE financial_month_close_periods
            SET status=?, pending_action=NULL, pending_actor_admin_id=NULL,
                pending_actor_username=NULL, pending_reason=NULL WHERE id=?`;
          updateParams = [afterStatus, period.id];
        }
      }

      await runAsync(updateSql, updateParams);
      const event = await appendEvent({
        period, action, actorId, actorUsername, reason,
        beforeStatus, afterStatus, idempotencyKey, requestHash
      });
      return {
        periodId: Number(period.id), eventId: event.eventId, action,
        status: afterStatus, eventHash: event.eventHash, replayed: false
      };
    });
  }

  async function getPeriod({ merchantId, storeId, month, currencyCode }) {
    const owner = [positiveId(merchantId, 'merchantId'), positiveId(storeId, 'storeId'), normalizeMonth(month), normalizeCurrency(currencyCode)];
    const period = await getAsync(
      `SELECT id, period_month, currency_code, status, pending_action,
              pending_actor_admin_id, pending_actor_username, pending_reason,
              locked_by_admin_id, locked_at, created_at, updated_at
       FROM financial_month_close_periods
       WHERE merchant_id=? AND store_id=? AND period_month=? AND currency_code=?`,
      owner
    );
    if (!period) return null;
    return {
      periodId: Number(period.id), month: period.period_month, currencyCode: period.currency_code,
      status: period.status, pendingAction: period.pending_action || null,
      pendingActorAdminId: period.pending_actor_admin_id === null ? null : Number(period.pending_actor_admin_id),
      pendingActorUsername: period.pending_actor_username || null,
      pendingReason: period.pending_reason || null,
      lockedByAdminId: period.locked_by_admin_id === null ? null : Number(period.locked_by_admin_id),
      lockedAt: period.locked_at || null, createdAt: period.created_at, updatedAt: period.updated_at
    };
  }

  async function listHistory({ merchantId, storeId, month, currencyCode, limit = 50, afterId = 0 }) {
    const owner = [positiveId(merchantId, 'merchantId'), positiveId(storeId, 'storeId'), normalizeMonth(month), normalizeCurrency(currencyCode)];
    const boundedLimit = Number(limit);
    const cursor = Number(afterId);
    if (!Number.isSafeInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > 200 ||
        !Number.isSafeInteger(cursor) || cursor < 0) {
      const error = new TypeError('month close history pagination is invalid');
      error.code = 'MONTH_CLOSE_PAGINATION_INVALID';
      throw error;
    }
    const rows = await allAsync(
      `SELECT id, period_id, action, actor_admin_id, actor_username, reason,
              before_status, after_status, idempotency_key, previous_hash, event_hash, created_at
       FROM financial_month_close_events
       WHERE merchant_id=? AND store_id=? AND period_month=? AND currency_code=?
         AND id<?
       ORDER BY id DESC LIMIT ?`,
      [...owner, cursor || Number.MAX_SAFE_INTEGER, boundedLimit + 1]
    );
    const hasMore = rows.length > boundedLimit;
    if (hasMore) rows.pop();
    return {
      items: rows.map(row => ({
        eventId: Number(row.id), periodId: Number(row.period_id), action: row.action,
        actorAdminId: Number(row.actor_admin_id), actorUsername: row.actor_username,
        reason: row.reason, beforeStatus: row.before_status, afterStatus: row.after_status,
        idempotencyKey: row.idempotency_key, previousHash: row.previous_hash,
        eventHash: row.event_hash, createdAt: row.created_at
      })),
      nextCursor: hasMore && rows.length ? Number(rows[rows.length - 1].id) : null
    };
  }

  return Object.freeze({ transition, getPeriod, listHistory });
}

module.exports = {
  ACTIONS,
  normalizeMonth,
  normalizeCurrency,
  normalizeReason,
  normalizeIdempotencyKey,
  monthBounds,
  stableHash,
  createFinancialMonthCloseService
};
