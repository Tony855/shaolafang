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
let khqrState = { orderId: null, expiresAt: 0, timer: null, pollTimer: null, providerId: null };
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
  // ABA 按钮：只在 khqr 启用时显示
  const abaBtn = document.querySelector('#paymentModal [data-method="aba"]');
  if (abaBtn) abaBtn.style.display = enabledPaymentMethods.khqr ? '' : 'none';
  if (!enabledPaymentMethods.khqr) {
    document.querySelectorAll('#paymentMethodsWrap [data-provider-id]').forEach(el => el.style.display = 'none');
  }
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
  // 隐藏静态 ABA 按钮（避免与动态 provider 重复）
  const abaBtn = container.querySelector('[data-method="aba"]');
  if (abaBtn) abaBtn.style.display = 'none';
  if (!enabledPaymentMethods.khqr) return;
  if (!khqrProviders.length) return;

  khqrProviders.forEach(p => {
    const bankName = String(p.bank || '').trim();
    let iconFile = BANK_ICON_MAP[bankName];
    if (!iconFile) iconFile = bankName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const btn = document.createElement('button');
    btn.className = 'payment-method';
    btn.dataset.method = 'provider';
    btn.dataset.providerId = p.id;
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
  let order = orderHint;
  if (!order) {
    try { order = await apiCall('/orders/' + orderId); } catch (e) { order = null; }
  }
  if (!order) { SLF.ui.toast('❌ ' + (t('orderNotFound') || '订单不存在')); return; }

  // 菜品检查：全部完成才允许结算（与后端一致，提前拦截，避免弹窗被拒）
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
  await loadPaymentMethods();
  await loadKhqrProviders();
  $('#paymentModal').classList.add('show');
  setTimeout(() => { const el = $('#cashReceived'); if (el) el.focus(); }, 100);
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
  if ((method === 'aba' || method === 'provider') && paymentOrderId) {
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
    await apiCall('/orders/' + id, { method: 'PUT', body });
    SLF.ui.toast('✅ ' + (t('settleOrder') || '已结算'));
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
function openKhqrModal(orderId, providerId) {
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

  apiCall('/cashier/khqr/generate', { method: 'POST', body: { order_id: orderId, provider_id: providerId || undefined } })
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
        const amtStr = cur === 'KHR' ? Math.round(amt).toLocaleString('en-US') : amt.toFixed(2);
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
        $('#khqrAmount').innerHTML = '<span style="color:#e85d3a;font-weight:800;">' + sym + amtStr + '</span>' + secHtml;
      })();

      $('#khqrMerchant').textContent = (res.provider_bank ? res.provider_bank + ' · ' : '') + (res.merchant_name || '');
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
    await apiCall('/orders/' + id, { method: 'PUT', body: { status: 'done', pay_method: 'aba' } });
    SLF.ui.toast('✅ ' + (t('settleOrder') || '已收款'));
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

})();
