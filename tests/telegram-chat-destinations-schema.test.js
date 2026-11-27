'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TELEGRAM_CHAT_DESTINATIONS_SCHEMA_SQL,
  TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL,
  ensureTelegramChatDestinationSchema
} = require('../server/db/migrations/telegram-chat-destinations');

test('Telegram destination schema enforces globally unique Chat IDs and merchant ownership', () => {
  assert.match(TELEGRAM_CHAT_DESTINATIONS_SCHEMA_SQL, /UNIQUE KEY uq_telegram_chat_destination_chat_id \(chat_id\)/);
  assert.match(TELEGRAM_CHAT_DESTINATIONS_SCHEMA_SQL, /FOREIGN KEY \(merchant_id\) REFERENCES merchants \(id\)/);
  assert.match(TELEGRAM_CHAT_DESTINATIONS_SCHEMA_SQL, /UNIQUE KEY uq_telegram_chat_destination_merchant_id \(merchant_id, id\)/);
});

test('Telegram store subscriptions enforce same-merchant destination and store ownership', () => {
  assert.match(TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL, /UNIQUE KEY uq_telegram_store_subscription_destination_store \(destination_id, store_id\)/);
  assert.match(TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL, /FOREIGN KEY \(merchant_id, destination_id\)[\s\S]*REFERENCES telegram_chat_destinations \(merchant_id, id\)/);
  assert.match(TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL, /FOREIGN KEY \(merchant_id, store_id\)[\s\S]*REFERENCES stores \(merchant_id, id\)/);
  assert.match(TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL, /notify_order_created/);
  assert.match(TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL, /notify_settled/);
  assert.match(TELEGRAM_STORE_SUBSCRIPTIONS_SCHEMA_SQL, /notify_refunded/);
});

test('Telegram destination migration creates the composite store index before dependent tables', async () => {
  const statements = [];
  await ensureTelegramChatDestinationSchema({
    runAsync: async sql => { statements.push(sql); }
  });
  assert.equal(statements.length, 3);
  assert.match(statements[0], /ALTER TABLE stores ADD UNIQUE KEY/);
  assert.match(statements[1], /CREATE TABLE IF NOT EXISTS telegram_chat_destinations/);
  assert.match(statements[2], /CREATE TABLE IF NOT EXISTS telegram_store_subscriptions/);
});

test('Telegram destination migration only ignores an already-existing index', async () => {
  const statements = [];
  await assert.rejects(
    ensureTelegramChatDestinationSchema({
      runAsync: async sql => {
        statements.push(sql);
        if (sql.startsWith('ALTER TABLE')) throw new Error('access denied');
      }
    }),
    /access denied/
  );
  assert.equal(statements.length, 1);
});
