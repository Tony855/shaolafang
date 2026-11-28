'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/customer-delivery');
const { createStoreEntrySignature, createTenantStoreEntrySignature } = require('../server/services/telegram-store-entry');
const { encryptBotToken } = require('../server/services/telegram-bot-credentials');

const TELEGRAM_BOT_TOKEN = '123456:abcdefghijklmnopqrstuvwxyzABCDE';
const TELEGRAM_NOW = Math.floor(Date.now() / 1000);
function signedInitData(botToken = TELEGRAM_BOT_TOKEN) {
  const values = new Map([['auth_date', String(TELEGRAM_NOW)], ['query_id', 'AAE-order-test'], ['user', JSON.stringify({ id: 987654321, first_name: 'Test' })]]);
  const data = Array.from(values.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => key + '=' + value).join('\n');
  const secret = require('node:crypto').createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  values.set('hash', require('node:crypto').createHmac('sha256', secret).update(data).digest('hex'));
  return new URLSearchParams(Array.from(values.entries()).sort(([a], [b]) => a.localeCompare(b))).toString();
}

function setup({ customerBinding = false, tenantBot = null } = {}) {
  const handlers = new Map();
  const calls = [];
  const events = [];
  const transactions = [];
  let orderRow = null;
  let idempotencyRecord = null;
  let transactionTail = Promise.resolve();
  const app = {
    get(path, ...handlersForRoute) { handlers.set('GET ' + path, handlersForRoute[handlersForRoute.length - 1]); },
    post(path, ...handlersForRoute) { handlers.set('POST ' + path, handlersForRoute[handlersForRoute.length - 1]); },
    delete(path, ...handlersForRoute) { handlers.set('DELETE ' + path, handlersForRoute[handlersForRoute.length - 1]); }
  };
  const deps = {
    getAsync: async (sql, params = []) => {
      calls.push({ type: 'get', sql, params });
      if (sql.includes('FROM telegram_store_admin_recipients')) return { chat_id: '-100888' };
      if (sql.includes('FROM telegram_merchant_bots')) return tenantBot;
      if (sql.includes('FROM stores s JOIN merchants')) return { id: 7, name: 'Test Store', merchant_id: 3 };
      if (sql.includes('FROM stores WHERE id=? AND merchant_id=?')) return { id: 7 };
      if (sql.includes('FROM delivery_order_requests')) return idempotencyRecord;
      if (sql.includes('SELECT * FROM orders WHERE id=? AND store_id=?')) return orderRow;
      return null;
    },
    allAsync: async (sql, params = []) => {
      calls.push({ type: 'all', sql, params });
      if (sql.includes('FROM settings')) return [
        { key: 'telegram_admin_bot_enabled', value: '0' },
        { key: 'telegram_client_bot_enabled', value: '1' },
        { key: 'telegram_client_bot_token', value: TELEGRAM_BOT_TOKEN }
      ];
      if (sql.includes('FROM merchants')) return [{ id: 3 }];
      if (sql.includes('FROM stores')) return [{ id: 7 }];
      if (sql.includes('FROM telegram_customer_bindings')) return customerBinding ? [{ id: 42 }] : [];
      return [];
    },
    runAsync: async (sql, params = []) => {
      calls.push({ type: 'run', sql, params });
      if (sql.includes('INSERT IGNORE INTO delivery_order_requests')) {
        if (!idempotencyRecord) idempotencyRecord = { store_id: params[0], idempotency_key_hash: params[1], customer_token_hash: params[2], request_hash: params[3], order_id: null };
        return { affectedRows: idempotencyRecord.order_id ? 0 : 1 };
      }
      if (sql.includes('UPDATE delivery_order_requests SET order_id')) {
        if (idempotencyRecord) idempotencyRecord.order_id = params[0];
        return { affectedRows: 1 };
      }
      if (sql.includes('INSERT INTO orders')) {
        orderRow = { id: 33, store_id: 7, merchant_id: 3, table_name: null, fulfillment_type: 'delivery', status: 'pending', total: 12.5, order_no: '11GL00001', customer_token: params[4], items: '[]' };
        return { insertId: 33, lastID: 33, affectedRows: 1 };
      }
      return { affectedRows: 1 };
    },
    withTransaction: async work => {
      let release;
      const previous = transactionTail;
      transactionTail = new Promise(resolve => { release = resolve; });
      await previous;
      transactions.push('begin');
      try { const result = await work(); transactions.push('commit'); return result; }
      catch (error) { transactions.push('rollback'); throw error; }
      finally { release(); }
    },
    normalizeOrderItems: async items => items.map(item => ({ id: item.id, name: 'Noodle', price: 12.5, base_price: 12.5, quantity: item.quantity })),
    allocateOrderNo: async prefix => prefix + '00001',
    getOrderCooldownMs: async () => 1000,
    checkAndSetCooldown: async () => true,
    getClientIp: () => '127.0.0.1',
    formatOrder: row => ({ ...row, sessionToken: '', customerToken: 'should-not-leak' }),
    io: { to(room) { return { emit(event, payload) { events.push({ room, event, payload }); } }; } },
    enqueueTelegramNotification: async input => { calls.push({ type: 'enqueue', input }); return true; }
  };
  registerRoutes(app, deps);
  return { handler: handlers.get('POST /api/public/delivery/orders'), khqrHandler: handlers.get('POST /api/public/delivery/orders/:orderId/khqr'), notifyHandler: handlers.get('POST /api/public/delivery/orders/:orderId/payment-notify'), calls, events, transactions, get orderRow() { return orderRow; } };
}

