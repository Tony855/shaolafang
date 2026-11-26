'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTelegramBusinessNotification } = require('../server/services/telegram-notification-format');

test('formats allowlisted order events with bounded fields only', () => {
  assert.equal(
    formatTelegramBusinessNotification({
      type: 'order.created', storeName: 'Phnom Penh', orderNo: '11001', tableName: 'A-08',
      amount: 12.5, currency: 'USD', customerToken: 'must-not-appear',
      note: '不要香菜、少辣'
    }),
    `🏪 <b>门店</b>：Phnom Penh · 新订单
━━━━━━━━━━━━━━━━━━
🪑 <b>座号</b>：A-08
🧾 <b>订单</b>：11001
📝 <b>顾客备注</b>：
<blockquote>不要香菜、少辣</blockquote>
💰 <b>金额</b>：<b>12.50 USD</b>
━━━━━━━━━━━━━━━━━━
智能订单通知`
  );
  assert.equal(
    formatTelegramBusinessNotification({
      type: 'order.settled', storeName: 'Store A', orderNo: '11002', tableName: 'B-03',
      amount: 20, currency: 'KHR'
    }).includes('customerToken'),
    false
  );
});

test('formats refund amount without exposing reason or notes', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.refunded', storeName: 'Store B', orderNo: '11003', tableName: 'VIP-2',
    refundAmount: 4.25, currency: 'USD', reason: 'private reason', note: 'private note'
  });
  assert.match(message, /<b>座号<\/b>：VIP-2/);
  assert.match(message, /<b>退款金额<\/b>：<b>4\.25 USD<\/b>/);
  assert.equal(message.includes('private'), false);
});

test('rejects unknown event types, missing identifiers and invalid amounts', () => {
  assert.throws(() => formatTelegramBusinessNotification({ type: 'order.unknown' }), /不支持/);
  assert.throws(() => formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'A', orderNo: '1', amount: -1, currency: 'USD'
  }), /金额无效/);
  assert.throws(() => formatTelegramBusinessNotification({
    type: 'order.refunded', storeName: 'A', orderNo: '1', refundAmount: 0, currency: 'USD'
  }), /退款金额无效/);
});

test('strips control characters and bounds untrusted display values', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'A\n[Injected]', orderNo: '1\u0000',
    amount: 1, currency: 'USD'
  });
  assert.equal(message.includes('\n[Injected]'), false);
  assert.equal(message.includes('\u0000'), false);
});

test('escapes HTML in untrusted store and customer note fields', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.created', storeName: '<b>Store</b> & Co', orderNo: '11<5',
    amount: 8.5, currency: 'USD', note: '<b>注入</b> & 不要辣'
  });
  assert.match(message, /&lt;b&gt;Store&lt;\/b&gt; &amp; Co/);
  assert.match(message, /&lt;b&gt;注入&lt;\/b&gt; &amp; 不要辣/);
  assert.equal(message.includes('<b>注入</b>'), false);
});


test('escapes table names and omits table line when unavailable', () => {
  const withTable = formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'A', orderNo: '1', tableName: '<VIP & 2>', amount: 1, currency: 'USD'
  });
  assert.ok(withTable.includes('<b>座号</b>：&lt;VIP &amp; 2&gt;'));
  const withoutTable = formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'A', orderNo: '2', amount: 1, currency: 'USD'
  });
  assert.equal(withoutTable.includes('座号'), false);
});

test('formats delivery fulfillment with recipient and address instead of a table number', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'FoodFlow', orderNo: '11GL00001',
    fulfillmentType: 'delivery', recipientName: 'Alex', recipientPhone: '+855 12 345 678',
    deliveryAddress: '<Street 123>', amount: 8.5, currency: 'USD'
  });
  assert.ok(message.includes('履约方式</b>：外卖配送'));
  assert.ok(message.includes('收件人</b>：Alex'));
  assert.ok(message.includes('联系电话</b>：+855 12 345 678'));
  assert.ok(message.includes('配送地址</b>：&lt;Street 123&gt;'));
  assert.equal(message.includes('座号'), false);
});


test('includes every valid new-order item with its independent preparation status', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'ShaoLaFang总店', orderNo: '11GL00027',
    amount: 16.5, currency: 'USD',
    items: [
      { name: '香辣鸡翅', quantity: 2, itemStatus: 'pending' },
      { name: '酸辣土豆丝', quantity: 1, itemStatus: 'done' },
      { name: '<米饭>', quantity: 3, itemStatus: 'pending', returnedQty: 1 }
    ]
  });
  assert.match(message, /香辣鸡翅 ×2 — 制作中/);
  assert.match(message, /酸辣土豆丝 ×1 — 已完成/);
  assert.match(message, /&lt;米饭&gt; ×3 — 制作中（已退 1）/);
});

test('does not render unsafe or malformed item fields and reports omitted entries', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'Store', orderNo: '42', amount: 1, currency: 'USD',
    items: [
      { name: '<script>alert(1)</script>', quantity: 1, itemStatus: 'pending' },
      { name: 'invalid quantity', quantity: -1, itemStatus: 'done' }
    ]
  });
  assert.match(message, /&lt;script&gt;/);
  assert.equal(message.includes('<script>'), false);
  assert.match(message, /另有 1 项菜品未显示/);
});
