/*
 * pages/waiter-payment.js — 服务员端收款弹窗（对齐收银台）
 * 依赖：core.js（SLF.api / SLF.money / SLF.ui / SLF.t）
 * 加载顺序：在 pages/waiter.js 之后
 */
(function(){
'use strict';

const $ = (s) => document.querySelector(s);
const t = SLF.t;

const apiCall = (path, opt) => SLF.api.page(path, opt);

let paymentOrderId = null;
let payMethod = 'cash';
let khqrState = { orderId: null, expiresAt: 0, timer: null, pollTimer: null, providerId: null, bankName: '' };
let khqrProviders = [];
let enabledPaymentMethods = { cash: true, wechat: false, alipay: false, card: false, khqr: false };

/* ===== 金额 HTML ===== */
const moneyHtml = SLF.money.formatHtml;

/* ===== 加载商户启用的支付方式 ===== */
async function loadPaymentMethods() {
  try {
    const data = await apiCall('/cashier/payment-methods');
    enabledPaymentMethods = Object.assign(
      { cash: true, wechat: false, alipay: false, card: false, khqr: false },
      data.methods || {}
    );
    applyPaymentMethodsVisibility();
  } catch (e) {
    console.warn('[payment-methods] 加载失败:', e.message);
  }
}

function applyPaymentMethodsVisibility() {
  const map = { cash: '[data-method="cash"]', wechat: '[data-method="wechat"]', alipay: '[data-method="alipay"]', card: '[data-method="card"]' };
  Object.keys(map).forEach(k => {
    const el = document.querySelector('#paymentModal ' + map[k]);
    if (el) el.style.display = enabledPaymentMethods[k] ? '' : 'none';
  });
  // KHQR 动态按钮：按每个 bank 独立配置显示
  document.querySelectorAll('#paymentMethodsWrap [data-provider-id]').forEach(el => {
    const key = el.dataset.bankKey;
    el.style.display = enabledPaymentMethods[key] ? '' : 'none';
  });
}

/* ===== KHQR providers ===== */
async function loadKhqrProviders() {
  try {
    const data = await apiCall('/cashier/khqr/providers');
    khqrProviders = (data.providers || []).filter(p => p.enabled !== false);
    renderProviderButtons();
  } catch (e) {
    console.warn('[khqr] load providers failed:', e.message);
    khqrProviders = [];
  }
}

const BANK_ICON_MAP = { 'ABA': 'aba', 'ACLEDA': 'acleda', 'Bakong': 'KHQR', 'Wing': 'Wing', 'Chip Mong': 'ChipMong' };
const ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

function renderProviderButtons() {
  const container = document.querySelector('#paymentMethodsWrap');
  if (!container) return;
  container.querySelectorAll('[data-provider-id]').forEach(b => b.remove());
  if (!khqrProviders.length) return;
  // 按钮永远创建，显示/隐藏由 applyPaymentMethodsVisibility() 统一控制
  // （避免并行加载时 khqr 尚未更新就跳过渲染）

  khqrProviders.forEach(p => {
    const bankName = String(p.bank || '').trim();
    let iconFile = BANK_ICON_MAP[bankName];
    if (!iconFile) iconFile = bankName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const btn = document.createElement('button');
    btn.className = 'payment-method';
    btn.dataset.method = 'provider';
    btn.dataset.providerId = p.id;
    // ★ 银行唯一键（小写无空格），用于按商户配置独立控制显隐
    btn.dataset.bankKey = bankName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const label = bankName || t('scanPayFallback');
    const labelHtml = '<span class="pm-label" style="font-size:12px;font-weight:700;">' + label + '</span>';
    btn.innerHTML = '<span class="pm-icon" style="font-size:22px;">📱</span>' + labelHtml;

    let extIdx = 0;
    function tryNext() {
      if (extIdx >= ICON_EXTS.length) return;
      const ext = ICON_EXTS[extIdx++];
      const url = '/assets/vendor/payment-icons/' + iconFile + '.' + ext;
      const img = new Image();
      img.onload = function() {
        btn.innerHTML = '<span class="pm-icon pm-icon-aba"><img src="' + url + '" alt="' + label + '"></span>' + labelHtml;
      };
      img.onerror = tryNext;
      img.src = url;
    }
    tryNext();

    btn.addEventListener('click', () => selectPayMethod('provider', p.id));
    container.appendChild(btn);
  });
}

/* ===== 打开/关闭收款弹窗 ===== */
window.openPaymentModal = async function(orderId, orderHint) {
  // ★ 优先使用缓存订单，跳过 /orders/:id 请求
  let order = orderHint;
  if (!order && window._waiterOrderCache) {
    order = window._waiterOrderCache[orderId];
  }
  if (!order) {
    try { order = await apiCall('/orders/' + orderId); } catch (e) { order = null; }
  }
  if (!order) { SLF.ui.toast('❌ ' + (t('orderNotFound') || '订单不存在')); return; }

  // ★ 已通知收银员的订单不允许再次打开收款
  if (order.awaiting_confirm) {
    SLF.ui.toast('🔔 ' + (t('khqrAwaitConfirm', null, '已通知收银员，请等待确认')));
    return;
  }

  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) {
    SLF.ui.toast('⚠️ ' + (t('noDishes') || '无菜品') + '，无法结算');
    return;
  }
  const pendingCount = items.filter(i => i.itemStatus !== 'done').length;
  if (pendingCount > 0) {
    SLF.ui.toast('⚠️ ' + (t('itemsNotReady') || '菜品未全部完成，无法结算') + '（' + pendingCount + '）');
    return;
  }

  paymentOrderId = orderId;
  payMethod = 'cash';
  const amount = Number(order.total) || 0;
  $('#paymentAmount').innerHTML = moneyHtml(amount);
  $('#cashReceived').value = '';
  $('#cashChange').innerHTML = moneyHtml(0);
  document.querySelectorAll('#paymentModal .payment-method').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === 'cash');
  });
  $('#cashArea').style.display = 'block';
  renderQuickCash(amount);

  // ★ 立即显示弹窗（用户零等待）
  $('#paymentModal').classList.add('show');
  setTimeout(() => { const el = $('#cashReceived'); if (el) el.focus(); }, 100);
  if (SLF.ui && SLF.ui.applyI18n) SLF.ui.applyI18n($('#paymentModal'));

  // ★ 与收银员端一致：配置已在页面加载时预加载，弹窗打开不重新拉取
  //   只做异步刷新，避免阻塞弹窗显示（让配置变化能及时反映）
  (async () => {
    try { await loadPaymentMethods(); }
    catch (e) { console.warn('[payment] 加载支付方式失败', e.message); }
    if (SLF.ui && SLF.ui.applyI18n) SLF.ui.applyI18n($('#paymentModal'));
  })();
};

