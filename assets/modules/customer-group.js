/*
 * FoodFlow · SLF.customerGroup — 按 customer_token 的客户分组、标签配色（唯一实现）
 *
 * 同一桌/会话内可能有多批顾客（各自扫码），按 customerToken 出现顺序分配 1-based 编号，
 * 并为标签循环配色；staffOrder（服务员代下单）由各页业务判断后自行决定文案。
 */
(function (global) {
  'use strict';
  var SLF = global.SLF = global.SLF || {};

  var PALETTE = [
    { bg: 'rgba(123, 104, 238, .15)', color: '#7b68ee' },
    { bg: 'rgba(232, 93, 58, .15)', color: '#e85d3a' },
    { bg: 'rgba(46, 204, 113, .15)', color: '#2ecc71' },
    { bg: 'rgba(52, 152, 219, .15)', color: '#3498db' },
    { bg: 'rgba(241, 196, 15, .15)', color: '#f39c12' },
    { bg: 'rgba(231, 76, 60, .15)', color: '#e74c3c' },
    { bg: 'rgba(26, 188, 156, .15)', color: '#1abc9c' },
    { bg: 'rgba(155, 89, 182, .15)', color: '#9b59b6' },
    { bg: 'rgba(52, 73, 94, .15)', color: '#34495e' },
    { bg: 'rgba(230, 126, 34, .15)', color: '#e67e22' },
    { bg: 'rgba(39, 174, 96, .15)', color: '#27ae60' },
    { bg: 'rgba(41, 128, 185, .15)', color: '#2980b9' }
  ];

  var DEFAULT = { bg: 'rgba(149, 165, 166, .15)', color: '#95a5a6' };

  SLF.customerGroup = {
    PALETTE: PALETTE,
    // 由标签文字（含数字编号）反查配色
    color: function (label) {
      var m = String(label == null ? '' : label).match(/\d+/);
      if (m) return PALETTE[(parseInt(m[0], 10) - 1) % PALETTE.length];
      return DEFAULT;
    },
    // 从一组订单提取 distinct customerToken → 1-based 索引 Map
    buildIndex: function (orders) {
      var distinct = [];
      var seen = {};
      (orders || []).forEach(function (o) {
        if (o && o.customerToken && !seen[o.customerToken]) {
          seen[o.customerToken] = 1;
          distinct.push(o.customerToken);
        }
      });
      return new Map(distinct.map(function (ct, i) { return [ct, i + 1]; }));
    }
  };
})(window);
