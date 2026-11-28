'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const databaseUrl = process.env.MYSQL_INTEGRATION_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  process.env.DB_HOST = url.hostname;
  process.env.DB_PORT = url.port || '3306';
  process.env.DB_USER = decodeURIComponent(url.username);
  process.env.DB_PASSWORD = decodeURIComponent(url.password);
  process.env.DB_DATABASE = decodeURIComponent(url.pathname.slice(1));
} else if (!process.env.DB_DATABASE) {
  process.env.DB_DATABASE = 'delivery_idempotency_test';
}

const poolModule = require('../server/db/pool');
const { runAsync, getAsync, allAsync, withTransaction } = require('../server/db/helpers');
const { ensureDeliverySchema } = require('../server/db/migrations/delivery');
const { ensureTelegramCustomerBindingSchema } = require('../server/db/migrations/telegram-customer-binding');
const { ensureTelegramNotificationOutboxSchema } = require('../server/db/migrations/telegram-notification-outbox');
const { ensureTelegramChatDestinationSchema } = require('../server/db/migrations/telegram-chat-destinations');
const { hashSessionToken } = require('../server/services/session-token');
const { enqueueTelegramNotification, markTelegramNotificationSending } = require('../server/services/telegram-notification-outbox');
const { enqueueStoreAdminTelegramNotification } = require('../server/services/telegram-notification-enqueue');
const registerCustomerDeliveryRoutes = require('../routes/customer-delivery');

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

function makeRequest(body, key) {
  return {
    body,
    headers: { 'idempotency-key': key },
    get(name) { return name.toLowerCase() === 'idempotency-key' ? key : ''; }
  };
}

