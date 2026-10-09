/* ============================================================
   pages/khqr-shared.js — KHQR 收款弹窗共用渲染函数
   收银员端 + 服务员端共用，改这一份即可
   银行映射从 /api/public/khqr/banks 拉取（唯一来源见
   server/config/khqr-banks.js）
   ============================================================ */
(function () {
  'use strict';

  // ★ 默认映射（API 未返回前的兜底，与 server/config/khqr-banks.js 一致）
  var BANK_ICON_MAP = {
    'ABA': 'aba.png',
    'ACLEDA': 'acleda.png',
    'Wing': 'Wing.png',
    'Bakong': 'KHQR.png',
    'Chip Mong': 'KHQR.png',
    'Other': 'KHQR.png'
  };

  var _banksLoaded = false;

  function loadBankMap() {
    if (_banksLoaded) return;
    _banksLoaded = true;
    fetch('/api/public/khqr/banks', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.banks)) return;
        var map = {};
        data.banks.forEach(function (b) { if (b.name && b.icon) map[b.name] = b.icon; });
        if (data.defaultBank && data.defaultBank.name) {
          map[data.defaultBank.name] = data.defaultBank.icon;
        }
        BANK_ICON_MAP = map;
      })
      .catch(function (e) { console.warn('[khqr-shared] 银行映射拉取失败:', e.message); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadBankMap);
  } else {
    loadBankMap();
  }

  function renderPayee(merchantEl, orderNoEl, res) {
    res = res || {};
    var el = (typeof merchantEl === 'string') ? document.getElementById(merchantEl) : merchantEl;
    var noEl = (typeof orderNoEl === 'string') ? document.getElementById(orderNoEl) : orderNoEl;
    if (!el) return;

    var bank = String(res.provider_bank || '');
    var iconFile = BANK_ICON_MAP[bank];

    el.replaceChildren();

    if (iconFile) {
      var img = document.createElement('img');
      img.className = 'bank-icon';
      img.src = '/assets/vendor/payment-icons/' + iconFile;
      img.alt = bank;
      el.appendChild(img);
    }

    var nameSpan = document.createElement('span');
    nameSpan.className = 'merchant-name';
    nameSpan.textContent = (bank ? bank + ' · ' : '') + (res.merchant_name || '');
    el.appendChild(nameSpan);

    if (noEl) noEl.textContent = res.order_no || '';
  }

  window.KHQRShared = {
    BANK_ICON_MAP: BANK_ICON_MAP,
    renderPayee: renderPayee,
    loadBankMap: loadBankMap
  };
})();
