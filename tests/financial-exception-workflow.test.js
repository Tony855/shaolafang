'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
const registerRoutes = require('../routes/financial-reconciliation');

function workflowDb({ failAudit = false } = {}) {
  const caseRow = {
    id: 7, merchant_id: 4, store_id: 9, batch_id: 2, item_id: 11,
    status: 'open', assigned_admin_id: null, assigned_admin_username: null,
    resolution_note: null, created_by_admin_id: 6, updated_by_admin_id: 6
  };
  let exists = false;
  let nextEventId = 1;
  const events = [];
  const service = createFinancialReconciliationReviewService({
    runAsync: async (sql, params = []) => {
      if (sql.includes('INSERT INTO financial_reconciliation_exception_cases')) {
        if (!exists) exists = true;
        return { insertId: 7, affectedRows: 1 };
      }
      if (sql.includes('UPDATE financial_reconciliation_exception_cases')) {
        Object.assign(caseRow, {
          status: params[0], assigned_admin_id: params[1], assigned_admin_username: params[2],
          resolution_note: params[3], updated_by_admin_id: params[4]
        });
        return { affectedRows: 1 };
      }
      if (sql.includes('INSERT INTO financial_reconciliation_exception_events')) {
        if (failAudit) throw new Error('simulated immutable exception audit failure');
        const event = {
          id: nextEventId++, merchant_id: params[0], store_id: params[1], batch_id: params[2],
          item_id: params[3], actor_admin_id: params[4], actor_username: params[5],
          action: params[6], reason: params[7], before_json: params[8], after_json: params[9],
          idempotency_key: params[10], request_sha256: params[11],
          previous_hash: params[12], event_hash: params[13]
        };
        events.push(event);
        return { insertId: event.id, affectedRows: 1 };
      }
      throw new Error('unexpected run SQL: ' + sql);
    },
    getAsync: async (sql, params = []) => {
      if (sql.includes('FROM merchant_admins')) {
        return Number(params[0]) === 55 && Number(params[1]) === 4
          ? { id: 55, username: 'finance-reviewer' } : null;
      }
      if (sql.includes('FROM financial_reconciliation_exception_events') && sql.includes('idempotency_key')) {
        return events.find(event => event.merchant_id === params[0] && event.store_id === params[1] &&
          event.item_id === params[2] && event.idempotency_key === params[3]) || null;
      }
      if (sql.includes('FROM financial_reconciliation_items i')) {
        return Number(params[0]) === 11 && Number(params[1]) === 2 &&
          Number(params[2]) === 4 && Number(params[3]) === 9
          ? { id: 11, batch_id: 2, match_status: 'exception', batch_status: 'imported' } : null;
      }
      if (sql.includes('FROM financial_reconciliation_exception_cases')) {
        return exists ? { ...caseRow } : null;
      }
      if (sql.includes('SELECT event_hash FROM financial_reconciliation_exception_events')) {
        return events.length ? { event_hash: events[events.length - 1].event_hash } : null;
      }
      throw new Error('unexpected get SQL: ' + sql);
    },
    allAsync: async (sql, params = []) => {
      if (sql.includes('FROM financial_reconciliation_exception_events')) {
        return events.filter(event => event.merchant_id === params[0] && event.store_id === params[1] &&
          event.batch_id === params[2] && event.item_id === params[3] && event.id < params[4])
          .sort((a, b) => b.id - a.id).slice(0, params[5]);
      }
      return [];
    },
    withTransaction: async work => {
      const snapshot = { exists, row: { ...caseRow }, events: events.slice(), nextEventId };
      try { return await work(); }
      catch (error) {
        exists = snapshot.exists;
        Object.assign(caseRow, snapshot.row);
        events.splice(0, events.length, ...snapshot.events);
        nextEventId = snapshot.nextEventId;
        throw error;
      }
    }
  });
  return { service, caseRow, events };
}

const input = (overrides = {}) => ({
  merchantId: 4, storeId: 9, batchId: 2, itemId: 11,
  actorId: 6, actorUsername: 'finance-owner', reason: 'Verified supporting bank evidence',
  idempotencyKey: 'exception-workflow-0001', ...overrides
});

test('exception case supports assignment, start, notes, resolution, close, and reopen with a hash chain', async () => {
  const db = workflowDb();
  const assigned = await db.service.transitionExceptionCase(input({ action: 'assign', assignedAdminId: 55 }));
  assert.equal(assigned.assignedAdminId, 55);
  assert.equal(assigned.assignedAdminUsername, 'finance-reviewer');
  await db.service.transitionExceptionCase(input({ action: 'start', idempotencyKey: 'exception-workflow-0002' }));
  await db.service.transitionExceptionCase(input({ action: 'add_note', reason: 'Checked the statement attachment', idempotencyKey: 'exception-workflow-0003' }));
  await db.service.transitionExceptionCase(input({ action: 'resolve', reason: 'Bank confirmed the fee amount', idempotencyKey: 'exception-workflow-0004' }));
  assert.equal(db.caseRow.status, 'resolved');
  assert.equal(db.caseRow.resolution_note, 'Bank confirmed the fee amount');
  await db.service.transitionExceptionCase(input({ action: 'close', idempotencyKey: 'exception-workflow-0005' }));
  assert.equal(db.caseRow.status, 'closed');
  await db.service.transitionExceptionCase(input({ action: 'reopen', idempotencyKey: 'exception-workflow-0006' }));
  assert.equal(db.caseRow.status, 'open');
  assert.equal(db.caseRow.resolution_note, null);
  assert.equal(db.events.length, 6);
  assert.equal(db.events[0].previous_hash, '');
  for (let i = 1; i < db.events.length; i++) {
    assert.equal(db.events[i].previous_hash, db.events[i - 1].event_hash);
  }
  assert.ok(db.events.every(event => /^[a-f0-9]{64}$/.test(event.event_hash)));
});

