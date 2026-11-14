'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerAdminSettings = require('../routes/admin-settings');

const pass = (req, res, next) => next && next();
function response() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}
function setup({ globalBotEnabled = '1', recipient = null, merchant = true, store = true } = {}) {
  const routes = new Map();
  const calls = [];
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); },
    put(path, ...handlers) { routes.set('PUT ' + path, handlers); },
    delete(path, ...handlers) { routes.set('DELETE ' + path, handlers); }
  };
  registerAdminSettings(app, {
    getAsync: async (sql, params) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM telegram_store_admin_recipients')) return recipient;
      if (sql.includes('FROM merchants')) return merchant ? { id: 7 } : null;
      if (sql.includes('FROM stores')) return store ? { id: 9 } : null;
      if (sql.includes('FROM merchant_admins')) return { username: 'manager' };
      if (sql.includes("telegram_admin_bot_enabled")) return { value: globalBotEnabled };
      return null;
    },
    allAsync: async () => [
      { key: 'telegram_admin_bot_enabled', value: globalBotEnabled },
      { key: 'telegram_admin_bot_token', value: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi' }
    ],
    runAsync: async (sql, params) => { calls.push({ type: 'run', sql, params }); return { affectedRows: 1 }; },
    withTransaction: async fn => fn(),
    requireAdminKey: pass,
    requirePermission: () => pass,
    getClientIp: () => '127.0.0.1'
  });
  return { routes, calls };
}

test('store Telegram settings GET is restricted to the active request merchant and store', async () => {
  const { routes, calls } = setup({ recipient: { chat_id: '-100123', is_enabled: 1, notify_order_created: 0, notify_settled: 1, notify_refunded: 1 } });
  const res = response();
  await routes.get('GET /api/admin/telegram/notification-settings').at(-1)({ merchantId: 7, storeId: 9 }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.chatId, '-100123');
  assert.equal(res.body.notifyOrderCreated, false);
  assert.deepEqual(calls[0].params, [7, 9]);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
});

test('store Telegram settings PUT saves only the current tenant and audits no chat ID or token', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, adminId: 5, body: {
      enabled: true, chatId: '-100123', notifyOrderCreated: true, notifySettled: false, notifyRefunded: true
    }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const upsert = calls.find(call => call.type === 'run' && call.sql.includes('INSERT INTO telegram_store_admin_recipients'));
  assert.ok(upsert);
  assert.deepEqual(upsert.params.slice(0, 7), [7, 9, '-100123', 1, 1, 0, 1]);
  const audit = calls.find(call => call.type === 'run' && call.sql.includes('INSERT INTO audit_logs'));
  assert.ok(audit);
  assert.equal(JSON.stringify(audit.params).includes('-100123'), false);
  assert.equal(JSON.stringify(audit.params).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), false);
});

test('store Telegram settings cannot be enabled without the global admin Bot', async () => {
  const { routes } = setup({ globalBotEnabled: '0' });
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { enabled: true, chatId: '-100123' }
  }, res);
  assert.equal(res.statusCode, 409);
});

test('store Telegram settings reject malformed Chat IDs before writes', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { enabled: true, chatId: 'not a chat id' }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('telegram_store_admin_recipients')), false);
});


test('disabling a store terminally suppresses its queued store-admin notifications only', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { enabled: false, chatId: '' }
  }, res);
  assert.equal(res.statusCode, 200);
  const suppression = calls.find(call => call.type === 'run' && call.sql.includes('UPDATE telegram_notification_outbox'));
  assert.ok(suppression);
  assert.match(suppression.sql, /recipient_scope='merchant_store'/);
  assert.match(suppression.sql, /merchant_id=\? AND store_id=\?/);
  assert.match(suppression.sql, /state IN \('pending','processing'\)/);
  assert.deepEqual(suppression.params, [7, 9]);
});

test('disabling one store event toggle suppresses only that event for that tenant', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: {
      enabled: true, chatId: '-100123',
      notifyOrderCreated: true, notifySettled: false, notifyRefunded: true
    }
  }, res);
  assert.equal(res.statusCode, 200);
  const suppressions = calls.filter(call => call.type === 'run' && call.sql.includes('UPDATE telegram_notification_outbox'));
  assert.equal(suppressions.length, 1);
  assert.match(suppressions[0].sql, /recipient_scope='merchant_store'/);
  assert.match(suppressions[0].sql, /event_type=\?/);
  assert.deepEqual(suppressions[0].params, [7, 9, 'order.settled']);
});

test('re-enabling store notifications does not revive dead-lettered backlog', async () => {
  const { routes, calls } = setup();
  const handler = routes.get('PUT /api/admin/telegram/notification-settings').at(-1);
  const disabled = response();
  await handler({ merchantId: 7, storeId: 9, body: { enabled: false, chatId: '' } }, disabled);
  assert.equal(disabled.statusCode, 200);
  calls.length = 0;

  const enabled = response();
  await handler({ merchantId: 7, storeId: 9, body: {
    enabled: true, chatId: '-100123',
    notifyOrderCreated: true, notifySettled: true, notifyRefunded: true
  } }, enabled);
  assert.equal(enabled.statusCode, 200);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('UPDATE telegram_notification_outbox')), false);
});
