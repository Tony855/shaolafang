'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerRoutes = require('../routes/admin-telegram-destinations');

const pass = (req, res, next) => next();
function response() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}
function setup({ merchantId = 7, stores = [11, 12], primary = true, duplicateChat = false } = {}) {
  const routes = new Map();
  const calls = [];
  const destinations = new Map();
  const subscriptions = new Map();
  let nextDestinationId = 1;
  let nextSubscriptionId = 1;
  const app = {
    get(path, ...handlers) { routes.set('GET ' + path, handlers); },
    post(path, ...handlers) { routes.set('POST ' + path, handlers); },
    put(path, ...handlers) { routes.set('PUT ' + path, handlers); },
    
    delete(path, ...handlers) { routes.set('DELETE ' + path, handlers); }
  };
  const getAsync = async (sql, params = []) => {
    calls.push({ type: 'get', sql, params });
    if (sql.includes('FROM merchants')) return { id: merchantId };
    if (sql.includes('FROM merchant_admins')) return { username: 'manager' };
    if (sql.includes('FROM telegram_chat_destinations')) {
      const [id, mid] = params;
      const row = destinations.get(Number(id));
      return row && row.merchant_id === Number(mid) ? row : null;
    }
    if (sql.includes('FROM stores')) {
      const storeId = Number(params[0]);
      const mid = Number(params[1]);
      const authorized = stores.includes(storeId) && mid === merchantId;
      if (!authorized || (!primary && !sql.includes('merchant_admin_store_access'))) return null;
      return { id: storeId };
    }
    if (sql.includes('FROM telegram_store_subscriptions')) {
      if (sql.includes('COUNT(*)')) {
        const count = [...subscriptions.values()].filter(x => x.destination_id === Number(params[1]) && x.merchant_id === Number(params[0])).length;
        return { count };
      }
      const row = [...subscriptions.values()].find(x => x.merchant_id === Number(params[0]) &&
        x.destination_id === Number(params[1]) && x.store_id === Number(params[2]));
      return row || null;
    }
    return null;
  };
  const allAsync = async (sql, params = []) => {
    calls.push({ type: 'all', sql, params });
    if (sql.includes('FROM stores')) return stores.map(id => ({ id, name: 'Store ' + id }));
    if (sql.includes('FROM telegram_chat_destinations')) return [];
    return [];
  };
  const runAsync = async (sql, params = []) => {
    calls.push({ type: 'run', sql, params });
    if (sql.includes('INSERT INTO telegram_chat_destinations')) {
      if (duplicateChat) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      const row = { id: nextDestinationId++, merchant_id: params[0], chat_id: params[1], chat_type: params[2], title: params[3], username: params[4], is_enabled: 1 };
      destinations.set(row.id, row);
      return { lastID: row.id, affectedRows: 1 };
    }
    if (sql.includes('INSERT INTO telegram_store_subscriptions')) {
      const key = params[1] + ':' + params[2];
      const row = { id: subscriptions.get(key)?.id || nextSubscriptionId++, merchant_id: params[0], destination_id: params[1], store_id: params[2], is_enabled: params[3], notify_order_created: params[4], notify_settled: params[5], notify_refunded: params[6] };
      subscriptions.set(key, row);
      return { lastID: row.id, affectedRows: 1 };
    }
    if (sql.includes('DELETE FROM telegram_store_subscriptions')) {
      const row = [...subscriptions.entries()].find(([, x]) => x.id === Number(params[0]));
      if (row) subscriptions.delete(row[0]);
    }
    if (sql.includes('DELETE FROM telegram_chat_destinations')) destinations.delete(Number(params[0]));
    return { affectedRows: 1 };
  };
  registerRoutes(app, {
    getAsync, allAsync, runAsync, withTransaction: async fn => fn(),
    requireAdminKey: pass, requirePermission: () => pass, getClientIp: () => '127.0.0.1'
  });
  return { routes, calls, destinations, subscriptions };
}
const req = (extra = {}) => ({ merchantId: 7, adminId: 5, isPrimaryAdmin: true, params: {}, body: {}, ...extra });
const handler = (routes, method, path) => routes.get(method + ' ' + path).at(-1);

