/*
 * FoodFlow · SLF.role — 页面角色识别、登录跳转、取当前角色 token
 *
 * 认证头注入与 401 跳转已由 core.js 的 SLF.api._getAuthHeaders / 401 处理统一完成；
 * 这里只提供页面级便捷入口，消除各页手写 goLogin / token 判断的重复。
 */
(function (global) {
  'use strict';
  var SLF = global.SLF = global.SLF || {};

  // 路径首段 → 角色
  function current() {
    var p = (typeof location !== 'undefined' && location.pathname) ? location.pathname : '';
    p = p.replace(/\/+$/, '');
    if (p === '' || p === '/index.html') return 'customer';
    var seg = p.split('/')[1] || 'customer';
    return seg;
  }

  function token() {
    var r = current();
    if (!SLF.store) return null;
    if (r === 'cashier') return SLF.store.rawGet('cashierToken');
    if (r === 'waiter' || r === 'kitchen') {
      return SLF.store.rawGet('waiterToken') || SLF.store.rawGet('kitchenToken');
    }
    if (r === 'admin') {
      try { return sessionStorage.getItem('adminToken'); } catch (e) { return null; }
    }
    if (r === 'super') return SLF.store.rawGet('superToken');
    return null;
  }

  function loginUrl() {
    var r = current();
    return (r === 'customer') ? '/login' : '/login?type=' + r;
  }

  function goLogin() { global.location.href = loginUrl(); }

  // 页面入口校验：无 token 直接跳登录
  function require() {
    if (current() === 'customer') return true;
    if (!token()) { goLogin(); return false; }
    return true;
  }

  SLF.role = {
    current: current,
    token: token,
    loginUrl: loginUrl,
    goLogin: goLogin,
    require: require
  };
})(window);