test('exception workflow audit history is tenant-scoped, paginated, and returns hash-linked snapshots', async () => {
  const db = workflowDb();
  await db.service.transitionExceptionCase(input({ action: 'start' }));
  await db.service.transitionExceptionCase(input({ action: 'resolve', idempotencyKey: 'exception-history-0002' }));
  const history = await db.service.listExceptionHistory({
    merchantId: 4, storeId: 9, batchId: 2, itemId: 11, limit: 1
  });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].action, 'resolve');
  assert.equal(history.items[0].before.status, 'in_progress');
  assert.equal(history.items[0].after.status, 'resolved');
  assert.equal(history.nextCursor, 2);
  const older = await db.service.listExceptionHistory({
    merchantId: 4, storeId: 9, batchId: 2, itemId: 11, limit: 1, afterId: history.nextCursor
  });
  assert.equal(older.items[0].action, 'start');
  assert.equal(older.nextCursor, null);
  await assert.rejects(db.service.listExceptionHistory({
    merchantId: 99, storeId: 9, batchId: 2, itemId: 11
  }), error => error.code === 'EXCEPTION_WORKFLOW_NOT_FOUND');
});

test('exception workflow idempotency replays only for the same actor and request', async () => {
  const db = workflowDb();
  const first = await db.service.transitionExceptionCase(input({ action: 'start' }));
  const replay = await db.service.transitionExceptionCase(input({ action: 'start' }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, first.eventId);
  await assert.rejects(db.service.transitionExceptionCase(input({
    actorId: 7, actorUsername: 'other-admin', action: 'start'
  })), error => error.code === 'EXCEPTION_WORKFLOW_IDEMPOTENCY_CONFLICT');
  assert.equal(db.events.length, 1);
});

test('exception workflow rejects invalid assignees and illegal state transitions', async () => {
  const db = workflowDb();
  await assert.rejects(db.service.transitionExceptionCase(input({
    action: 'assign', assignedAdminId: 999
  })), error => error.code === 'EXCEPTION_WORKFLOW_ASSIGNEE_INVALID');
  await assert.rejects(db.service.transitionExceptionCase(input({
    action: 'close'
  })), error => error.code === 'EXCEPTION_WORKFLOW_STATE_CONFLICT');
  assert.equal(db.events.length, 0);
});

test('exception workflow rolls back the case mutation when immutable audit insertion fails', async () => {
  const db = workflowDb({ failAudit: true });
  await assert.rejects(db.service.transitionExceptionCase(input({ action: 'start' })),
    /simulated immutable exception audit failure/);
  assert.equal(db.caseRow.status, 'open');
  assert.equal(db.events.length, 0);
});

test('exception workflow route enforces tenant context and active actor identity', async () => {
  const routes = new Map();
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); }
  };
  registerRoutes(app, {
    runAsync: async () => ({ insertId: 1, affectedRows: 1 }),
    getAsync: async (sql, params) => sql.includes('FROM merchant_admins') && params[0] === 6
      ? { username: 'finance-owner' } : null,
    allAsync: async () => [],
    withTransaction: async work => work(),
    requireAdminKey: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  });
  const handler = routes.get('POST /api/admin/financial-reconciliation/exceptions/:itemId/workflow').at(-1);
  const response = () => ({
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  });
  const denied = response();
  await handler({ merchantId: 4, storeId: null, adminId: 6, params: { itemId: '11' }, body: {}, get: () => null }, denied);
  assert.equal(denied.statusCode, 403);
  const invalid = response();
  await handler({
    merchantId: 4, storeId: 9, adminId: 6, params: { itemId: '11' },
    body: { batchId: 2, action: 'invented', reason: 'This is a sufficiently long reason', idempotencyKey: 'exception-route-0001' },
    get: () => null
  }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test('exception audit history route enforces tenant context and private responses', async () => {
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
  const handler = routes.get('GET /api/admin/financial-reconciliation/exceptions/:itemId/history').at(-1);
  const denied = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler({ merchantId: 4, storeId: null, adminId: 6, params: { itemId: '11' }, query: {} }, denied);
  assert.equal(denied.statusCode, 403);
});

test('exception queue console includes workflow filters, controls, and APIs in generated bundle', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const moduleSource = fs.readFileSync(path.join(root, 'pages/admin/financial-reconciliation.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  for (const action of ['assign','unassign','start','add_note','resolve','close','reopen']) {
    assert.ok(moduleSource.includes('data-exception-action="' + action + '"'));
  }
  assert.ok(moduleSource.includes('/admin/financial-reconciliation/exceptions?'));
  assert.ok(moduleSource.includes('/workflow'));
  assert.ok(moduleSource.includes('/history?'));
  assert.ok(bundle.includes(moduleSource));
  assert.match(html, /id="financeExceptionQueue"/);
  assert.match(html, /id="financeExceptionStatus"/);
});
