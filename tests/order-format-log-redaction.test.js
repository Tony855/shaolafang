'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOrder } = require('../server/services/order');

test('malformed order item payloads are not copied into application logs', () => {
  const secretPayload = '{"customerPhone":"+85512345678","note":"private order detail"';
  const originalWarn = console.warn;
  let logged;
  console.warn = (...args) => { logged = args; };
  let formatted;
  try {
    formatted = formatOrder({
      id: 42,
      store_id: 3,
      merchant_id: 7,
      table_name: 'A1',
      order_no: 'FF-42',
      items: secretPayload,
      total: 10,
      refund_amount: 0,
      status: 'pending'
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(formatted.dataCorrupted, true);
  assert.deepEqual(formatted.items, []);
  assert.equal(logged.length, 1);
  assert.ok(String(logged[0]).includes('orderId=42'));
  assert.ok(!JSON.stringify(logged).includes(secretPayload));
  assert.ok(!JSON.stringify(logged).includes('+85512345678'));
});