test('destination creation accepts only group Chat IDs and derives merchant from authenticated request', async () => {
  const { routes, calls } = setup();
  const res = response();
  await handler(routes, 'POST', '/api/admin/telegram/destinations')(req({ body: { chatId: '-1001234567890', title: 'Ops', merchantId: 999 } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.destination.chat_type, 'supergroup');
  const insert = calls.find(x => x.type === 'run' && x.sql.includes('INSERT INTO telegram_chat_destinations'));
  assert.deepEqual(insert.params.slice(0, 3), [7, '-1001234567890', 'supergroup']);
  assert.equal(insert.params.includes(999), false);
});

test('destination creation rejects private chat IDs and globally duplicated Chat IDs', async () => {
  const invalid = setup();
  const invalidRes = response();
  await handler(invalid.routes, 'POST', '/api/admin/telegram/destinations')(req({ body: { chatId: '123456789' } }), invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  const duplicate = setup({ duplicateChat: true });
  const duplicateRes = response();
  await handler(duplicate.routes, 'POST', '/api/admin/telegram/destinations')(req({ body: { chatId: '-1001234567890' } }), duplicateRes);
  assert.equal(duplicateRes.statusCode, 409);
});

test('one destination can subscribe to multiple stores with independent event flags', async () => {
  const { routes, destinations, subscriptions } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  for (const [storeId, flags] of [[11, [1, 0, 1]], [12, [0, 1, 0]]]) {
    const res = response();
    await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id/stores/:storeId')(
      req({ params: { id: '4', storeId: String(storeId) }, body: {
        notifyOrderCreated: !!flags[0], notifySettled: !!flags[1], notifyRefunded: !!flags[2]
      } }), res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(subscriptions.size, 2);
  assert.deepEqual([...subscriptions.values()].map(x => x.slice ? x.slice(0) : [x.notify_order_created, x.notify_settled, x.notify_refunded]), [
    [1, 0, 1], [0, 1, 0]
  ]);
});

test('a store can subscribe to multiple destinations and duplicate pair uses one upsert route', async () => {
  const { routes, destinations, subscriptions, calls } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  destinations.set(5, { id: 5, merchant_id: 7 });
  for (const id of [4, 5, 4]) {
    const res = response();
    await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id/stores/:storeId')(
      req({ params: { id: String(id), storeId: '11' }, body: {} }), res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(subscriptions.size, 2);
  assert.equal(calls.filter(x => x.type === 'run' && x.sql.includes('INSERT INTO telegram_store_subscriptions')).length, 3);
});

test('subscription mutation rejects cross-merchant destinations and stores outside admin access', async () => {
  const { routes, destinations } = setup({ primary: false, stores: [11] });
  destinations.set(4, { id: 4, merchant_id: 8 });
  const wrongDestination = response();
  await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id/stores/:storeId')(
    req({ isPrimaryAdmin: false, params: { id: '4', storeId: '11' }, body: {} }), wrongDestination);
  assert.equal(wrongDestination.statusCode, 404);

  destinations.set(4, { id: 4, merchant_id: 7 });
  const wrongStore = response();
  await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id/stores/:storeId')(
    req({ isPrimaryAdmin: false, params: { id: '4', storeId: '12' }, body: {} }), wrongStore);
  assert.equal(wrongStore.statusCode, 404);
});

test('destination cannot be deleted while store subscriptions remain', async () => {
  const { routes, destinations, subscriptions } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  subscriptions.set('4:11', { id: 8, merchant_id: 7, destination_id: 4, store_id: 11 });
  const res = response();
  await handler(routes, 'DELETE', '/api/admin/telegram/destinations/:id')(req({ params: { id: '4' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(destinations.has(4), true);
});

test('destination enabled flag requires an explicit boolean value', async () => {
  const { routes, destinations } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  const res = response();
  await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id')(req({ params: { id: '4' }, body: {} }), res);
  assert.equal(res.statusCode, 400);
});


test('subscription disable dead-letters queued destination jobs in store-destination-subscription order', async () => {
  const { routes, destinations, calls } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  const res = response();
  await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id/stores/:storeId')(
    req({ params: { id: '4', storeId: '11' }, body: { enabled: false } }), res);
  assert.equal(res.statusCode, 200);
  const storeLock = calls.findIndex(x => x.type === 'get' && x.sql.includes('FROM stores'));
  const destinationLock = calls.findIndex(x => x.type === 'get' && x.sql.includes('FROM telegram_chat_destinations'));
  const suppression = calls.find(x => x.type === 'run' && x.sql.includes('UPDATE telegram_notification_outbox'));
  assert.ok(storeLock >= 0 && destinationLock > storeLock);
  assert.ok(suppression);
  assert.deepEqual(suppression.params, [7, 11, 'destination:4:store:11']);
  assert.match(suppression.sql, /state IN \\('pending','processing'\\)/);
});

test('event toggle disable suppresses only the matching queued event type', async () => {
  const { routes, destinations, calls } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  const res = response();
  await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id/stores/:storeId')(
    req({ params: { id: '4', storeId: '11' }, body: { enabled: true, notifyOrderCreated: false, notifySettled: true, notifyRefunded: true } }), res);
  assert.equal(res.statusCode, 200);
  const suppression = calls.find(x => x.type === 'run' && x.sql.includes('UPDATE telegram_notification_outbox'));
  assert.ok(suppression);
  assert.deepEqual(suppression.params, [7, 11, 'destination:4:store:11', 'order.created']);
});

test('removing a store subscription suppresses all queued jobs for that group-store pair', async () => {
  const { routes, destinations, subscriptions, calls } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  subscriptions.set('4:11', { id: 8, merchant_id: 7, destination_id: 4, store_id: 11 });
  const res = response();
  await handler(routes, 'DELETE', '/api/admin/telegram/destinations/:id/stores/:storeId')(
    req({ params: { id: '4', storeId: '11' } }), res);
  assert.equal(res.statusCode, 200);
  const suppression = calls.find(x => x.type === 'run' && x.sql.includes('UPDATE telegram_notification_outbox'));
  assert.ok(suppression);
  assert.deepEqual(suppression.params, [7, 11, 'destination:4:store:11']);
});

test('disabling a destination suppresses queued jobs for every subscribed store', async () => {
  const { routes, destinations, calls } = setup();
  destinations.set(4, { id: 4, merchant_id: 7 });
  const res = response();
  await handler(routes, 'PUT', '/api/admin/telegram/destinations/:id')(
    req({ params: { id: '4' }, body: { enabled: false } }), res);
  assert.equal(res.statusCode, 200);
  const suppression = calls.find(x => x.type === 'run' && x.sql.includes('UPDATE telegram_notification_outbox'));
  assert.ok(suppression);
  assert.deepEqual(suppression.params, [7, 'destination:4:store:%']);
});
