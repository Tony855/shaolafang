'use strict';

const test = require('node:test');
const registerRoutes = require('../routes/financial-reconciliation');
const assert = require('node:assert/strict');
const {
  ensureFinancialMonthCloseSchema,
  lockOpenFinancialMonthPeriod
} = require('../server/db/migrations/financial-month-close');
const {
  normalizeMonth,
  monthBounds,
  createFinancialMonthCloseService
} = require('../server/services/financial-month-close');

const periodColumnNames = [
  'id', 'merchant_id', 'store_id', 'period_month', 'currency_code', 'status',
  'pending_action', 'pending_actor_admin_id', 'pending_actor_username',
  'pending_reason', 'locked_by_admin_id', 'locked_at', 'created_at', 'updated_at'
];
const eventColumnNames = [
  'id', 'period_id', 'merchant_id', 'store_id', 'period_month', 'currency_code',
  'action', 'actor_admin_id', 'actor_username', 'reason', 'before_status',
  'after_status', 'idempotency_key', 'request_sha256', 'previous_hash',
  'event_hash', 'created_at'
];

function memoryDb(readiness = { batch_count: 2, statement_row_count: 8, unresolved_count: 0 }, options = {}) {
  const periods = new Map();
  const events = [];
  let nextPeriodId = 1;
  let nextEventId = 1;
  const keyOf = (merchant, store, month, currency) => [merchant, store, month, currency].join(':');

  async function runAsync(sql, params = []) {
    if (sql.includes('INSERT INTO financial_month_close_periods')) {
      const key = keyOf(...params.slice(0, 4));
      if (!periods.has(key)) {
        periods.set(key, {
          id: nextPeriodId++, merchant_id: params[0], store_id: params[1],
          period_month: params[2], currency_code: params[3], status: 'open',
          pending_action: null, pending_actor_admin_id: null,
          pending_actor_username: null, pending_reason: null,
          locked_by_admin_id: null, locked_at: null
        });
      }
      return { insertId: periods.get(key).id, lastID: periods.get(key).id };
    }
    if (sql.includes('UPDATE financial_month_close_periods')) {
      const period = [...periods.values()].find(item => item.id === Number(params[params.length - 1]));
      assert.ok(period, 'period update must target an existing row');
      period.status = params[0];
      if (sql.includes("pending_action='close'") || sql.includes("pending_action='reopen'")) {
        period.pending_action = sql.includes("pending_action='close'") ? 'close' : 'reopen';
        period.pending_actor_admin_id = params[1];
        period.pending_actor_username = params[2];
        period.pending_reason = params[3];
      } else {
        period.pending_action = null;
        period.pending_actor_admin_id = null;
        period.pending_actor_username = null;
        period.pending_reason = null;
        if (sql.includes('locked_by_admin_id=?')) {
          period.locked_by_admin_id = params[1];
          period.locked_at = '2026-11-12 12:00:00.000';
        }
        if (sql.includes('locked_by_admin_id=NULL')) {
          period.locked_by_admin_id = null;
          period.locked_at = null;
        }
      }
      return { affectedRows: 1 };
    }
    if (sql.includes('INSERT INTO financial_month_close_events')) {
      if (options.failEventInsert) throw new Error('simulated immutable audit insert failure');
      const row = {
        id: nextEventId++, period_id: params[0], merchant_id: params[1], store_id: params[2],
        period_month: params[3], currency_code: params[4], action: params[5],
        actor_admin_id: params[6], actor_username: params[7], reason: params[8],
        before_status: params[9], after_status: params[10],
        idempotency_key: params[11], request_sha256: params[12],
        previous_hash: params[13], event_hash: params[14], created_at: '2026-11-12 12:00:00.000'
      };
      events.push(row);
      return { insertId: row.id, lastID: row.id };
    }
    throw new Error('unexpected SQL write: ' + sql);
  }

  async function getAsync(sql, params = []) {
    if (sql.includes('FROM financial_month_close_periods') && sql.includes('FOR UPDATE')) {
      return periods.get(keyOf(...params)) || null;
    }
    if (sql.includes('FROM financial_month_close_periods')) {
      return periods.get(keyOf(...params)) || null;
    }
    if (sql.includes('FROM financial_month_close_events') && sql.includes('idempotency_key')) {
      return events.find(event => event.period_id === Number(params[0]) && event.idempotency_key === params[1]) || null;
    }
    if (sql.includes('SELECT event_hash FROM financial_month_close_events')) {
      return [...events].reverse().find(event => event.period_id === Number(params[0])) || null;
    }
    if (sql.includes('COUNT(DISTINCT b.id)')) return readiness;
    throw new Error('unexpected SQL read: ' + sql);
  }

  async function allAsync(sql, params = []) {
    if (sql.includes('FROM financial_month_close_events')) {
      const [merchant, store, month, currency, cursor, limit] = params;
      return events.filter(event => event.merchant_id === merchant && event.store_id === store &&
        event.period_month === month && event.currency_code === currency && event.id < cursor)
        .sort((a, b) => b.id - a.id).slice(0, limit);
    }
    throw new Error('unexpected SQL list: ' + sql);
  }

  async function withTransaction(work) {
    const periodSnapshot = new Map([...periods].map(([key, value]) => [key, { ...value }]));
    const eventSnapshot = events.map(event => ({ ...event }));
    const periodSequence = nextPeriodId;
    const eventSequence = nextEventId;
    try {
      return await work();
    } catch (error) {
      periods.clear();
      for (const [key, value] of periodSnapshot) periods.set(key, value);
      events.splice(0, events.length, ...eventSnapshot);
      nextPeriodId = periodSequence;
      nextEventId = eventSequence;
      throw error;
    }
  }

  return {
    periods, events, runAsync, getAsync, allAsync, withTransaction,
    service: createFinancialMonthCloseService({ runAsync, getAsync, allAsync, withTransaction })
  };
}

