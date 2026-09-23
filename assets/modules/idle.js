/*
 * FoodFlow · SLF.idle — 无操作自动登出（统一实现）
 *
 * waiter / cashier / kitchen 三页原本各自重复实现 idle 定时器与事件监听，
 * 现统一为：start({ timeoutMin, onTimeout, rememberKey? })。
 * rememberKey 存在且值为 '1'（"记住我"）时不启用自动登出。
 */
(function (global) {
  'use strict';
  var SLF = global.SLF = global.SLF || {};

  var EVENTS = ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'];
  var timer = null;
  var arm = null;

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  SLF.idle = {
    start: function (opts) {
      opts = opts || {};
      this.stop();
      EVENTS.forEach(function (e) {
        document.removeEventListener(e, arm);
      });
      var ms = (opts.timeoutMin || 20) * 60 * 1000;
      arm = function () {
        stop();
        if (opts.rememberKey && SLF.store.rawGet(opts.rememberKey) === '1') return;
        timer = setTimeout(opts.onTimeout, ms);
      };
      EVENTS.forEach(function (e) {
        document.addEventListener(e, arm, { passive: true });
      });
      arm();
    },
    // 配置变化后用新超时重启
    update: function (timeoutMin, onTimeout, rememberKey) {
      this.start({ timeoutMin: timeoutMin, onTimeout: onTimeout, rememberKey: rememberKey });
    },
    reset: function () { if (arm) arm(); },
    stop: stop
  };
})(window);
