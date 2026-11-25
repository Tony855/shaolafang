'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const track = fs.readFileSync(path.join(__dirname, '..', 'delivery-track.html'), 'utf8');
const order = fs.readFileSync(path.join(__dirname, '..', 'delivery-order.html'), 'utf8');

test('delivery tracking restores the per-order customer credential after a Telegram Mini App reopen', () => {
  assert.ok(track.includes("localStorage.setItem('customer_token:'+orderId,fragmentToken)"));
  assert.ok(track.includes("localStorage.getItem('customer_token:'+orderId)"));
  assert.ok(track.includes("localStorage.getItem('foodflow_customer_identity_v1')"));
  assert.ok(order.includes("localStorage.setItem('customer_token:'+data.orderId,data.customerToken)"));
});
