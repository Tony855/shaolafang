const test = require('node:test');
const assert = require('node:assert/strict');
const registerPublicRoutes = require('../routes/public');

function setup(options = {}) {
  const routes = new Map();
  const app = { get(path, ...handlers) { routes.set(path, handlers[handlers.length - 1]); } };
  registerPublicRoutes(app, {
    getAsync: options.getAsync || (async sql => sql.includes('FROM stores') ? { id: 5, merchant_id: 9 } : null),
    allAsync: options.allAsync || (async sql => sql.includes('FROM currencies') ? [
      { code: 'USD', symbol: '$', name: 'US Dollar', rate: 1, is_default: 1 }
    ] : [])
  });
  return routes;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader() {}
  };
}

test('public config falls back safely for malformed and out-of-range stored limits', async () => {
  const routes = setup({
    getAsync: async sql => sql.includes('FROM stores') ? { id: 5, merchant_id: 9 } : null,
    allAsync: async sql => {
      if (sql.includes('FROM currencies')) return [
        { code: 'USD', symbol: '$', name: 'US Dollar', rate: 1, is_default: 1 }
      ];
      if (sql.includes('IN (')) return [
        { key: 'max_order_items', value: '12junk' },
        { key: 'max_item_quantity', value: '0' },
        { key: 'max_order_note_length', value: '2501' },
        { key: 'order_interval_seconds', value: '99999' },
        { key: 'call_limit_enabled', value: 'false' },
        { key: 'call_limit_max', value: '9999' },
        { key: 'call_limit_window_minutes', value: '-1' },
        { key: 'call_limit_cooldown_minutes', value: 'bad' },
        { key: 'waiter_refresh_interval', value: 'bad' },
        { key: 'kitchen_auto_hide_minutes', value: '9999' }
      ];
      return [];
    }
  });
  const res = response();
  await routes.get('/api/public/config')({ query: { store_id: '5' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.constraints, {
    order: { maxItemTypes: 50, maxPerItem: 100, maxNoteLength: 200, minIntervalSec: 30 },
    call: { enabled: false, maxPerWindow: 3, windowMinutes: 5, cooldownMinutes: 10 }
  });
  assert.equal(res.body.waiter_refresh_interval, 8);
  assert.equal(res.body.kitchen_auto_hide_minutes, 10);
});

test('public config does not disclose database errors', async () => {
  const routes = setup({ getAsync: async () => { throw new Error('SQL password and host details'); } });
  const res = response();
  await routes.get('/api/public/config')({ query: { store_id: '5' } }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.includes('SQL password'), false);
});
