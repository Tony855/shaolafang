/* ============================================================
   pages/khqr-shared.js — KHQR 收款弹窗共用渲染函数
   收银员端 + 服务员端共用，改这一份即可
   ============================================================ */
(function () {
  'use strict';

  var BANK_ICON_MAP = {
    'ABA': 'aba.png',
    'ACLEDA': 'acleda.png',
    'Wing': 'Wing.png',
    'Bakong': 'KHQR.png',
    'Chip Mong': 'KHQR.png'
  };

  function renderPayee(merchantEl, orderNoEl, res) {
    res = res || {};
    var el = (typeof merchantEl === 'string')
      ? document.getElementById(merchantEl) : merchantEl;
    var noEl = (typeof orderNoEl === 'string')
      ? document.getElementById(orderNoEl) : orderNoEl;
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
    renderPayee: renderPayee
  };
})();
