/*
 * FoodFlow · SLF.orderStatus — 订单/菜品状态文案、颜色、判断工具（唯一实现）
 *
 * 两套状态：
 *   订单结算状态 order.status:  pending | done | canceled | refunded
 *   菜品制作状态 item.itemStatus: pending | done
 * 文案通过 SLF.i18n.t 取（key: orderPending/orderDone/canceled/refunded 与 pending/itemDone），
 * 保留各页既有视角语义；这里只集中颜色、class 与重复的完成判断，避免各页内联重复。
 */
(function (global) {
  'use strict';
  var SLF = global.SLF = global.SLF || {};
  function t(k, fb) {
    if (!SLF.i18n) return fb;
    var v = SLF.i18n.t(k);
    return (v === undefined || v === null || v === k) ? (fb || k) : v;
  }

  var ORDER_COLORS = { pending: '#f39c12', done: '#27ae60', canceled: '#95a5a6', refunded: '#e74c3c' };
  var ITEM_COLORS = { pending: '#f39c12', done: '#27ae60' };

  SLF.orderStatus = {
    // 订单状态文案
    orderText: function (status) {
      if (status === 'done') return t('orderDone', t('completed', '已完成'));
      if (status === 'canceled') return t('canceled', '已取消');
      if (status === 'refunded') return t('refunded', '已退款');
      return t('orderPending', t('pendingSettlement', '未结算'));
    },
    // 菜品状态文案
    itemText: function (status) {
      if (status === 'done') return t('itemDone', t('completed', '已完成'));
      return t('pending', t('inProgress', '制作中'));
    },
    orderColor: function (status) { return ORDER_COLORS[status] || ORDER_COLORS.pending; },
    itemColor: function (status) { return ITEM_COLORS[status] || ITEM_COLORS.pending; },
    orderClass: function (status) {
      return status === 'done' ? 'status-done' : status === 'canceled' ? 'status-canceled' : 'status-pending';
    },
    itemClass: function (status) { return status === 'done' ? 'done' : 'pending'; },
    isItemDone: function (item) { return item && item.itemStatus === 'done'; },
    // 订单是否所有菜品都已完成（非空且全部 done）
    allItemsDone: function (order) {
      var items = (order && order.items) || [];
      return items.length > 0 && items.every(function (i) { return i.itemStatus === 'done'; });
    },
    // 订单是否可结算：有菜品且全部完成
    canSettle: function (order) { return SLF.orderStatus.allItemsDone(order); }
  };
})(window);
