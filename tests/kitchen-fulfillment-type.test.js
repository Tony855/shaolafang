'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('kitchen tickets clearly distinguish dine-in, delivery, and pickup orders', () => {
  const source = fs.readFileSync(path.join(root, 'pages', 'kitchen.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'assets', 'kitchen.css'), 'utf8');

  assert.match(source, /o\.fulfillment_type/);
  assert.match(source, /orderFulfillmentDineIn/);
  assert.match(source, /orderFulfillmentDelivery/);
  assert.match(source, /orderFulfillmentTakeaway/);
  assert.match(source, /fulfillment-badge-\$\{fulfillmentType\}/);
  assert.match(source, /fulfillmentType === 'dine_in'/);
  assert.match(css, /\.fulfillment-badge-dine_in/);
  assert.match(css, /\.fulfillment-badge-delivery/);
  assert.match(css, /\.fulfillment-badge-takeaway/);
  assert.match(css, /@media \(max-width: 520px\)/);
});