window.closePaymentModal = function() {
  $('#paymentModal').classList.remove('show');
  paymentOrderId = null;
};

window.selectPayMethod = function(method, providerId) {
  payMethod = method;
  document.querySelectorAll('#paymentModal .payment-method').forEach(btn => {
    const isActive = btn.dataset.method === method
      && (!providerId || btn.dataset.providerId === providerId);
    btn.classList.toggle('active', isActive);
  });
  $('#cashArea').style.display = method === 'cash' ? 'block' : 'none';
  if (method === 'provider' && paymentOrderId) {
    openKhqrModal(paymentOrderId, providerId);
  }
};

/* ===== 快捷金额 / 找零 ===== */
function renderQuickCash(amount) {
  const quick = [amount, 50, 100, 200, 500, 1000];
  const uniq = [...new Set(quick.map(n => Math.ceil(n)))];
  const el = $('#quickCash');
  if (!el) return;
  el.innerHTML = uniq.slice(0, 6).map(n =>
    '<button class="quick-cash-btn" onclick="window.setCash(' + n + ')">' + SLF.money.primary(n) + '</button>'
  ).join('');
}

window.setCash = function(n) {
  $('#cashReceived').value = n;
  window.onCashInput();
};

window.onCashInput = function() {
  const received = parseFloat($('#cashReceived').value) || 0;
  const order = window.__waiterPaymentOrderCache && window.__waiterPaymentOrderCache[paymentOrderId];
  // 没有订单缓存时用 total 元素反推不可靠，直接用 paymentAmount 里的数字
  let due = 0;
  const amtEl = $('#paymentAmount');
  if (amtEl) {
    const m = amtEl.textContent.match(/[\d,]+\.?\d*/);
    if (m) due = parseFloat(m[0].replace(/,/g, '')) || 0;
  }
  const change = Math.max(0, received - due);
  $('#cashChange').innerHTML = moneyHtml(change);
};