function orderRequest(body, key = 'a'.repeat(64), initData = '') {
  return { body, headers: { 'idempotency-key': key, 'x-telegram-init-data': initData }, get(name) { const normalized = name.toLowerCase(); return normalized === 'idempotency-key' ? key : normalized === 'x-telegram-init-data' ? initData : ''; } };
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

test('customer delivery order creates a tableless order and unassigned delivery job atomically', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(orderRequest({
    store_id: 7, customer_token: 'a'.repeat(64), recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }], note: 'No chili'
  }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.orderId, 33);
  assert.equal(res.body.customerToken.length, 64);
  assert.equal(res.body.trackingUrl.includes('#token='), true);
  const orderInsert = ctx.calls.find(x => x.type === 'run' && x.sql.includes('INSERT INTO orders'));
  assert.ok(orderInsert);
  assert.ok(orderInsert.sql.includes('VALUES (?, NULL,'));
  assert.equal(orderInsert.params[4].length, 64);
  assert.notEqual(orderInsert.params[4], res.body.customerToken);
  const jobInsert = ctx.calls.find(x => x.type === 'run' && x.sql.includes('INSERT INTO delivery_jobs'));
  assert.ok(jobInsert);
  assert.ok(jobInsert.sql.includes("NULL, ?, ?, ?, 'pending_assignment'"));
  assert.ok(ctx.calls.some(x => x.type === 'run' && x.sql.includes('UPDATE menus SET sales_count = sales_count + ?')));
  assert.deepEqual(ctx.transactions, ['begin', 'commit']);
  assert.ok(ctx.events.some(x => x.room === 'kitchen-7' && x.event === 'order:new'));
});

test('Telegram-originated customer delivery orders require a currently bound store entry signature', async () => {
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = 's'.repeat(40);
  const ctx = setup();
  const res = response();
  await ctx.handler(orderRequest({
    store_id: 7, customer_token: 'a'.repeat(64), telegram_entry: true, store_entry: 'A'.repeat(43),
    recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }]
  }, 'a'.repeat(64), signedInitData()), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /专属入口已失效/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO orders')), false);
});

test('Telegram-originated delivery order accepts valid shared Bot initData and current store signature', async () => {
  const previousSecret = process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET;
  process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = 's'.repeat(40);
  try {
    const ctx = setup();
    const res = response();
    const signature = createStoreEntrySignature({ storeId: 7, chatId: '-100888', secret: 's'.repeat(40) });
    await ctx.handler(orderRequest({
      store_id: 7, customer_token: 'a'.repeat(64), telegram_entry: true, store_entry: signature,
      recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
      delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
      items: [{ id: 5, quantity: 1 }]
    }, 'a'.repeat(64), signedInitData()), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.orderId, 33);
    assert.ok(ctx.calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO orders')));
  } finally {
    if (previousSecret === undefined) delete process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET;
    else process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET = previousSecret;
  }
});

test('Telegram-originated delivery orders reject missing initData before order writes', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(orderRequest({
    store_id: 7, customer_token: 'a'.repeat(64), telegram_entry: true, store_entry: 'A'.repeat(43),
    recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }]
  }), res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Telegram 身份验证缺失/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO orders')), false);
});

