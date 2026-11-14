'use strict';

const EVENT_LABELS = Object.freeze({
  'order.created': '新订单',
  'order.settled': '收款确认',
  'order.refunded': '退款完成'
});

function safeField(value, maxLength = 80) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function formatTelegramBusinessNotification(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Telegram 业务事件无效');
  }
  const label = EVENT_LABELS[event.type];
  if (!label) throw new TypeError('不支持的 Telegram 业务事件');

  const store = safeField(event.storeName, 80);
  const orderNo = safeField(event.orderNo, 40);
  if (!store || !orderNo) throw new TypeError('业务事件缺少必要标识');

  const lines = [
    '[FoodFlow] ' + label,
    '门店：' + store,
    '订单：' + orderNo
  ];

  if (event.type === 'order.created' || event.type === 'order.settled') {
    const amount = Number(event.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 99999999) {
      throw new TypeError('业务事件金额无效');
    }
    const currency = safeField(event.currency || 'USD', 8);
    if (!/^[A-Z]{3,8}$/.test(currency)) throw new TypeError('业务事件币种无效');
    lines.push('金额：' + amount.toFixed(2) + ' ' + currency);
  }

  if (event.type === 'order.refunded') {
    const amount = Number(event.refundAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999) {
      throw new TypeError('退款金额无效');
    }
    const currency = safeField(event.currency || 'USD', 8);
    if (!/^[A-Z]{3,8}$/.test(currency)) throw new TypeError('业务事件币种无效');
    lines.push('退款金额：' + amount.toFixed(2) + ' ' + currency);
  }

  return lines.join('\n');
}

module.exports = { formatTelegramBusinessNotification };