/* ===== 确认收款 ===== */
window.confirmPay = async function() {
  if (!paymentOrderId) return;
  const id = paymentOrderId;

  // ★ 防御性检查：订单已通知收银员则拒绝
  const _ord = (window._waiterOrderCache && window._waiterOrderCache[id]) || null;
  if (_ord && _ord.awaiting_confirm) {
    SLF.ui.toast('🔔 ' + (t('khqrAwaitConfirm', null, '已通知收银员，请等待确认')));
    window.closePaymentModal();
    return;
  }
  // 从 DOM 拿 due
  let due = 0;
  const amtEl = $('#paymentAmount');
  if (amtEl) {
    const m = amtEl.textContent.match(/[\d,]+\.?\d*/);
    if (m) due = parseFloat(m[0].replace(/,/g, '')) || 0;
  }

  if (payMethod === 'cash') {
    const received = parseFloat($('#cashReceived').value) || 0;
    if (received < due) {
      SLF.ui.toast('❌ ' + (t('insufficientCash') || '实收金额不足'));
      return;
    }
  }

  const btn = $('#confirmPayBtn');
  if (btn) btn.disabled = true;
  try {
    const body = { status: 'done', pay_method: payMethod };
    if (payMethod === 'cash') {
      body.cash_received = parseFloat($('#cashReceived').value) || 0;
      const changeText = $('#cashChange').textContent.replace(/[^0-9.]/g, '');
      body.cash_change = parseFloat(changeText) || 0;
    }
    // ★ 不再直接结算，改为通知收银员确认
    await apiCall('/waiter/khqr/notify', { method: 'POST', body: {
      order_id: id,
      pay_method: body.pay_method,
      cash_received: body.cash_received || 0,
      cash_change: body.cash_change || 0,
    }});
    SLF.ui.toast('🔔 ' + (t('notifyCashierConfirm') || '已通知收银员确认'));
    window.closePaymentModal();
    if (typeof window.closeWaiterModal === 'function') window.closeWaiterModal();
    if (typeof window.reloadWaiterData === 'function') await window.reloadWaiterData();
  } catch (e) {
    const msg = (e.message || '').includes('未完成菜品')
      ? (t('incompleteItemsError') || e.message)
      : e.message;
    SLF.ui.toast('❌ ' + msg);
  } finally {
    if (btn) btn.disabled = false;
  }
};

