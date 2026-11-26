'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('customer history only renders delivery tracking for delivery fulfillment orders with a job status', () => {
  const customer = fs.readFileSync(path.join(__dirname, '..', 'pages', 'customer.js'), 'utf8');
  assert.ok(customer.includes("order.fulfillment_type === 'delivery' && order.delivery_status ?"));
  assert.ok(customer.includes('data-track-order="${Number(order.id)}"'));
});
