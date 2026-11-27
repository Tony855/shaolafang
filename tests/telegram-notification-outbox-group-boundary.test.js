'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const poolModule = require('../server/db/pool');
const { markTelegramNotificationSending } = require('../server/services/telegram-notification-outbox');

const workerId = '123e4567-e89b-42d3-a456-426614174000';

function fakePool({ store = true, destination = true, subscription = true, chatId = '-1007654321', botEnabled = '1' } = {}) {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push({ kind: 'query', sql });
      return [[], []];
    },
    async execute(sql, params) {
      calls.push({ kind: 'execute', sql, params });
      if (sql.includes('FROM settings')) return [[{ value: botEnabled }], []];
      if (sql.includes('FROM merchants')) return [[{ id: 7 }], []];
      if (sql.includes('FROM stores')) return [store ? [{ id: 9 }] : [], []];
      if (sql.includes('FROM telegram_chat_destinations')) return [destination ? [{ id: 21, chat_id: chatId }] : [], []];
      if (sql.includes('FROM telegram_store_subscriptions')) return [subscription ? [{ id: 31 }] : [], []];
      if (sql.includes("SET state='dead'")) return [{ affectedRows: 1, insertId: 0 }, []];
      if (sql.includes("SET state='sending'")) return [{ affectedRows: 1, insertId: 0 }, []];
      return [{ affectedRows: 1, insertId: 0 }, []];
    },
    release() { calls.push({ kind: 'release' }); }
  };
  return { pool: { async getConnection() { return connection; } }, calls };
}

async function withFakePool(options, work) {
  const previous = poolModule.pool;
  const fake = fakePool(options);
  poolModule.setPool(fake.pool);
  try {
    return await work(fake.calls);
  } finally {
    poolModule.setPool(previous);
  }
}

test('group subscription send boundary locks store, destination, subscription, then outbox', async () => {
  await withFakePool({}, async calls => {
    const result = await markTelegramNotificationSending(88, workerId, 60, {
      scope: 'merchant_store',
      key: 'destination:21:store:9',
      merchantId: 7,
      storeId: 9,
      eventType: 'order.created',
      expectedChatId: '-1007654321'
    });
    assert.equal(result, true);
    const sql = calls.filter(call => call.kind === 'execute').map(call => call.sql);
    const storeIndex = sql.findIndex(query => query.includes('FROM stores'));
    const destinationIndex = sql.findIndex(query => query.includes('FROM telegram_chat_destinations'));
    const subscriptionIndex = sql.findIndex(query => query.includes('FROM telegram_store_subscriptions'));
    const outboxIndex = sql.findIndex(query => query.includes("SET state='sending'"));
    assert.ok(storeIndex >= 0 && destinationIndex > storeIndex && subscriptionIndex > destinationIndex && outboxIndex > subscriptionIndex);
    assert.match(sql[subscriptionIndex], /notify_order_created=1/);
  });
});

test('group send boundary dead-letters a disabled or removed subscription before sending', async () => {
  await withFakePool({ subscription: false }, async calls => {
    const result = await markTelegramNotificationSending(88, workerId, 60, {
      scope: 'merchant_store',
      key: 'destination:21:store:9',
      merchantId: 7,
      storeId: 9,
      eventType: 'order.refunded',
      expectedChatId: '-1007654321'
    });
    assert.equal(result, false);
    const sql = calls.filter(call => call.kind === 'execute').map(call => call.sql);
    assert.ok(sql.some(query => query.includes("SET state='dead'")));
    assert.equal(sql.some(query => query.includes("SET state='sending'")), false);
  });
});

test('group send boundary rejects a changed destination Chat ID after recipient resolution', async () => {
  await withFakePool({ chatId: '-1009999999' }, async calls => {
    const result = await markTelegramNotificationSending(88, workerId, 60, {
      scope: 'merchant_store',
      key: 'destination:21:store:9',
      merchantId: 7,
      storeId: 9,
      eventType: 'order.created',
      expectedChatId: '-1007654321'
    });
    assert.equal(result, false);
    const sql = calls.filter(call => call.kind === 'execute').map(call => call.sql);
    assert.ok(sql.some(query => query.includes("SET state='dead'")));
    assert.equal(sql.some(query => query.includes("SET state='sending'")), false);
  });
});


test('disabled Admin Bot is rechecked before a group job can cross the send boundary', async () => {
  await withFakePool({ botEnabled: '0' }, async calls => {
    const result = await markTelegramNotificationSending(88, workerId, 60, {
      scope: 'merchant_store',
      key: 'destination:21:store:9',
      merchantId: 7,
      storeId: 9,
      eventType: 'order.created',
      expectedChatId: '-1007654321'
    });
    assert.equal(result, false);
    const sql = calls.filter(call => call.kind === 'execute').map(call => call.sql);
    assert.equal(sql.some(query => query.includes('FROM stores')), false);
    assert.ok(sql.some(query => query.includes("SET state='dead'")));
    assert.equal(sql.some(query => query.includes("SET state='sending'")), false);
  });
});
