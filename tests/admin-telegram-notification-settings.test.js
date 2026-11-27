'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
function setup({ globalBotEnabled = '1', recipient = null, merchant = true, store = true, runError = null } = {}) {
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
    runAsync: async (sql, params) => { calls.push({ type: 'run', sql, params }); if (runError && sql.includes(runError.match)) throw runError.error; return { affectedRows: 1 }; },
    withTransaction: async fn => fn(),
    requireAdminKey: pass,
    requirePermission: () => pass,
    getClientIp: () => '127.0.0.1'
  });
  return { routes, calls };
}

test('store Telegram settings GET reflects the persisted disabled state for the active request store', async () => {
  const { routes, calls } = setup({ recipient: { chat_id: '-100123', is_enabled: 0, notify_order_created: 0, notify_settled: 1, notify_refunded: 1 } });
  const res = response();
  await routes.get('GET /api/admin/telegram/notification-settings').at(-1)({ merchantId: 7, storeId: 9 }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.chatId, '-100123');
  assert.equal(res.body.notifyOrderCreated, false);
  assert.deepEqual(calls[0].params, [7, 9]);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
});

test('a Chat ID alone automatically enables the current store binding even for legacy disabled rows', async () => {
  const { routes } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { chatId: '-100123' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.chatId, '-100123');
});

test('store Telegram settings reject a store outside the authenticated tenant', async () => {
  const { routes, calls } = setup({ store: false });
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { chatId: '-100123' }
  }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO telegram_store_admin_recipients')), false);
});

test('store Telegram settings PUT saves only the current tenant and audits no chat ID or token', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, adminId: 5, body: {
      chatId: '-100123', notifyOrderCreated: true, notifySettled: false, notifyRefunded: true
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

test('store Chat ID binding can be saved before the platform Bot is activated', async () => {
  const { routes, calls } = setup({ globalBotEnabled: '0' });
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { chatId: '-100123' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
  assert.ok(calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO telegram_store_admin_recipients')));
});

test('store Telegram settings reject malformed Chat IDs before writes', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { chatId: 'not a chat id' }
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
      chatId: '-100123',
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
    chatId: '-100123',
    notifyOrderCreated: true, notifySettled: true, notifyRefunded: true
  } }, enabled);
  assert.equal(enabled.statusCode, 200);
  assert.equal(calls.some(call => call.type === 'run' && call.sql.includes('UPDATE telegram_notification_outbox')), false);
});


test('unexpected store recipient database failures log only safe stage metadata', async () => {
  const { routes } = setup({
    runError: { match: 'INSERT INTO telegram_store_admin_recipients', error: Object.assign(new Error('sensitive database detail'), { code: 'ER_BAD_FIELD_ERROR', errno: 1054, sqlState: '42S22' }) }
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const res = response();
    await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
      merchantId: 7, storeId: 9, adminId: 5,
      body: { enabled: false, chatId: '7147843724' }
    }, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /所有更改已回滚/);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[telegram-store-notification-settings] save failed');
    assert.deepEqual(logs[0][1], {
      stage: 'recipient_upsert', code: 'ER_BAD_FIELD_ERROR', errno: 1054, sqlState: '42S22'
    });
    assert.equal(JSON.stringify(logs).includes('7147843724'), false);
    assert.equal(JSON.stringify(logs).includes('sensitive database detail'), false);
  } finally {
    console.error = originalError;
  }
});


test('store settings UI uses Chat ID as the only default binding control', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin', 'settings.js'), 'utf8');
  assert.match(html, /填写并保存 Chat ID 即自动绑定当前门店/);
  assert.doesNotMatch(html, /id="telegramStoreNotifyEnabled"/);
  assert.doesNotMatch(source, /telegramStoreNotifyEnabled/);
});

test('server injects the client IP helper required by transactional settings audits', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(
    serverSource,
    /require\(['"]\.\/routes\/admin-settings\.js['"]\)\(app,\s*\{[^}]*\bgetClientIp\b[^}]*\}\)/
  );
});


test('legacy store settings suppression cannot kill new destination-scoped jobs', async () => {
  const { routes, calls } = setup();
  const res = response();
  await routes.get('PUT /api/admin/telegram/notification-settings').at(-1)({
    merchantId: 7, storeId: 9, body: { chatId: '', notifyOrderCreated: false }
  }, res);
  assert.equal(res.statusCode, 200);
  const suppression = calls.find(call => call.type === 'run' && call.sql.includes('UPDATE telegram_notification_outbox'));
  assert.ok(suppression);
  assert.deepEqual(suppression.params, [7, 9, 'store:9']);
  assert.match(suppression.sql, /recipient_key=\\?/);
});