/* ===== KHQR 动态码 ===== */
function openKhqrModal(orderId, providerId, selectedCurrency) {
  selectedCurrency = String(selectedCurrency || "USD").toUpperCase();
  if (!["USD", "KHR"].includes(selectedCurrency)) selectedCurrency = "USD";
  khqrState.orderId = orderId;
  khqrState.providerId = providerId || null;
  $('#khqrImage').src = '';
  $('#khqrMerchant').textContent = '...';
  $('#khqrOrderNo').textContent = '';
  $('#khqrStatusBar').innerHTML = '<span>' + t('khqrGenerating') + '</span>';
  const btn = $('#khqrConfirmBtn');
  btn.disabled = true;
  btn.textContent = t('khqrGeneratingBtn');
  $('#khqrModal').classList.add('show');

  {
    const old = document.getElementById('khqrCurrencySwitch');
    if (old) old.remove();
    const sw = document.createElement('button');
    sw.id = 'khqrCurrencySwitch';
    sw.type = 'button';
    sw.textContent = selectedCurrency === 'USD' ? '$ USD  ⇄  ៛ KHR' : '៛ KHR  ⇄  $ USD';
    sw.setAttribute('aria-label', '切换 KHQR 收款币种');
    sw.style.cssText = 'display:block;width:100%;max-width:360px;margin:12px auto;padding:14px 18px;border-radius:12px;border:2px solid #16a34a;background:#166534;color:#fff;font-size:17px;font-weight:800;cursor:pointer;';
    sw.onclick = () => {
      if (typeof window.__khqrSwitchBusy !== 'undefined' && window.__khqrSwitchBusy) return;
      window.__khqrSwitchBusy = true;
      try {
        openKhqrModal(orderId, providerId, selectedCurrency === 'USD' ? 'KHR' : 'USD');
      } finally {
        setTimeout(() => { window.__khqrSwitchBusy = false; }, 500);
      }
    };
    const amountEl = document.getElementById('khqrAmount');
    if (amountEl && amountEl.parentNode) amountEl.parentNode.insertBefore(sw, amountEl);
  }
  if (SLF.ui && SLF.ui.applyI18n) SLF.ui.applyI18n($('#khqrModal'));

  apiCall('/cashier/khqr/generate', { method: 'POST', body: { order_id: orderId, provider_id: providerId || undefined, currency: selectedCurrency } })
    .then(res => {
      if (res.qr_data_url) $('#khqrImage').src = res.qr_data_url;
      else {
        const size = Math.min(560, Math.max(280, Math.floor(window.innerWidth * 0.7)));
        $('#khqrImage').src = '/api/cashier/khqr/qrimage?order_id=' + orderId + '&size=' + size + '&_t=' + Date.now();
      }
      // 金额
      (function(){
        const cur = String(res.currency || 'USD').toUpperCase();
        const sym = cur === 'KHR' ? '៛' : (cur === 'USD' ? '$' : '');
        const amt = Number(res.amount) || 0;
        const amtStr = ['KHR','VND','THB'].indexOf(cur) >= 0 ? Math.round(amt).toLocaleString('en-US') : amt.toFixed(2);
        let baseUSD = amt;
        if (cur !== 'USD') {
          try {
            const curObj = SLF.money.find(cur);
            if (curObj && Number(curObj.rate)) baseUSD = amt / Number(curObj.rate);
          } catch (e) {}
        }
        let secHtml = '';
        try {
          const altCode = (cur === 'KHR') ? 'USD' : 'KHR';
          const altStr = SLF.money.secondary(baseUSD, altCode);
          if (altStr) secHtml = '<span style="color:#999;font-size:13px;margin-left:6px;">(' + altStr + ')</span>';
        } catch (e) {}
        $('#khqrAmount').style.cssText =
          'display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px;width:100%;text-align:center;line-height:1.35;';
        $('#khqrAmount').innerHTML =
          '' +
          '<span style="color:#e85d3a;font-size:clamp(28px,6vw,42px);font-weight:800;">' + sym + amtStr + '</span>' +
          (secHtml ? secHtml.replace('margin-left:6px;', 'margin-left:0;') : '');
        const sw = document.getElementById('khqrCurrencySwitch');
        if (sw) sw.textContent = cur === 'USD' ? '$ USD  ⇄  ៛ KHR' : '៛ KHR  ⇄  $ USD';
      })();

      khqrState.bankName = res.provider_bank || '';
      {
        const el = $('#khqrMerchant');
        const bank = String(res.provider_bank || '');
        const map = { ABA: 'aba.png', ACLEDA: 'acleda.png', Wing: 'Wing.png', Bakong: 'KHQR.png', 'Chip Mong': 'KHQR.png' };
        el.replaceChildren();
        if (map[bank]) {
          const img = document.createElement('img');
          img.src = '/assets/vendor/payment-icons/' + map[bank];
          img.alt = bank;
          img.style.cssText = 'width:28px;height:28px;object-fit:contain;vertical-align:middle;margin-right:8px;';
          el.appendChild(img);
        }
        el.appendChild(document.createTextNode((bank ? bank + ' · ' : '') + (res.merchant_name || '')));
      }
      $('#khqrOrderNo').textContent = res.order_no || '';
      khqrState.expiresAt = new Date(res.expires_at).getTime();
      startKhqrCountdown();
      startKhqrPolling();
      btn.disabled = false;
      btn.textContent = t('khqrReceived');
      $('#khqrStatusBar').innerHTML = '<span>' + t('khqrWaitingScan') + '</span>';
    })
    .catch(e => {
      $('#khqrStatusBar').innerHTML = '<span style="color:#e74c3c;">❌ ' + (e.message || t('khqrGenerateFailed')) + '</span>';
      btn.textContent = '❌ ' + t('khqrGenerateFailed');
    });
}

