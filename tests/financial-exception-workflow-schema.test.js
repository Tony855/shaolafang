'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureFinancialExceptionWorkflowSchema } = require('../server/db/migrations/financial-month-close');

test('exception workflow schema creates tenant-scoped case and immutable event tables', async () => {
  const statements = [];
  const allAsync = async sql => {
    if (sql.includes('SHOW COLUMNS FROM financial_reconciliation_exception_cases')) {
      return ['id','merchant_id','store_id','batch_id','item_id','status','assigned_admin_id',
        'assigned_admin_username','resolution_note','created_by_admin_id','updated_by_admin_id','created_at','updated_at']
        .map(Field => ({ Field }));
    }
    if (sql.includes('SHOW COLUMNS FROM financial_reconciliation_exception_events')) {
      return ['id','merchant_id','store_id','batch_id','item_id','actor_admin_id','actor_username','action',
        'reason','before_json','after_json','idempotency_key','request_sha256','previous_hash','event_hash','created_at']
        .map(Field => ({ Field }));
    }
    throw new Error('unexpected SQL: ' + sql);
  };
  await ensureFinancialExceptionWorkflowSchema({ runAsync: async sql => statements.push(sql), allAsync });
  assert.equal(statements.length, 2);
  assert.match(statements[0], /UNIQUE KEY unique_finance_exception_case_item/);
  assert.match(statements[0], /KEY idx_finance_exception_case_queue/);
  assert.match(statements[1], /UNIQUE KEY unique_finance_exception_event_idempotency/);
  assert.match(statements[1], /KEY idx_finance_exception_event_history/);
  assert.match(statements[1], /ON DELETE RESTRICT/);
});

test('exception workflow schema fails closed when an existing table is incomplete', async () => {
  let calls = 0;
  await assert.rejects(ensureFinancialExceptionWorkflowSchema({
    runAsync: async () => {},
    allAsync: async () => {
      calls += 1;
      return calls === 1 ? [{ Field: 'id' }] : [];
    }
  }), /financial exception case schema is incomplete/);
});
