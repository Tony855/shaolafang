'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyGroupChat,
  backfillTelegramStoreSubscriptions
} = require('../server/db/migrations/telegram-store-subscription-backfill');

test('legacy group Chat IDs are classified without treating private chats as groups', () => {
  assert.equal(classifyGroupChat('-1001234567890'), 'supergroup');
  assert.equal(classifyGroupChat('-123456789'), 'group');
  assert.equal(classifyGroupChat('123456789'), null);
  assert.equal(classifyGroupChat(''), null);
});

test('legacy backfill creates one merchant destination and multiple store subscriptions idempotently', async () => {
  const rows = [
    { id: 1, merchant_id: 7, store_id: 11, chat_id: '-100111', is_enabled: 1, notify_order_created: 1, notify_settled: 0, notify_refunded: 1, matched_store_id: 11 },
    { id: 2, merchant_id: 7, store_id: 12, chat_id: '-100111', is_enabled: 0, notify_order_created: 0, notify_settled: 1, notify_refunded: 0, matched_store_id: 12 }
  ];
  const destinations = new Map();
  const subscriptions = new Map();
  const conflicts = [];
  const ledger = new Set();
  const calls = [];
  const deps = {
    allAsync: async () => rows,
    getAsync: async (sql, [key]) => {
      if (sql.includes('telegram_chat_destination_migration_ledger')) return ledger.has(key) ? { legacy_recipient_id: key } : null;
      return destinations.get(key) || null;
    },
    runAsync: async (sql, params = []) => {
      calls.push(sql);
      if (sql.includes('INSERT INTO telegram_chat_destinations')) {
        if (!destinations.has(params[1])) destinations.set(params[1], { id: destinations.size + 1, merchant_id: params[0] });
        return { affectedRows: 1 };
      }
      if (sql.includes('INSERT INTO telegram_chat_destination_migration_ledger')) { ledger.add(params[0]); return { affectedRows: 1 }; }
      if (sql.includes('INSERT INTO telegram_store_subscriptions')) {
        const key = params[1] + ':' + params[2];
        if (!subscriptions.has(key)) { subscriptions.set(key, params); return { affectedRows: 1 }; }
        return { affectedRows: 0 };
      }
      if (sql.includes('INSERT INTO telegram_chat_destination_migration_conflicts')) conflicts.push(params);
      return { affectedRows: 1 };
    },
    withTransaction: async fn => fn()
  };
  const first = await backfillTelegramStoreSubscriptions(deps);
  subscriptions.clear();
  const migratedRows = [...subscriptions.values()];
  assert.deepEqual(migratedRows[0].slice(3), [1, 1, 0, 1]);
  assert.deepEqual(migratedRows[1].slice(3), [0, 0, 1, 0]);
  const second = await backfillTelegramStoreSubscriptions(deps);
  assert.equal(first.destinationsCreated, 1);
  assert.equal(first.subscriptionsCreated, 2);
  assert.equal(second.subscriptionsCreated, 0);
  assert.equal(second.alreadyMigrated, 2);
  assert.equal(destinations.size, 1);
  assert.equal(subscriptions.size, 0);
  assert.equal(ledger.size, 2);
  assert.equal(conflicts.length, 0);
});

test('legacy backfill refuses a Chat ID already owned by another merchant', async () => {
  const rows = [{ id: 3, merchant_id: 8, store_id: 20, chat_id: '-100222', is_enabled: 1, notify_order_created: 1, notify_settled: 1, notify_refunded: 1, matched_store_id: 20 }];
  const conflicts = [];
  const deps = {
    allAsync: async () => rows,
    getAsync: async sql => sql.includes('telegram_chat_destination_migration_ledger') ? null : ({ id: 9, merchant_id: 7 }),
    runAsync: async (sql, params = []) => {
      if (sql.includes('INSERT INTO telegram_chat_destination_migration_conflicts')) conflicts.push(params);
      return { affectedRows: 1 };
    },
    withTransaction: async fn => fn()
  };
  const result = await backfillTelegramStoreSubscriptions(deps);
  assert.equal(result.conflicts, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0][5], 'chat_owned_by_another_merchant');
});
