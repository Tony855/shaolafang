'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const track = fs.readFileSync(path.join(__dirname, '..', 'delivery-track.html'), 'utf8');

test('delivery tracking extracts the order id with or without a trailing slash', () => {
  assert.ok(track.includes(String.raw`const trackingPath=location.pathname.match(/\\/delivery\\/track\\/([1-9]\\d*)\\/?$/);`));
  const matcher = /\/delivery\/track\/([1-9]\d*)\/?$/;
  assert.equal('/delivery/track/123'.match(matcher)?.[1], '123');
  assert.equal('/delivery/track/123/'.match(matcher)?.[1], '123');
  assert.equal('/delivery/track/0/'.match(matcher), null);
  assert.equal('/delivery/track/abc/'.match(matcher), null);
});

test('invalid tracking paths do not send an empty order id to the delivery API', () => {
  assert.ok(track.includes("const orderId=trackingPath?trackingPath[1]:'';"));
  assert.ok(track.includes("if(!customerToken){$('status').textContent='顾客会话已失效，请返回下单页面重新进入。';}"));
});