window.closeKhqrModal = function() {
  $('#khqrModal').classList.remove('show');
  stopKhqrTimers();
  if (khqrState.orderId) {
    apiCall('/cashier/khqr/cancel', { method: 'POST', body: { order_id: khqrState.orderId } }).catch(() => {});
  }
  khqrState.orderId = null;
};

function closeKhqrModalSilent() {
  $('#khqrModal').classList.remove('show');
  stopKhqrTimers();
  khqrState.orderId = null;
}

function startKhqrCountdown() {
  stopKhqrTimers();
  const update = () => {
    const left = Math.max(0, khqrState.expiresAt - Date.now());
    const totalSec = Math.floor(left / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    const el = $('#khqrCountdown');
    if (el) {
      el.textContent = m + ':' + s;
      if (totalSec <= 60) {
        el.style.color = '#e74c3c';
      }
    }
    if (left <= 0) {
      stopKhqrTimers();
      const bar = $('#khqrStatusBar');
      if (bar) bar.innerHTML = '<span style="color:#e74c3c;">' + t('khqrExpired') + '</span>';
      const btn = $('#khqrConfirmBtn');
      if (btn) { btn.disabled = true; btn.textContent = t('khqrExpiredShort'); }
    }
  };
  update();
  khqrState.timer = setInterval(update, 1000);
}

function startKhqrPolling() {
  khqrState.pollTimer = setInterval(async () => {
    if (!khqrState.orderId) return;
    try {
      const fresh = await apiCall('/orders/' + khqrState.orderId);
      if (fresh && fresh.status === 'done') {
        stopKhqrTimers();
        SLF.ui.toast('✅ ' + (t('settleOrder') || '已收款'));
        closeKhqrModalSilent();
        if (typeof window.closeWaiterModal === 'function') window.closeWaiterModal();
        if (typeof window.reloadWaiterData === 'function') await window.reloadWaiterData();
      }
    } catch (e) { /* 静默 */ }
  }, 3000);
}

function stopKhqrTimers() {
  if (khqrState.timer) { clearInterval(khqrState.timer); khqrState.timer = null; }
  if (khqrState.pollTimer) { clearInterval(khqrState.pollTimer); khqrState.pollTimer = null; }
}

window.confirmKhqrReceived = async function() {
  if (!khqrState.orderId) return;
  const id = khqrState.orderId;
  const btn = $('#khqrConfirmBtn');
  btn.disabled = true;
  btn.textContent = t('khqrConfirming');
  try {
    // ★ 不再直接结算，改为通知收银员确认
    await apiCall('/waiter/khqr/notify', { method: 'POST', body: {
      order_id: id,
      pay_method: (khqrState.bankName || 'aba').toLowerCase(),
    }});
    SLF.ui.toast('🔔 ' + (t('notifyCashierConfirm') || '已通知收银员确认'));
    closeKhqrModalSilent();
    window.closePaymentModal();
    if (typeof window.closeWaiterModal === 'function') window.closeWaiterModal();
    if (typeof window.reloadWaiterData === 'function') await window.reloadWaiterData();
  } catch (e) {
    SLF.ui.toast('❌ ' + e.message);
    btn.disabled = false;
    btn.textContent = t('khqrReceived');
  }
};

/* ===== ESC 关闭 ===== */
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  if ($('#khqrModal') && $('#khqrModal').classList.contains('show')) { window.closeKhqrModal(); return; }
  if ($('#paymentModal') && $('#paymentModal').classList.contains('show')) { window.closePaymentModal(); return; }
});

/* ===== 点击遮罩关闭 ===== */
document.addEventListener('click', function(e) {
  if (e.target && e.target.id === 'paymentModal') window.closePaymentModal();
  if (e.target && e.target.id === 'khqrModal') window.closeKhqrModal();
});

/* ============================================================
   页面加载时预加载支付方式和 KHQR 图标
   （与收银员端一致：避免点击结算时图标逐个出现）
   ============================================================ */
(function preloadPaymentAssets() {
  function run() {
    // 未登录不预加载，避免 401
    if (!SLF.store.rawGet('waiterToken')) return;
    (async () => {
      try { await loadPaymentMethods(); } catch (e) {}
      try { await loadKhqrProviders(); } catch (e) {}
    })();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(run, 500); });
  } else {
    setTimeout(run, 500);
  }
})();

})();
