'use strict';
const EVENT_LABELS = Object.freeze({ 'order.created': '新订单', 'order.settled': '收款确认', 'order.refunded': '退款完成' });
function safeField(value, maxLength = 80) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function formatTelegramBusinessNotification(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Telegram 业务事件无效');
  const label = EVENT_LABELS[event.type];
  if (!label) throw new TypeError('不支持的 Telegram 业务事件');
  const store = safeField(event.storeName, 80), orderNo = safeField(event.orderNo, 40);
  if (!store || !orderNo) throw new TypeError('业务事件缺少必要标识');
  const lines = ['🏪 <b>门店</b>：' + escapeHtml(store) + ' · ' + label, '━━━━━━━━━━━━━━━━━━'];
  const tableName = safeField(event.tableName, 50);
  const fulfillmentType = safeField(event.fulfillmentType, 20);
  if (fulfillmentType === 'delivery') {
    lines.push('🚚 <b>履约方式</b>：外卖配送');
    const recipientName = safeField(event.recipientName, 80);
    const recipientPhone = safeField(event.recipientPhone, 40);
    const deliveryAddress = safeField(event.deliveryAddress, 200);
    if (recipientName) lines.push('👤 <b>收件人</b>：' + escapeHtml(recipientName));
    if (recipientPhone) lines.push('📞 <b>联系电话</b>：' + escapeHtml(recipientPhone));
    if (deliveryAddress) lines.push('📍 <b>配送地址</b>：' + escapeHtml(deliveryAddress));
  } else if (fulfillmentType === 'takeaway') {
    lines.push('🥡 <b>履约方式</b>：顾客自取');
  } else if (tableName) {
    lines.push('🪑 <b>座号</b>：' + escapeHtml(tableName));
  }
  lines.push('🧾 <b>订单</b>：' + escapeHtml(orderNo));
  if (event.type === 'order.created') {
    const items = Array.isArray(event.items) ? event.items : [];
    if (items.length) {
      lines.push('🍽️ <b>菜品明细</b>：');
      const itemLines = [];
      for (const item of items.slice(0, 200)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const name = safeField(item.name, 48);
        const quantity = Number(item.quantity);
        if (!name || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1000) continue;
        const rawStatus = safeField(item.itemStatus, 16);
        const status = rawStatus === 'done' ? '已完成' : (rawStatus === 'pending' ? '制作中' : '状态未知');
        const returnedQty = Number(item.returnedQty) || 0;
        const returned = Number.isSafeInteger(returnedQty) && returnedQty > 0 && returnedQty <= quantity
          ? '（已退 ' + returnedQty + '）' : '';
        itemLines.push('• ' + escapeHtml(name) + ' ×' + quantity + ' — ' + status + returned);
      }
      let shown = 0;
      for (const line of itemLines) {
        if (lines.join('\n').length + line.length + 80 > 3800) break;
        lines.push(line);
        shown += 1;
      }
      if (items.length > shown) lines.push('…另有 ' + (items.length - shown) + ' 项菜品未显示');
    }
    const note = safeField(event.note, 200);
    if (note) lines.push('📝 <b>顾客备注</b>：\n<blockquote>' + escapeHtml(note) + '</blockquote>');
  }
  if (event.type === 'order.created' || event.type === 'order.settled') {
    const amount = Number(event.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 99999999) throw new TypeError('业务事件金额无效');
    const currency = safeField(event.currency || 'USD', 8);
    if (!/^[A-Z]{3,8}$/.test(currency)) throw new TypeError('业务事件币种无效');
    lines.push('💰 <b>金额</b>：<b>' + amount.toFixed(2) + ' ' + currency + '</b>');
  }
  if (event.type === 'order.refunded') {
    const amount = Number(event.refundAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999) throw new TypeError('退款金额无效');
    const currency = safeField(event.currency || 'USD', 8);
    if (!/^[A-Z]{3,8}$/.test(currency)) throw new TypeError('业务事件币种无效');
    lines.push('↩️ <b>退款金额</b>：<b>' + amount.toFixed(2) + ' ' + currency + '</b>');
  }
  lines.push('━━━━━━━━━━━━━━━━━━', '智能订单通知');
  return lines.join('\n');
}
module.exports = { formatTelegramBusinessNotification, escapeHtml };
