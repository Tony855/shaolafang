'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('admin-created delivery orders require recipient details and create a dispatch job', () => {
  const routes = fs.readFileSync(path.join(root, 'routes/orders.js'), 'utf8');
  assert.match(routes, /fulfillmentType === 'delivery'/);
  assert.match(routes, /创建外卖订单必须填写收件人/);
  assert.match(routes, /hashSessionToken\(customerToken\)/);
  assert.match(routes, /INSERT INTO delivery_jobs/);
  assert.match(routes, /responseData\.trackingUrl/);
  assert.match(routes, /responseData\.customerToken/);
  assert.match(routes, /fulfillmentType, recipientName: deliveryInfo\?\.recipientName/);
  assert.match(routes, /deliveryAddress: deliveryInfo\?\.deliveryAddress/);
});

test('admin delivery form captures contact details and includes the customer tracking link', () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'pages/admin/order.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8');
  assert.match(html, /id="orderDeliveryRecipientName"/);
  assert.match(html, /id="orderDeliveryRecipientPhone"/);
  assert.match(html, /id="orderDeliveryAddress"/);
  assert.match(source, /recipient_name:/);
  assert.match(source, /delivery_address:/);
  assert.ok(bundle.includes(source), 'admin bundle must contain the current order module');
});
