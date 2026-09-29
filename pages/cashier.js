/*
 * FoodFlow · 收银台（POS 重构版 2026-09-29）
 */
(function(){
'use strict';

  /* ===== 全局状态 ===== */
  let currentLang = SLF.store.rawGet('cashierLang') || SLF.store.rawGet('lang') || 'zh';
  let cashierInfo = null;
  let orders = [];
  let currentTab = 'pending';
  let selectedOrderId = null;
  let searchKeyword = '';
  let currencies = [];
  let defaultCurrency = { symbol: '$', rate: 1, code: 'USD' };
  let dualCurrency = { enabled: false, currency: null };
  let refreshInterval = 15;
  let refreshTimer = null;
  let _socketConnected = false;
  let clockTimer = null;

  // 收款弹窗状态
  let paymentOrderId = null;
  let payMethod = 'cash';

  SLF.i18n.init(currentLang);

  /* ===== 工具 ===== */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function formatTime(iso) {
    if (!iso) return '-';
    try {
      const d = new Date(iso);
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    } catch (e) { return iso; }
  }
  function itemBasePrice(item) {
    return SLF.money.toBase(item.price, item.currency_code);
  }
  function itemLineTotal(item) {
    const qty = Number(item.quantity || 0) - Number(item.returnedQty || 0);
    return itemBasePrice(item) * qty;
  }

  function goLogin() {
    window.location.href = '/login?type=cashier';
  }

  function logout() {
    showConfirm(t('logout'), t('confirmLogout'), function() {
      const token = SLF.store.rawGet('cashierToken');
      if (token) {
        SLF.api.post('/cashier/logout', null, { headers: { 'X-Cashier-Token': token } }).catch(() => {});
      }
      SLF.store.rawRemove('cashierToken');
      SLF.store.rawRemove('cashierStoreId');
      SLF.store.rawRemove('cashierInfo');
      SLF.store.rawRemove('storeId');
      window.location.href = '/login?type=cashier';
    }, { type: 'warning', icon: '🚪' });
  }

  // 空闲超时
  let cashierIdleTimeoutMin = 30;
  function cashierIdleLogout() {
    SLF.store.rawRemove('cashierToken');
    SLF.store.rawRemove('cashierStoreId');
    SLF.store.rawRemove('cashierInfo');
    SLF.store.rawRemove('storeId');
    window.location.href = '/login?type=cashier';
  }
  SLF.idle.start({ timeoutMin: cashierIdleTimeoutMin, onTimeout: cashierIdleLogout });
  SLF.api.get('/public/global-config').then(cfg => {
    if (cfg.cashier_idle_timeout) SLF.idle.update(cfg.cashier_idle_timeout, cashierIdleLogout);
  }).catch(() => {});

  // 时钟
  function startClock() {
    if (clockTimer) return;
    const update = () => {
      const el = document.getElementById('clock');
      if (!el) return;
      const d = new Date();
      el.textContent = [
        d.getHours(), d.getMinutes(), d.getSeconds()
      ].map(n => String(n).padStart(2, '0')).join(':');
    };
    update();
    clockTimer = setInterval(update, 1000);
  }

  // 语言
  async function changeLang(lang) {
    currentLang = lang;
    SLF.store.rawSet('cashierLang', lang);
    SLF.store.rawSet('lang', lang);
    await SLF.i18n.init(lang);
    applyLang();
    renderOrders();
    renderDetail();
  }

  function applyLang() {
    const langSel = document.getElementById('langSelect');
    if (langSel) langSel.value = currentLang;
    document.getElementById('tabPending').innerHTML = t('pendingOrders') + ' <span class="pos-tab-count" id="pendingCount">0</span>';
    document.getElementById('tabSettled').innerHTML = t('settledOrders') + ' <span class="pos-tab-count" id="settledCount">0</span>';
    document.getElementById('todayLabel').textContent = t('todayCount');
    document.getElementById('revenueLabel').textContent = t('todayRevenue');
    document.getElementById('logoutBtn').textContent = t('logout');
    document.getElementById('searchInput').placeholder = '🔍 ' + t('searchPlaceholder');
    document.getElementById('detailEmpty').querySelector('p').textContent = t('selectOrder') || '← 从左侧选择一个订单';
    document.getElementById('paymentTitle').textContent = t('settleOrder') || '收款';
  }

  /* ===== Tab 切换 ===== */
  function switchTab(tab) {
    currentTab = tab;
    selectedOrderId = null;
    document.querySelectorAll('.pos-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    renderOrders();
    renderDetail();
  }

  /* ===== API ===== */
  async function api(url, options = {}) {
    const cashierStoreId = SLF.store.rawGet('cashierStoreId');
    if (cashierStoreId) SLF.store.rawSet('storeId', cashierStoreId);
    const method = (options.method || 'GET').toUpperCase();
    if (method === 'GET') return SLF.api.get(url, options);
    if (method === 'POST') return SLF.api.post(url, options.body, options);
    if (method === 'PUT') return SLF.api.put(url, options.body, options);
    if (method === 'DELETE') return SLF.api.del(url, options);
    return SLF.api._request(method, url, options);
  }

  async function loadOrders() {
    try {
      const data = await api('/cashier/orders');
      orders = data.orders || [];
      renderOrders();
      renderDetail();
      updateBottomStats();
    } catch (e) {
      if (e.message.includes('请先登录') || e.message.includes('登录已过期')) {
        SLF.store.rawRemove('cashierToken');
        window.location.href = '/login?type=cashier';
      } else {
        SLF.ui.toast('❌ ' + e.message);
      }
    }
  }

  /* ===== 左侧列表渲染 ===== */
  function renderOrders() {
    const container = document.getElementById('orderList');
    let filtered = (currentTab === 'settled')
      ? orders.filter(o => o.status !== 'pending')
      : orders.filter(o => o.status === 'pending');

    if (searchKeyword) {
      const q = searchKeyword.toLowerCase();
      filtered = filtered.filter(o =>
        (o.table_name || '').toLowerCase().includes(q) ||
        String(o.order_no || o.id).toLowerCase().includes(q)
      );
    }

    // 待结按时间正序（早的在前），已结按时间倒序（晚的在前）
    filtered.sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime();
      const tb = new Date(b.createdAt || 0).getTime();
      return currentTab === 'settled' ? tb - ta : ta - tb;
    });

    // 更新计数
    const pendingCountEl = document.getElementById('pendingCount');
    const settledCountEl = document.getElementById('settledCount');
    if (pendingCountEl) pendingCountEl.textContent = orders.filter(o => o.status === 'pending').length;
    if (settledCountEl) settledCountEl.textContent = orders.filter(o => o.status !== 'pending').length;

    if (!filtered.length) {
      container.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#9ca3af;font-size:14px;">' + (searchKeyword ? '🔍 无匹配结果' : t('noOrders')) + '</div>';
      return;
    }

    container.innerHTML = filtered.map(order => {
      const total = SLF.money.format(Number(order.total) || 0);
      const itemCount = (order.items || []).length;
      const isSelected = order.id === selectedOrderId;
      const sessionLabels = buildSessionLabels([order]);
      const customerLabel = sessionLabels.get(order.id) || '';

      return `<div class="pos-order-card ${isSelected ? 'selected' : ''}" onclick="selectOrder(${order.id})">
        <div class="pos-order-card-head">
          <div class="pos-order-card-table">🪑 ${esc(order.table_name || '-')}</div>
          <div class="pos-order-card-time">${formatTime(order.createdAt)}</div>
        </div>
        <div class="pos-order-card-no">${esc(order.order_no || ('#' + order.id))}</div>
        <div class="pos-order-card-meta">
          <span class="pos-order-card-items">${itemCount} ${t('dishes') || '道菜品'}</span>
          <span class="pos-order-card-amount">${total}</span>
        </div>
        ${customerLabel && customerLabel.trim() ? `<div class="pos-order-card-tags"><span class="pos-tag ${customerLabel === t('staffOrder') ? 'staff' : 'customer'}">${esc(customerLabel)}</span></div>` : ''}
      </div>`;
    }).join('');
  }

  function selectOrder(id) {
    selectedOrderId = id;
    renderOrders();
    renderDetail();
  }

  function closeDetail() {
    selectedOrderId = null;
    renderOrders();
    renderDetail();
  }

  function buildSessionLabels(orderList) {
    const labels = new Map();
    const tableGroups = {};
    orderList.forEach(o => {
      const key = o.table_name || 'unknown';
      if (!tableGroups[key]) tableGroups[key] = [];
      tableGroups[key].push(o);
    });
    Object.values(tableGroups).forEach(group => {
      const tokenToIndex = SLF.customerGroup.buildIndex(group);
      group.forEach(o => {
        // 只有 sessionToken 和 customerToken 都存在才显示客户标签
        if (o.sessionToken && o.customerToken && tokenToIndex.has(o.customerToken)) {
          labels.set(o.id, t('customer') + tokenToIndex.get(o.customerToken));
        } else if (o.sessionToken) {
          // 有 session 但没 customerToken（旧数据），不显示标签
          labels.set(o.id, '');
        } else {
          labels.set(o.id, t('staffOrder'));
        }
      });
    });
    return labels;
  }

  /* ===== 右侧详情渲染 ===== */
  function renderDetail() {
    const emptyEl = document.getElementById('detailEmpty');
    const detailEl = document.getElementById('detailView');
    const order = orders.find(o => o.id === selectedOrderId);

    if (!order) {
      emptyEl.style.display = 'flex';
      detailEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    detailEl.style.display = 'flex';

    document.getElementById('detailTable').textContent = '🪑 ' + (order.table_name || '-');
    document.getElementById('detailOrderNo').textContent = order.order_no || ('#' + order.id);
    const badge = document.getElementById('detailStatus');
    const statusMap = {
      pending: { text: t('pendingSettlement') || '未结算', cls: '' },
      done: { text: t('settled') || '已结算', cls: 'done' },
      canceled: { text: t('canceled') || '已取消', cls: 'canceled' },
      refunded: { text: t('refunded') || '已退款', cls: 'refunded' }
    };
    const st = statusMap[order.status] || statusMap.pending;
    badge.textContent = st.text;
    badge.className = 'pos-detail-badge ' + st.cls;
    document.getElementById('detailTime').textContent = '🕐 ' + (order.createdAt ? new Date(order.createdAt).toLocaleString() : '-');

    // 菜品明细
    const itemsEl = document.getElementById('detailItems');
    itemsEl.innerHTML = (order.items || []).map(item => {
      const qty = Number(item.quantity) || 0;
      const returned = Number(item.returnedQty) || 0;
      const lineBase = itemBasePrice(item) * (qty - returned);
      return `<div class="pos-detail-item">
        <div class="pos-detail-item-name">
          <span class="emoji">${esc(item.emoji || '🍽️')}</span>
          <span>${esc(item.name)}${returned > 0 ? ` <span style="color:#e74c3c;font-size:12px;">(${t('returned') || '退'} ${returned})</span>` : ''}</span>
        </div>
        <div class="pos-detail-item-qty">× ${qty}</div>
        <div class="pos-detail-item-price">${SLF.money.format(lineBase)}</div>
      </div>`;
    }).join('') || '<div style="text-align:center;padding:20px;color:#9ca3af;">' + (t('noDishes') || '无菜品') + '</div>';

    // 金额
    const totalDisplay = SLF.money.format(Number(order.total) || 0);
    document.getElementById('detailTotal').textContent = totalDisplay;
    document.getElementById('detailDue').textContent = totalDisplay;

    // 按钮
    const btnsEl = document.getElementById('detailButtons');
    const canSettle = order.status === 'pending' && SLF.orderStatus.allItemsDone(order);
    const canCancel = order.status === 'pending';
    let btns = '';
    if (canSettle) {
      btns += `<button class="btn btn-pay" onclick="openPaymentModal(${order.id})">💵 ${t('settleOrder') || '收款'}</button>`;
    } else if (order.status === 'pending') {
      btns += `<button class="btn btn-pay" disabled title="${t('itemsNotReady') || '菜品未全部完成'}">💵 ${t('settleOrder') || '收款'} (未就绪)</button>`;
    }
    btns += `<button class="btn btn-print" onclick="printOrder(${order.id})" title="${t('print') || '打印'}">🖨</button>`;
    if (canCancel) {
      btns += `<button class="btn btn-cancel-order" onclick="cancelOrder(${order.id})" title="${t('cancelOrder') || '取消'}">✕</button>`;
    }
    btnsEl.innerHTML = btns;
  }

  function updateBottomStats() {
    const today = new Date().toISOString().split('T')[0];
    const todayOrders = orders.filter(o => (o.createdAt || '').startsWith(today));
    const revenueBase = todayOrders.filter(o => o.status === 'done').reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
    document.getElementById('todayCount').textContent = todayOrders.length;
    document.getElementById('todayRevenue').textContent = SLF.money.format(revenueBase);
  }

  /* ===== 收款弹窗 ===== */
  function openPaymentModal(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    paymentOrderId = orderId;
    payMethod = 'cash';
    const amount = Number(order.total) || 0;
    document.getElementById('paymentAmount').textContent = SLF.money.format(amount);
    document.getElementById('cashReceived').value = '';
    document.getElementById('cashChange').textContent = SLF.money.format(0);
    document.querySelectorAll('.payment-method').forEach(btn => btn.classList.toggle('active', btn.dataset.method === 'cash'));
    document.getElementById('cashArea').style.display = 'block';
    renderQuickCash(amount);
    document.getElementById('paymentModal').classList.add('show');
    setTimeout(() => document.getElementById('cashReceived').focus(), 100);
  }

  function closePaymentModal() {
    document.getElementById('paymentModal').classList.remove('show');
    paymentOrderId = null;
  }

  function selectPayMethod(method) {
    payMethod = method;
    document.querySelectorAll('.payment-method').forEach(btn => btn.classList.toggle('active', btn.dataset.method === method));
    document.getElementById('cashArea').style.display = method === 'cash' ? 'block' : 'none';
  }

  function renderQuickCash(amount) {
    const quick = [amount, 50, 100, 200, 500, 1000];
    const uniq = [...new Set(quick.map(n => Math.ceil(n)))];
    document.getElementById('quickCash').innerHTML = uniq.slice(0, 6).map(n =>
      `<button class="quick-cash-btn" onclick="setCash(${n})">${SLF.money.primary(n)}</button>`
    ).join('');
  }

  function setCash(n) {
    document.getElementById('cashReceived').value = n;
    onCashInput();
  }

  function onCashInput() {
    const order = orders.find(o => o.id === paymentOrderId);
    if (!order) return;
    const received = parseFloat(document.getElementById('cashReceived').value) || 0;
    const due = Number(order.total) || 0;
    const change = Math.max(0, received - due);
    document.getElementById('cashChange').textContent = SLF.money.format(change);
  }

  async function confirmPay() {
    if (!paymentOrderId) return;
    const order = orders.find(o => o.id === paymentOrderId);
    if (!order) return;
    const due = Number(order.total) || 0;

    if (payMethod === 'cash') {
      const received = parseFloat(document.getElementById('cashReceived').value) || 0;
      if (received < due) {
        SLF.ui.toast('❌ 实收金额不足');
        return;
      }
    }

    const btn = document.getElementById('confirmPayBtn');
    btn.disabled = true;
    try {
      const body = { pay_method: payMethod };
      if (payMethod === 'cash') {
        body.cash_received = parseFloat(document.getElementById('cashReceived').value) || 0;
        body.cash_change = parseFloat(document.getElementById('cashChange').textContent.replace(/[^0-9.]/g, '')) || 0;
      }
      await api('/cashier/orders/' + paymentOrderId + '/settle', { method: 'PUT', body });
      SLF.ui.toast('✅ ' + (t('settleSuccess') || '收款成功'));
      closePaymentModal();
      selectedOrderId = null;
      await loadOrders();
    } catch (e) {
      SLF.ui.toast('❌ ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  /* ===== 打印 / 取消 ===== */
  async function printOrder(orderId) {
    try {
      await api('/cashier/orders/' + orderId + '/print', { method: 'POST' });
      SLF.ui.toast('🖨 ' + (t('print') || '打印') + '...');
    } catch (e) {
      SLF.ui.toast('❌ ' + e.message);
    }
  }

  function cancelOrder(orderId) {
    showConfirm(t('cancelOrder'), t('confirmCancel'), async function() {
      try {
        await api('/cashier/orders/' + orderId + '/cancel', { method: 'PUT' });
        SLF.ui.toast('✅ ' + (t('cancelSuccess') || '已取消'));
        selectedOrderId = null;
        await loadOrders();
      } catch (e) {
        SLF.ui.toast('❌ ' + e.message);
      }
    }, { type: 'warning', icon: '⚠️' });
  }

  /* ===== 确认弹窗 ===== */
  let confirmCallback = null;
  function showConfirm(title, message, callback, options = {}) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').innerHTML = message;
    document.getElementById('confirmIcon').textContent = options.icon || '⚠️';
    document.getElementById('confirmOkBtn').textContent = options.okText || t('confirm');
    document.getElementById('confirmCancelBtn').textContent = options.cancelText || t('cancel');
    if (options.type === 'danger') {
      document.getElementById('confirmOkBtn').className = 'btn btn-danger';
    } else if (options.type === 'warning') {
      document.getElementById('confirmOkBtn').className = 'btn btn-primary';
    } else {
      document.getElementById('confirmOkBtn').className = 'btn btn-primary';
    }
    confirmCallback = callback;
    document.getElementById('confirmModal').classList.add('show');
  }
  function hideConfirm() {
    document.getElementById('confirmModal').classList.remove('show');
    confirmCallback = null;
  }
  function executeConfirm() {
    if (confirmCallback) {
      const cb = confirmCallback;
      hideConfirm();
      cb();
    }
  }

  /* ===== 初始化 ===== */
  async function init() {
    applyLang();
    startClock();
    const token = SLF.store.rawGet('cashierToken');
    if (!token) {
      document.documentElement.removeAttribute('data-cashier-session');
      document.getElementById('loginModal').classList.add('show');
      return;
    }
    document.getElementById('loginModal').classList.remove('show');
    try {
      const info = JSON.parse(SLF.store.rawGet('cashierInfo') || '{}');
      cashierInfo = info;
      const storeId = SLF.store.rawGet('cashierStoreId') || '1';
      SLF.store.rawSet('storeId', storeId);
      document.getElementById('storeName').textContent = cashierInfo.storeName || (t('store') + ' #' + storeId);
      document.getElementById('cashierName').textContent = cashierInfo.display_name || cashierInfo.username || '收银员';
      try {
        const cfg = await SLF.api.get('/public/config?store_id=' + (SLF.store.rawGet('storeId') || 1));
        currencies = cfg.currencies || [];
        defaultCurrency = cfg.defaultCurrency || { symbol: '$', rate: 1, code: 'USD' };
        dualCurrency = cfg.dualCurrency || { enabled: false, currency: null };
        SLF.money.configure({ currencies, defaultCurrency, dualCurrency });
        const ri = parseInt(cfg.waiter_refresh_interval, 10);
        if (!isNaN(ri) && ri >= 3) refreshInterval = ri;
      } catch (e) { console.error('currency load failed', e); }

      // 事件绑定
      document.getElementById('searchInput').addEventListener('input', e => {
        searchKeyword = e.target.value.trim();
        renderOrders();
      });

      await loadOrders();
      if (refreshTimer) clearInterval(refreshTimer);
      if (!_socketConnected) {
        refreshTimer = setInterval(() => {
          if (!_socketConnected) loadOrders();
        }, refreshInterval * 1000);
      }
    } catch (e) {
      console.error(e);
    }
  }

  // Modal 关闭
  document.getElementById('confirmModal').addEventListener('click', function(e) {
    if (e.target === this) hideConfirm();
  });
  document.getElementById('paymentModal').addEventListener('click', function(e) {
    if (e.target === this) closePaymentModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (document.getElementById('paymentModal').classList.contains('show')) {
        closePaymentModal();
      } else if (document.getElementById('confirmModal').classList.contains('show')) {
        hideConfirm();
      } else if (selectedOrderId) {
        closeDetail();
      }
    }
    if (e.key === 'Enter' && document.getElementById('paymentModal').classList.contains('show')) {
      e.preventDefault();
      confirmPay();
    }
  });

  /* ===== Socket ===== */
  if (typeof io === 'function') {
    const cashierSocket = io({
      query: {
        storeId: SLF.store.rawGet('storeId') || 1,
        token: SLF.store.rawGet('cashierToken') || ''
      }
    });
    function belongsToStore(o) {
      const sid = SLF.store.rawGet('cashierStoreId') || SLF.store.rawGet('storeId') || '1';
      return !o || !o.store_id || String(o.store_id) === String(sid);
    }
    cashierSocket.on('order:new', (order) => {
      if (!order || !belongsToStore(order)) return;
      if (order.status !== 'pending') return;
      orders = orders.filter(o => o.id !== order.id);
      orders.unshift(order);
      renderOrders();
      updateBottomStats();
    });
    cashierSocket.on('item:updated', (payload) => {
      if (!payload || !payload.order) return;
      const updated = payload.order;
      if (!belongsToStore(updated)) return;
      orders = orders.map(o => o.id === updated.id ? updated : o);
      renderOrders();
      renderDetail();
    });
    cashierSocket.on('order:settled', () => { loadOrders(); });
    cashierSocket.on('order:transfer', () => { loadOrders(); });
    cashierSocket.on('connect', () => {
      _socketConnected = true;
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      loadOrders();
    });
    cashierSocket.on('disconnect', () => {
      _socketConnected = false;
      if (!refreshTimer) {
        refreshTimer = setInterval(() => { if (!_socketConnected) loadOrders(); }, refreshInterval * 1000);
      }
    });
  }

  // 全局暴露
  window.switchTab = switchTab;
  window.selectOrder = selectOrder;
  window.closeDetail = closeDetail;
  window.openPaymentModal = openPaymentModal;
  window.closePaymentModal = closePaymentModal;
  window.selectPayMethod = selectPayMethod;
  window.setCash = setCash;
  window.onCashInput = onCashInput;
  window.confirmPay = confirmPay;
  window.printOrder = printOrder;
  window.cancelOrder = cancelOrder;
  window.hideConfirm = hideConfirm;
  window.executeConfirm = executeConfirm;
  window.logout = logout;
  window.goLogin = goLogin;
  window.changeLang = changeLang;

  init();
})();