test('Telegram-originated delivery orders reject forged initData before order writes', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(orderRequest({
    store_id: 7, customer_token: 'a'.repeat(64), telegram_entry: true, store_entry: 'A'.repeat(43),
    recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }]
  }, 'a'.repeat(64), 'auth_date=1&user=%7B%22id%22%3A1%7D&hash=' + '0'.repeat(64)), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /统一 Client Bot 身份无效/);
  assert.equal(ctx.calls.some(call => call.type === 'run' && call.sql.includes('INSERT INTO orders')), false);
});

test('customer delivery order rejects missing recipient and address before database writes', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(orderRequest({ store_id: 7, items: [{ id: 5, quantity: 1 }] }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /收件人/);
  assert.equal(ctx.calls.some(x => x.type === 'run'), false);
  assert.deepEqual(ctx.transactions, []);
});

test('customer delivery order rejects unsupported payment methods', async () => {
  const ctx = setup();
  const res = response();
  await ctx.handler(orderRequest({
    store_id: 7, recipient_name: 'Alex', recipient_phone: '12345678',
    delivery_address: 'Street 123', payment_method: 'bitcoin', items: [{ id: 5, quantity: 1 }]
  }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /支付方式/);
  assert.equal(ctx.calls.some(x => x.type === 'run'), false);
});

test('customer KHQR generation and payment notification require the order bearer token', async () => {
  const ctx = setup();
  const req = { params: { orderId: '33' }, body: {}, get: () => '' };
  const qrRes = response();
  await ctx.khqrHandler(req, qrRes);
  assert.equal(qrRes.statusCode, 401);
  const notifyRes = response();
  await ctx.notifyHandler(req, notifyRes);
  assert.equal(notifyRes.statusCode, 401);
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(ctx.transactions, []);
});

test('customer delivery order reuses the durable browser customer token without storing it in plaintext', async () => {
  const ctx = setup();
  const token = 'b'.repeat(64);
  const res = response();
  await ctx.handler(orderRequest({
    store_id: 7, customer_token: token,
    recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }]
  }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.customerToken, token);
  const orderInsert = ctx.calls.find(x => x.type === 'run' && x.sql.includes('INSERT INTO orders'));
  assert.equal(orderInsert.params[4], require('../server/services/session-token').hashSessionToken(token));
  assert.notEqual(orderInsert.params[4], token);
});

test('customer delivery order enqueues an order-created notice for its bound Telegram identity', async () => {
  const ctx = setup({ customerBinding: true });
  const token = 'c'.repeat(64);
  const res = response();
  await ctx.handler(orderRequest({
    store_id: 7, customer_token: token,
    recipient_name: 'Alex', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }]
  }), res);
  assert.equal(res.statusCode, 201);
  const queued = ctx.calls.find(call => call.type === 'enqueue');
  assert.ok(queued);
  assert.equal(queued.input.recipientScope, 'customer');
  assert.equal(queued.input.recipientKey, 'binding:42');
  assert.equal(queued.input.eventKey, 'order:33:created:customer');
  assert.equal(queued.input.event.type, 'order.created');
  assert.equal(queued.input.event.fulfillmentType, 'delivery');
});

test('customer delivery order retry with the same key returns the original order without duplicate side effects', async () => {
  const ctx = setup();
  const token = 'd'.repeat(64);
  const body = { store_id: 7, customer_token: token, recipient_name: 'Alex', recipient_phone: '+855 12 345 678', delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash', items: [{ id: 5, quantity: 2 }] };
  const first = response();
  await ctx.handler(orderRequest(body, 'e'.repeat(64)), first);
  const salesUpdatesAfterFirst = ctx.calls.filter(x => x.type === 'run' && x.sql.includes('UPDATE menus SET sales_count = sales_count + ?')).length;
  const eventCountAfterFirst = ctx.events.length;
  const second = response();
  await ctx.handler(orderRequest(body, 'e'.repeat(64)), second);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.orderId, first.body.orderId);
  assert.equal(second.body.orderNo, first.body.orderNo);
  assert.equal(second.body.customerToken, token);
  assert.equal(ctx.calls.filter(x => x.type === 'run' && x.sql.includes('INSERT INTO orders')).length, 1);
  assert.equal(ctx.calls.filter(x => x.type === 'run' && x.sql.includes('INSERT INTO delivery_jobs')).length, 1);
  assert.equal(ctx.calls.filter(x => x.type === 'run' && x.sql.includes('UPDATE menus SET sales_count = sales_count + ?')).length, salesUpdatesAfterFirst);
  assert.equal(ctx.events.length, eventCountAfterFirst);
});