function transition(db, actorId, action, idempotencyKey, overrides = {}) {
  return db.service.transition({
    merchantId: 4, storeId: 9, actorId, actorUsername: 'finance-' + actorId,
    month: '2026-11', currencyCode: 'USD', action,
    reason: 'Finance approval evidence for this transition',
    idempotencyKey, ...overrides
  });
}

test('month validation uses strict YYYY-MM and calculates half-open UTC bounds', () => {
  assert.equal(normalizeMonth('2026-11'), '2026-11');
  assert.deepEqual(monthBounds('2026-11'), {
    start: '2026-11-01 00:00:00', end: '2026-12-01 00:00:00'
  });
  for (const value of ['2026-1', '2026-13', '2026-00', '2026-11-01']) {
    assert.throws(() => normalizeMonth(value), error => error.code === 'MONTH_CLOSE_MONTH_INVALID');
  }
});

test('schema migration creates new tables and verifies compatibility against legacy databases', async () => {
  const writes = [];
  const allAsync = async sql => {
    if (sql === 'SHOW COLUMNS FROM financial_month_close_periods') return periodColumnNames.map(Field => ({ Field }));
    if (sql === 'SHOW COLUMNS FROM financial_month_close_events') return eventColumnNames.map(Field => ({ Field }));
    if (sql === 'SHOW INDEX FROM financial_month_close_periods') return [{ Key_name: 'unique_financial_month_period' }];
    if (sql === 'SHOW INDEX FROM financial_month_close_events') return [{ Key_name: 'unique_financial_month_close_idempotency' }];
    return [];
  };
  await ensureFinancialMonthCloseSchema({ runAsync: async sql => writes.push(sql), allAsync });
  assert.ok(writes.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS financial_month_close_periods')));
  assert.ok(writes.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS financial_month_close_events')));
});

test('schema migration fails closed when a pre-existing partial table lacks required columns', async () => {
  const allAsync = async sql => {
    if (sql === 'SHOW COLUMNS FROM financial_month_close_periods') return [{ Field: 'id' }];
    return [];
  };
  await assert.rejects(ensureFinancialMonthCloseSchema({ runAsync: async () => {}, allAsync }),
    /schema is incomplete/);
});

test('open-period lock helper serializes imports/reviews and rejects pending or locked periods', async () => {
  const writes = [];
  const lockedReads = [];
  await assert.rejects(lockOpenFinancialMonthPeriod({
    runAsync: async (sql, params) => writes.push({ sql, params }),
    getAsync: async (sql, params) => {
      lockedReads.push({ sql, params });
      return { id: 5, status: 'close_pending' };
    },
    merchantId: 4, storeId: 9, periodMonth: '2026-11', currencyCode: 'USD'
  }), error => error.code === 'FINANCIAL_MONTH_LOCKED');
  assert.match(writes[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(lockedReads[0].sql, /FOR UPDATE/);
});

test('close request is blocked until every imported statement row is matched', async () => {
  const db = memoryDb({ batch_count: 1, statement_row_count: 3, unresolved_count: 1 });
  await assert.rejects(transition(db, 10, 'request_close', 'month-close-request-0001'),
    error => error.code === 'MONTH_CLOSE_NOT_READY');
  assert.equal(db.events.length, 0);
  assert.equal(db.periods.size, 0);
});

test('close approval requires a different administrator and locks the period', async () => {
  const db = memoryDb();
  const requested = await transition(db, 10, 'request_close', 'month-close-request-0002');
  assert.equal(requested.status, 'close_pending');
  await assert.rejects(transition(db, 10, 'approve_close', 'month-close-approve-0001'),
    error => error.code === 'MONTH_CLOSE_MAKER_CHECKER_REQUIRED');
  assert.equal(db.events.length, 1);
  const approved = await transition(db, 11, 'approve_close', 'month-close-approve-0002');
  assert.equal(approved.status, 'locked');
  assert.equal([...db.periods.values()][0].locked_by_admin_id, 11);
});

test('reopen request and approval are two-person controlled and hash-linked', async () => {
  const db = memoryDb();
  await transition(db, 10, 'request_close', 'month-close-request-0003');
  await transition(db, 11, 'approve_close', 'month-close-approve-0003');
  const requested = await transition(db, 12, 'request_reopen', 'month-reopen-request-0001');
  assert.equal(requested.status, 'reopen_pending');
  const reopened = await transition(db, 13, 'approve_reopen', 'month-reopen-approve-0001');
  assert.equal(reopened.status, 'open');
  assert.equal([...db.periods.values()][0].locked_at, null);
  assert.equal(db.events.length, 4);
  assert.equal(db.events[1].previous_hash, db.events[0].event_hash);
  assert.equal(db.events[2].previous_hash, db.events[1].event_hash);
  assert.equal(db.events[3].previous_hash, db.events[2].event_hash);
  assert.equal(db.events[0].before_status, 'open');
  assert.equal(db.events[0].after_status, 'close_pending');
});

test('month close idempotency replays only for the original actor and unchanged request', async () => {
  const db = memoryDb();
  const first = await transition(db, 10, 'request_close', 'month-close-idempotent-01');
  const replay = await transition(db, 10, 'request_close', 'month-close-idempotent-01');
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, first.eventId);
  await assert.rejects(transition(db, 12, 'request_close', 'month-close-idempotent-01'),
    error => error.code === 'MONTH_CLOSE_IDEMPOTENCY_CONFLICT');
  assert.equal(db.events.length, 1);
});

test('month close audit history is tenant-scoped, descending, and append-only', async () => {
  const db = memoryDb();
  await transition(db, 10, 'request_close', 'month-close-history-0001');
  await transition(db, 11, 'approve_close', 'month-close-history-0002');
  const history = await db.service.listHistory({
    merchantId: 4, storeId: 9, month: '2026-11', currencyCode: 'USD', limit: 1
  });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].eventId, 2);
  assert.equal(history.nextCursor, 2);
  assert.equal(db.events.length, 2);
  assert.ok(db.events.every(event => event.event_hash.length === 64));
});


test('month close API routes require tenant context and use private responses', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async () => ({ insertId: 1, affectedRows: 1 }),
    getAsync: async () => null,
    allAsync: async () => [],
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  const handler = routes.get('GET /api/admin/financial-reconciliation/month-close/period').at(-1);
  const response = () => ({
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(body) { this.body = body; return this; }
  });
  const denied = response();
  await handler({ merchantId: 4, storeId: null, adminId: 8, query: { month: '2026-11', currencyCode: 'USD' } }, denied);
  assert.equal(denied.statusCode, 403);

  const ok = response();
  await handler({ merchantId: 4, storeId: 9, adminId: 8, query: { month: '2026-11', currencyCode: 'USD' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Cache-Control'], 'no-store, private');
  assert.equal(ok.body.period, null);
  assert.ok(routes.get('POST /api/admin/financial-reconciliation/month-close/transition').length >= 3);
});


test('audit insertion failure rolls back the period transition', async () => {
  const db = memoryDb(undefined, { failEventInsert: true });
  await assert.rejects(transition(db, 10, 'request_close', 'month-close-rollback-0001'),
    /simulated immutable audit insert failure/);
  assert.equal(db.periods.size, 0);
  assert.equal(db.events.length, 0);
});

test('close rejection reopens the period and reopen rejection preserves the lock', async () => {
  const db = memoryDb();
  await transition(db, 10, 'request_close', 'month-close-reject-close-01');
  const rejectedClose = await transition(db, 11, 'reject_close', 'month-close-reject-close-02');
  assert.equal(rejectedClose.status, 'open');
  await transition(db, 12, 'request_close', 'month-close-reject-close-03');
  await transition(db, 13, 'approve_close', 'month-close-reject-close-04');
  await transition(db, 14, 'request_reopen', 'month-close-reject-reopen-01');
  const rejectedReopen = await transition(db, 15, 'reject_reopen', 'month-close-reject-reopen-02');
  assert.equal(rejectedReopen.status, 'locked');
  assert.equal([...db.periods.values()][0].locked_by_admin_id, 13);
});

test('period status reads remain isolated to the supplied merchant and store', async () => {
  const db = memoryDb();
  await transition(db, 10, 'request_close', 'month-close-tenant-scope-01');
  const foreign = await db.service.getPeriod({
    merchantId: 99, storeId: 9, month: '2026-11', currencyCode: 'USD'
  });
  assert.equal(foreign, null);
});

test('reconciliation imports acquire the month lock before any batch write', async () => {
  const { createFinancialReconciliationService } = require('../server/services/financial-reconciliation');
  let writes = 0;
  let lockCalls = 0;
  const service = createFinancialReconciliationService({
    runAsync: async () => { writes += 1; },
    getAsync: async () => null,
    withTransaction: async work => work(),
    lockFinancialMonthPeriod: async () => {
      lockCalls += 1;
      const error = new Error('period is locked');
      error.code = 'FINANCIAL_MONTH_LOCKED';
      throw error;
    }
  });
  await assert.rejects(service.importStatementBatch({
    merchantId: 4, storeId: 9, providerCode: 'TEST', externalBatchId: 'statement-2026-11',
    statementSha256: 'a'.repeat(64), currencyCode: 'USD',
    rows: [{
      externalReference: 'ref-1', direction: 'credit', amountMinor: 100,
      occurredAt: '2026-11-12T10:00:00.000Z', currencyCode: 'USD'
    }]
  }), error => error.code === 'FINANCIAL_MONTH_LOCKED');
  assert.equal(lockCalls, 1);
  assert.equal(writes, 0);
});

test('manual reconciliation reviews acquire the month lock before batch or item mutation', async () => {
  const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
  const reads = [];
  const service = createFinancialReconciliationReviewService({
    runAsync: async () => ({ insertId: 1 }),
    getAsync: async sql => {
      reads.push(sql);
      return null;
    },
    allAsync: async () => [],
    withTransaction: async work => work(),
    lockFinancialMonthPeriod: async () => {
      const error = new Error('period is locked');
      error.code = 'FINANCIAL_MONTH_LOCKED';
      throw error;
    }
  });
  await assert.rejects(service.reviewItem({
    merchantId: 4, storeId: 9, batchId: 2, itemId: 3, actorId: 10,
    actorUsername: 'finance', action: 'reject',
    reason: 'Rejecting a row while testing period lock enforcement',
    idempotencyKey: 'month-review-locked-0001'
  }), error => error.code === 'FINANCIAL_MONTH_LOCKED');
  assert.equal(reads.length, 1);
  assert.match(reads[0], /financial_reconciliation_review_events/);
});


test('month-close lifecycle can retry after unresolved rows are cleared and then approve with a second actor', async () => {
  const readiness = { batch_count: 1, statement_row_count: 3, unresolved_count: 1 };
  const db = memoryDb(readiness);

  await assert.rejects(
    transition(db, 10, 'request_close', 'month-close-readiness-retry-01'),
    error => error.code === 'MONTH_CLOSE_NOT_READY' &&
      error.readiness.unresolvedCount === 1
  );
  assert.equal(db.periods.size, 0);
  assert.equal(db.events.length, 0);

  // Simulate the reconciliation review completing all rows before the close is retried.
  readiness.unresolved_count = 0;
  const requested = await transition(db, 10, 'request_close', 'month-close-readiness-retry-02');
  assert.equal(requested.status, 'close_pending');
  assert.equal(db.events.length, 1);

  const approved = await transition(db, 11, 'approve_close', 'month-close-readiness-retry-03');
  assert.equal(approved.status, 'locked');
  assert.equal(db.events.length, 2);
  assert.equal(db.events[0].after_status, 'close_pending');
  assert.equal(db.events[1].before_status, 'close_pending');
  assert.equal(db.events[1].after_status, 'locked');
  assert.equal(db.events[1].previous_hash, db.events[0].event_hash);
  assert.equal([...db.periods.values()][0].locked_by_admin_id, 11);
});

