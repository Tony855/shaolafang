'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTelegramBusinessNotification } = require('../server/services/telegram-notification-format');

test('formats allowlisted order events with bounded fields only', () => {
  assert.equal(
    formatTelegramBusinessNotification({
      type: 'order.created', storeName: 'Phnom Penh', orderNo: '11001',
      amount: 12.5, currency: 'USD', customerToken: 'must-not-appear',
      note: 'private customer note'
    }),
    '[FoodFlow] 新订单\\n门店：Phnom Penh\\n订单：11001\\n金额：12.50 USD'
  );
  assert.equal(
    formatTelegramBusinessNotification({
      type: 'order.settled', storeName: 'Store A', orderNo: '11002',
      amount: 20, currency: 'KHR'
    }).includes('customerToken'),
    false
  );
});

test('formats refund amount without exposing reason or notes', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.refunded', storeName: 'Store B', orderNo: '11003',
    refundAmount: 4.25, currency: 'USD', reason: 'private reason', note: 'private note'
  });
  assert.match(message, /退款金额：4\\.25 USD/);
  assert.equal(message.includes('private'), false);
});

test('rejects unknown event types, missing identifiers and invalid amounts', () => {
  assert.throws(() => formatTelegramBusinessNotification({ type: 'order.created' }), /不支持/);
  assert.throws(() => formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'A', orderNo: '1', amount: -1, currency: 'USD'
  }), /金额无效/);
  assert.throws(() => formatTelegramBusinessNotification({
    type: 'order.refunded', storeName: 'A', orderNo: '1', refundAmount: 0, currency: 'USD'
  }), /退款金额无效/);
});

test('strips control characters and bounds untrusted display values', () => {
  const message = formatTelegramBusinessNotification({
    type: 'order.created', storeName: 'A\\n[Injected]', orderNo: '1\\u0000',
    amount: 1, currency: 'USD'
  });
  assert.equal(message.includes('\\n[Injected]'), false);
  assert.equal(message.includes('\\u0000'), false);
});