test('customer delivery order rejects reuse of an idempotency key for changed checkout content', async () => {
  const ctx = setup();
  const token = 'f'.repeat(64);
  const first = response();
  await ctx.handler(orderRequest({ store_id: 7, customer_token: token, recipient_name: 'Alex', recipient_phone: '+855 12 345 678', delivery_address: 'Street 123', payment_method: 'cash', items: [{ id: 5, quantity: 1 }] }, '9'.repeat(64)), first);
  const second = response();
  await ctx.handler(orderRequest({ store_id: 7, customer_token: token, recipient_name: 'Alex', recipient_phone: '+855 12 345 678', delivery_address: 'Street 123', payment_method: 'cash', items: [{ id: 5, quantity: 3 }] }, '9'.repeat(64)), second);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 409);
  assert.match(second.body.error, /已用于其他订单内容/);
  assert.equal(ctx.calls.filter(x => x.type === 'run' && x.sql.includes('INSERT INTO orders')).length, 1);
});

test('concurrent customer delivery submissions with one key create only one order and delivery job', async () => {
  const ctx = setup();
  const token = '8'.repeat(64);
  const body = { store_id: 7, customer_token: token, recipient_name: 'Alex', recipient_phone: '+855 12 345 678', delivery_address: 'Street 123', payment_method: 'cash', items: [{ id: 5, quantity: 1 }] };
  const first = response(), second = response();
  await Promise.all([
    ctx.handler(orderRequest(body, '7'.repeat(64)), first),
    ctx.handler(orderRequest(body, '7'.repeat(64)), second)
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
  assert.equal(first.body.orderId, second.body.orderId);
  assert.equal(ctx.calls.filter(x => x.type === 'run' && x.sql.includes('INSERT INTO orders')).length, 1);
  assert.equal(ctx.calls.filter(x => x.type === 'run' && x.sql.includes('INSERT INTO delivery_jobs')).length, 1);
  assert.equal(ctx.calls.filter(x => x.type === 'run' && x.sql.includes('UPDATE menus SET sales_count = sales_count + ?')).length, 1);
  assert.equal(ctx.events.filter(x => x.event === 'order:new').length, 3);
});

test('tenant Telegram checkout verifies the owning Bot identity and tenant/store signature without notification Chat ID', async () => {
  const oldKey = process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
  process.env.TELEGRAM_BOT_ENCRYPTION_KEY = '55'.repeat(32);
  try {
    const tenantToken = '765432:abcdefghijklmnopqrstuvwxyzABCDE';
    const tenantSecret = 'tenant-webhook-secret-123456789012345';
    const botPath = 'D'.repeat(43);
    const ctx = setup({
      tenantBot: {
        client_bot_token_encrypted: encryptBotToken(tenantToken),
        webhook_secret_encrypted: encryptBotToken(tenantSecret)
      }
    });
    const signature = createTenantStoreEntrySignature({ merchantId: 3, storeId: 7, secret: tenantSecret });
    const res = response();
    await ctx.handler(orderRequest({
      store_id: 7, customer_token: 'a'.repeat(64), telegram_entry: true, store_entry: signature, bot_path: botPath,
      recipient_name: 'Alex', recipient_phone: '+855 12 345 678', delivery_address: 'Street 123, Phnom Penh',
      payment_method: 'cash', items: [{ id: 5, quantity: 1 }]
    }, 'b'.repeat(64), signedInitData(tenantToken)), res);
    assert.equal(res.statusCode, 201);
    assert.equal(ctx.calls.some(call => call.sql.includes('FROM telegram_merchant_bots') && call.params[1] === 3), true);
    assert.equal(ctx.calls.some(call => call.sql.includes('telegram_store_admin_recipients')), false);
  } finally {
    if (oldKey === undefined) delete process.env.TELEGRAM_BOT_ENCRYPTION_KEY;
    else process.env.TELEGRAM_BOT_ENCRYPTION_KEY = oldKey;
  }
});