test('MySQL integration: delivery checkout idempotency is atomic under real concurrent requests', {
  skip: !databaseUrl ? 'MYSQL_INTEGRATION_URL is not configured' : false,
  timeout: 60000
}, async t => {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  assert.match(databaseName, /(?:^|[_-])test(?:$|[_-])/i,
    'delivery idempotency integration must use an isolated test database');

  const testPool = mysql.createPool(databaseUrl);
  const previousPool = poolModule.pool;
  poolModule.setPool(testPool);
  const tables = [
    'telegram_store_subscriptions', 'telegram_chat_destinations',
    'telegram_notification_outbox', 'telegram_webhook_updates',
    'telegram_customer_bindings', 'telegram_customer_binding_challenges',
    'delivery_rider_locations', 'delivery_order_requests', 'delivery_jobs',
    'delivery_rider_sessions', 'delivery_riders', 'orders', 'menus',
    'settings', 'stores', 'merchants'
  ];
  const cleanup = async () => {
    for (const table of tables) await runAsync('DROP TABLE IF EXISTS `' + table + '`');
  };
  t.after(async () => {
    try { await cleanup(); }
    finally { poolModule.setPool(previousPool); await testPool.end(); }
  });

  await cleanup();
  await runAsync('CREATE TABLE merchants (id INT NOT NULL PRIMARY KEY, status TINYINT NOT NULL DEFAULT 1) ENGINE=InnoDB');
  await runAsync('CREATE TABLE stores (id INT NOT NULL PRIMARY KEY, merchant_id INT NOT NULL, name VARCHAR(120) NOT NULL, active TINYINT NOT NULL DEFAULT 1, KEY idx_store_merchant (merchant_id)) ENGINE=InnoDB');
  await runAsync('CREATE TABLE settings (`key` VARCHAR(191) NOT NULL PRIMARY KEY, value TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  await runAsync('CREATE TABLE menus (id INT NOT NULL PRIMARY KEY, store_id INT NOT NULL, sales_count INT NOT NULL DEFAULT 0) ENGINE=InnoDB');
  await runAsync("CREATE TABLE orders (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, order_no VARCHAR(80) NOT NULL UNIQUE, table_name VARCHAR(120) DEFAULT NULL, items LONGTEXT NOT NULL, total DECIMAL(12,2) NOT NULL, status VARCHAR(32) NOT NULL, createdAt VARCHAR(40) NOT NULL, session_token CHAR(64) DEFAULT NULL, customer_token CHAR(64) DEFAULT NULL, store_id INT NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '', merchant_id INT NOT NULL, fulfillment_type VARCHAR(32) NOT NULL, pay_method VARCHAR(16) NOT NULL, KEY idx_orders_store (store_id,id)) ENGINE=InnoDB");

  await runAsync('INSERT INTO merchants (id,status) VALUES (7,1)');
  await runAsync("INSERT INTO stores (id,merchant_id,name,active) VALUES (9,7,'Integration Store',1)");
  await runAsync('INSERT INTO menus (id,store_id,sales_count) VALUES (5,9,0)');
  await runAsync("INSERT INTO settings (`key`,value) VALUES ('max_order_items','50'),('max_item_quantity','100'),('order_prefix_normal','11'),('order_no_reset_period','never'),('telegram_admin_bot_enabled','0'),('telegram_client_bot_enabled','1')");

  await ensureDeliverySchema({ runAsync, allAsync });
  await ensureTelegramCustomerBindingSchema({ runAsync });
  await ensureTelegramNotificationOutboxSchema({ runAsync, getAsync });
  await ensureTelegramChatDestinationSchema({ runAsync, getAsync });

  // Real-DB merchant group destination/subscription fixtures.
  const destinationInsert = await runAsync(
    "INSERT INTO telegram_chat_destinations (merchant_id,bot_profile,chat_id,chat_type,title,is_enabled,created_at,updated_at) VALUES (7,'admin','-1007654321','supergroup','Integration Group A',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))"
  );
  const destinationId = Number(destinationInsert.lastID);
  const secondDestinationInsert = await runAsync(
    "INSERT INTO telegram_chat_destinations (merchant_id,bot_profile,chat_id,chat_type,title,is_enabled,created_at,updated_at) VALUES (7,'admin','-1007654322','supergroup','Integration Group B',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))"
  );
  const secondDestinationId = Number(secondDestinationInsert.lastID);
  await runAsync("INSERT INTO stores (id,merchant_id,name,active) VALUES (10,7,'Integration Store B',1)");
  await runAsync(
    'INSERT INTO telegram_store_subscriptions (merchant_id,destination_id,store_id,is_enabled,notify_order_created,notify_settled,notify_refunded,created_at,updated_at) VALUES (?,?,9,1,1,1,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)), (?,?,9,1,1,1,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)), (?,?,10,1,1,1,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
    [7, destinationId, 7, secondDestinationId, 7, destinationId]
  );

  const customerToken = 'a'.repeat(64);
  const customerTokenHash = hashSessionToken(customerToken);
  await runAsync(
    'INSERT INTO telegram_customer_bindings (customer_token_hash,merchant_id,store_id,telegram_user_id,telegram_chat_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
    [customerTokenHash, 7, 9, '70009', '70009']
  );

  let orderSequence = 0;
  const integrationDbErrors = [];
  const captureDbError = (operation, fn) => async (...args) => {
    try { return await fn(...args); }
    catch (error) {
      integrationDbErrors.push({ operation, code: error.code || '', message: error.message || '' });
      throw error;
    }
  };
  const routeGetAsync = captureDbError('getAsync', getAsync);
  const routeAllAsync = captureDbError('allAsync', allAsync);
  const routeWithTransaction = captureDbError('withTransaction', withTransaction);
  let failDeliveryJobInsert = false;
  const routeRunAsync = async (sql, params = []) => {
    if (failDeliveryJobInsert && sql.includes('INSERT INTO delivery_jobs')) {
      failDeliveryJobInsert = false;
      throw new Error('delivery integration rollback injection');
    }
    try { return await runAsync(sql, params); }
    catch (error) {
      integrationDbErrors.push({ operation: 'runAsync', code: error.code || '', message: error.message || '' });
      throw error;
    }
  };
  const emitted = [];
  const registered = new Map();
  const app = {
    get(path, ...handlers) { registered.set('GET ' + path, handlers[handlers.length - 1]); },
    post(path, ...handlers) { registered.set('POST ' + path, handlers[handlers.length - 1]); },
    delete(path, ...handlers) { registered.set('DELETE ' + path, handlers[handlers.length - 1]); }
  };
  registerCustomerDeliveryRoutes(app, {
    getAsync: routeGetAsync, allAsync: routeAllAsync, runAsync: routeRunAsync, withTransaction: routeWithTransaction,
    normalizeOrderItems: async input => input.map(item => ({
      id: Number(item.id), name: 'Noodle', price: 12.5, base_price: 12.5,
      quantity: Number(item.quantity)
    })),
    allocateOrderNo: async prefix => prefix + String(++orderSequence).padStart(5, '0'),
    getOrderCooldownMs: async () => 0,
    checkAndSetCooldown: async () => true,
    getClientIp: () => '127.0.0.1',
    formatOrder: row => ({ ...row }),
    io: { to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; } },
    enqueueTelegramNotification
  });

  const handler = registered.get('POST /api/public/delivery/orders');
  assert.equal(typeof handler, 'function');
  const body = {
    store_id: 9, customer_token: customerToken,
    recipient_name: 'Integration Customer', recipient_phone: '+855 12 345 678',
    delivery_address: 'Street 123, Phnom Penh', payment_method: 'cash',
    items: [{ id: 5, quantity: 1 }]
  };
  const key = 'b'.repeat(64);

  const first = makeResponse();
  const second = makeResponse();
  await Promise.all([
    handler(makeRequest(body, key), first),
    handler(makeRequest(body, key), second)
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort((a,b) => a-b), [200,201], JSON.stringify(integrationDbErrors));
  assert.equal(first.body.orderId, second.body.orderId);
  assert.equal(first.body.orderNo, second.body.orderNo);
  assert.equal(first.body.customerToken, customerToken);
  assert.equal(second.body.customerToken, customerToken);
  assert.ok(first.body.trackingUrl.includes('#token=' + customerToken));

  const countSql = 'SELECT (SELECT COUNT(*) FROM orders WHERE store_id=9 AND fulfillment_type=\'delivery\') AS orders_count, (SELECT COUNT(*) FROM delivery_jobs WHERE store_id=9) AS jobs_count, (SELECT sales_count FROM menus WHERE id=5) AS sales_count, (SELECT COUNT(*) FROM telegram_notification_outbox WHERE store_id=9 AND event_type=\'order.created\') AS notices_count';
  const concurrentCounts = await getAsync(countSql);
  assert.equal(Number(concurrentCounts.orders_count), 1);
  assert.equal(Number(concurrentCounts.jobs_count), 1);
  assert.equal(Number(concurrentCounts.sales_count), 1);
  assert.equal(Number(concurrentCounts.notices_count), 1);
  assert.equal(emitted.filter(item => item.event === 'order:new').length, 3,
    'only the creating request emits kitchen/waiter/cashier events');

  const replay = makeResponse();
  await handler(makeRequest(body, key), replay);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.body.orderId, first.body.orderId);
  assert.equal(replay.body.orderNo, first.body.orderNo);
  assert.equal(replay.body.customerToken, customerToken);
  assert.equal(replay.body.trackingUrl, first.body.trackingUrl);

  const conflictCart = makeResponse();
  await handler(makeRequest({ ...body, items: [{ id: 5, quantity: 2 }] }, key), conflictCart);
  assert.equal(conflictCart.statusCode, 409);
  const conflictCustomer = makeResponse();
  await handler(makeRequest({ ...body, customer_token: 'c'.repeat(64) }, key), conflictCustomer);
  assert.equal(conflictCustomer.statusCode, 409);

  const secondKeyResponse = makeResponse();
  await handler(makeRequest(body, 'd'.repeat(64)), secondKeyResponse);
  assert.equal(secondKeyResponse.statusCode, 201);
  assert.notEqual(secondKeyResponse.body.orderId, first.body.orderId);

  const secondCounts = await getAsync(countSql);
  assert.equal(Number(secondCounts.orders_count), 2);
  assert.equal(Number(secondCounts.jobs_count), 2);
  assert.equal(Number(secondCounts.sales_count), 2);
  assert.equal(Number(secondCounts.notices_count), 2);

  const persisted = await allAsync(
    'SELECT idempotency_key_hash,customer_token_hash,request_hash,order_id FROM delivery_order_requests WHERE store_id=? ORDER BY id',
    [9]
  );
  assert.equal(persisted.length, 2);
  const persistedJson = JSON.stringify(persisted);
  assert.equal(persistedJson.includes(key), false);
  assert.equal(persistedJson.includes(customerToken), false);
  assert.equal(persisted.every(row => /^[a-f0-9]{64}$/.test(row.idempotency_key_hash)), true);
  assert.equal(persisted.every(row => /^[a-f0-9]{64}$/.test(row.customer_token_hash)), true);

  failDeliveryJobInsert = true;
  const rollbackKey = 'e'.repeat(64);
  const rollbackResponse = makeResponse();
  const originalConsoleError = console.error;
  const capturedErrors = [];
  console.error = (...args) => capturedErrors.push(args.map(String).join(' '));
  try {
    await handler(makeRequest(body, rollbackKey), rollbackResponse);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(rollbackResponse.statusCode, 500);
  assert.equal(capturedErrors.join(' ').includes(rollbackKey), false);
  assert.equal(capturedErrors.join(' ').includes(customerToken), false);
  const rollbackHash = crypto.createHash('sha256').update(rollbackKey).digest('hex');
  assert.equal(Number((await getAsync('SELECT COUNT(*) AS total FROM delivery_order_requests WHERE store_id=? AND idempotency_key_hash=?', [9, rollbackHash])).total), 0);
  assert.equal(Number((await getAsync('SELECT COUNT(*) AS total FROM orders WHERE store_id=9')).total), 2);
  assert.equal(Number((await getAsync('SELECT COUNT(*) AS total FROM delivery_jobs WHERE store_id=9')).total), 2);

  const retryAfterRollback = makeResponse();
  await handler(makeRequest(body, rollbackKey), retryAfterRollback);
  assert.equal(retryAfterRollback.statusCode, 201);
  assert.equal(Number((await getAsync('SELECT COUNT(*) AS total FROM orders WHERE store_id=9')).total), 3);
  assert.equal(Number((await getAsync('SELECT COUNT(*) AS total FROM delivery_jobs WHERE store_id=9')).total), 3);
  assert.equal(Number((await getAsync('SELECT sales_count FROM menus WHERE id=5')).sales_count), 3);
  // Staging routing emits one idempotent outbox row per destination, not one
  // row per store. A store may subscribe to multiple groups and one group to
  // multiple stores.
  await runAsync("UPDATE settings SET value='1' WHERE `key`='telegram_admin_bot_enabled'");
  const groupEventKey = 'group-routing-enqueue-it:' + crypto.randomUUID();
  const groupEvent = { type: 'order.created', storeName: 'Integration Store', orderNo: 'GROUP-ENQUEUE', amount: 1, currency: 'USD' };
  await withTransaction(async () => {
    assert.equal(await enqueueStoreAdminTelegramNotification({
      allAsync, merchantId: 7, storeId: 9, eventKey: groupEventKey, event: groupEvent, routingEnabled: true
    }), true);
  });
  const storeNineGroupRows = await allAsync(
    'SELECT recipient_key,event_key FROM telegram_notification_outbox WHERE store_id=9 AND event_key LIKE ? ORDER BY recipient_key',
    [groupEventKey + ':destination:%']
  );
  assert.deepEqual(storeNineGroupRows.map(row => row.recipient_key), [
    'destination:' + destinationId + ':store:9',
    'destination:' + secondDestinationId + ':store:9'
  ]);
  await withTransaction(async () => {
    assert.equal(await enqueueStoreAdminTelegramNotification({
      allAsync, merchantId: 7, storeId: 9, eventKey: groupEventKey, event: groupEvent, routingEnabled: true
    }), true);
  });
  assert.equal((await allAsync(
    'SELECT id FROM telegram_notification_outbox WHERE store_id=9 AND event_key LIKE ?',
    [groupEventKey + ':destination:%']
  )).length, 2, 'repeated enqueue must be idempotent per destination');
  await withTransaction(async () => {
    assert.equal(await enqueueStoreAdminTelegramNotification({
      allAsync, merchantId: 7, storeId: 10, eventKey: groupEventKey, event: groupEvent, routingEnabled: true
    }), true);
  });
  const storeTenGroupRows = await allAsync(
    'SELECT recipient_key FROM telegram_notification_outbox WHERE store_id=10 AND event_key LIKE ?',
    [groupEventKey + ':destination:%']
  );
  assert.deepEqual(storeTenGroupRows.map(row => row.recipient_key), ['destination:' + destinationId + ':store:10']);

  // Real-DB send-boundary checks: active subscriptions cross to sending;
  // event-off and destination-off are terminally dead-lettered.
  async function makeProcessingGroupNotice(eventType, suffix) {
    const eventKey = 'group-routing-boundary-it:' + suffix + ':' + crypto.randomUUID();
    await enqueueTelegramNotification({
      eventKey: eventKey + ':destination:' + destinationId,
      recipientScope: 'merchant_store',
      recipientKey: 'destination:' + destinationId + ':store:9',
      merchantId: 7, storeId: 9,
      event: { type: eventType, storeName: 'Integration Store', orderNo: suffix, amount: 1, refundAmount: 1, currency: 'USD' }
    });
    const row = await getAsync('SELECT id FROM telegram_notification_outbox WHERE event_key=?', [eventKey + ':destination:' + destinationId]);
    const worker = crypto.randomUUID();
    await runAsync(
      "UPDATE telegram_notification_outbox SET state='processing', locked_by=?, locked_until=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) WHERE id=?",
      [worker, row.id]
    );
    return { id: Number(row.id), worker };
  }

  const activeGroupNotice = await makeProcessingGroupNotice('order.created', 'active');
  assert.equal(await markTelegramNotificationSending(activeGroupNotice.id, activeGroupNotice.worker, 60, {
    scope: 'merchant_store', key: 'destination:' + destinationId + ':store:9',
    merchantId: 7, storeId: 9, eventType: 'order.created', expectedChatId: '-1007654321'
  }), true);
  assert.equal((await getAsync('SELECT state FROM telegram_notification_outbox WHERE id=?', [activeGroupNotice.id])).state, 'sending');

  const disabledEventNotice = await makeProcessingGroupNotice('order.refunded', 'event-disabled');
  await runAsync('UPDATE telegram_store_subscriptions SET notify_refunded=0 WHERE merchant_id=7 AND destination_id=? AND store_id=9', [destinationId]);
  assert.equal(await markTelegramNotificationSending(disabledEventNotice.id, disabledEventNotice.worker, 60, {
    scope: 'merchant_store', key: 'destination:' + destinationId + ':store:9',
    merchantId: 7, storeId: 9, eventType: 'order.refunded', expectedChatId: '-1007654321'
  }), false);
  const disabledEventState = await getAsync('SELECT state,last_error_code FROM telegram_notification_outbox WHERE id=?', [disabledEventNotice.id]);
  assert.equal(disabledEventState.state, 'dead');
  assert.equal(disabledEventState.last_error_code, 'event_disabled');

  const disabledDestinationNotice = await makeProcessingGroupNotice('order.created', 'destination-disabled');
  await runAsync('UPDATE telegram_chat_destinations SET is_enabled=0 WHERE id=? AND merchant_id=7', [destinationId]);
  assert.equal(await markTelegramNotificationSending(disabledDestinationNotice.id, disabledDestinationNotice.worker, 60, {
    scope: 'merchant_store', key: 'destination:' + destinationId + ':store:9',
    merchantId: 7, storeId: 9, eventType: 'order.created', expectedChatId: '-1007654321'
  }), false);
  assert.equal((await getAsync('SELECT state FROM telegram_notification_outbox WHERE id=?', [disabledDestinationNotice.id])).state, 'dead');

});
