/*
 * FoodFlow · cashier (cashier.html) 页面逻辑
 */
(function(){
'use strict';
    // 全局状态
    let currentLang = SLF.store.rawGet('cashierLang') || SLF.store.rawGet('lang') || 'zh';
    let cashierInfo = null;
    let orders = [];
    let currentTab = 'pending';
    let currencies = [];
    let defaultCurrency = { symbol: '$', rate: 1, code: 'USD' };
    let dualCurrency = { enabled: false, currency: null };
    let refreshInterval = 15;
    let refreshTimer = null;

    SLF.i18n.init(currentLang);

    // 修复：删除重复的 return
    // 修复：统一的菜品价格（base）计算
    function itemBasePrice(item) {
      return SLF.money.toBase(item.price, item.currency_code);
    }
    function itemLineTotal(item) {
      const qty = Number(item.quantity || 0) - Number(item.returnedQty || 0);
      return itemBasePrice(item) * qty;
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
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

    // 空闲超时（统一 SLF.idle）
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

    async function changeLang(lang) {
      try {
        currentLang = lang;
        SLF.store.rawSet('cashierLang', lang);
        SLF.store.rawSet('lang', lang);
        await SLF.i18n.init(lang);
        applyLang();
        renderOrders();
        loadOrders();
        if (currentTab === 'report') loadReport();
      } catch (e) {
        console.error('[changeLang] 切换失败:', e);
        try { SLF.i18n.lang = lang; applyLang(); } catch (_) {}
      }
    }

    function applyLang() {
      document.getElementById('langSelect').value = currentLang;
      document.getElementById('pageTitle').textContent = t('cashier') + ' · ' + t('orderList');
      document.getElementById('tabPending').textContent = t('pendingOrders');
      document.getElementById('selectedLabel').textContent = t('itemsSelected');
      document.getElementById('selectAllLabel').textContent = t('selectAll');
      document.getElementById('searchInput').placeholder = '🔍 ' + t('searchPlaceholder');
      document.getElementById('printBtn').textContent = '🖨 ' + t('print');
      document.getElementById('batchSettleBtn').textContent = t('batchSettleTitle');
      document.getElementById('tabSettled').textContent = t('settledOrders');
      document.getElementById('tabReport').textContent = t('report');
      document.getElementById('pendingLabel').textContent = t('pendingCount');
      document.getElementById('todayLabel').textContent = t('todayCount');
      document.getElementById('revenueLabel').textContent = t('todayRevenue');
      document.getElementById('loginTitle').textContent = t('reloginTitle');
      document.getElementById('loginDesc').textContent = t('reloginDesc');
      document.getElementById('loginBtn').textContent = t('relogin');
      document.getElementById('logoutBtn').textContent = t('logout');
      document.getElementById('detailTitle').textContent = t('orderDetail');
      document.getElementById('dishListTitle').textContent = t('dishList');
      document.getElementById('totalLabel').textContent = t('total');
      document.getElementById('confirmTitle').textContent = t('confirmTitle');
      document.getElementById('confirmCancelBtn').textContent = t('cancel');
      document.getElementById('confirmOkBtn').textContent = t('confirm');

      // 刷新 storeName（切语言时同步）
      var _sn = document.getElementById('storeName');
      if (_sn) {
        if (cashierInfo && cashierInfo.storeName) {
          _sn.textContent = cashierInfo.storeName;
        } else {
          var _sid = SLF.store.rawGet('cashierStoreId') || '1';
          _sn.textContent = t('store') + ' #' + _sid;
        }
      }
    }

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.querySelector('.tab[data-tab="' + tab + '"]').classList.add('active');
      const showOrders = (tab === 'pending' || tab === 'settled');
      document.getElementById('ordersView').style.display = showOrders ? 'block' : 'none';
      document.getElementById('reportView').style.display = tab === 'report' ? 'block' : 'none';
      if (showOrders) renderOrders();
      if (tab === 'report') loadReport();
    }

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

    // 根据 customer_token 分组生成客户标签
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
          if (o.sessionToken) {
            labels.set(o.id, t('customer') + tokenToIndex.get(o.customerToken));
          } else {
            labels.set(o.id, t('staffOrder'));
          }
        });
      });
      return labels;
    }

    function renderOrders() {
      const container = document.getElementById('orderList');
      if (!orders.length) {
        container.innerHTML = '<div class="empty-hint"><div class="empty-icon">📋</div>' + t('noOrders') + '</div>';
        return;
      }
      const searchVal = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
      let filtered = (currentTab === 'settled')
        ? orders.filter(o => o.status !== 'pending')
        : orders.filter(o => o.status === 'pending');
      if (searchVal) {
        filtered = filtered.filter(o =>
          (o.table_name || '').toLowerCase().includes(searchVal) ||
          String(o.order_no || o.id).includes(searchVal)
        );
      }
      if (!filtered.length) {
        container.innerHTML = '<div class="empty-hint"><div class="empty-icon">📋</div>' + t('noOrders') + '</div>';
        return;
      }
      const customerLabels = buildSessionLabels(filtered);
      container.innerHTML = filtered.map(order => {
        const statusClass = order.status === 'done' ? 'done' : order.status === 'canceled' ? 'canceled' : order.status === 'refunded' ? 'refunded' : 'pending';
        const statusText = order.status === 'done' ? t('settled') : order.status === 'canceled' ? t('canceled') : order.status === 'refunded' ? t('refunded') : t('pendingSettlement');
        const dishesHTML = (order.items || []).map(i => {
          const unitBase = itemBasePrice(i);
          const lineBase = itemLineTotal(i);
          return '<div class="order-dish-row">' +
            '<div class="order-dish-left">' +
              '<span class="order-dish-name">' + esc(i.name) + '</span>' +
              '<span class="order-dish-qty">×' + i.quantity + '</span>' +
              '<span class="order-dish-unit">@' + SLF.money.primary(unitBase) + '</span>' +
              (i.returnedQty > 0 ? '<span style="color:#e74c3c;font-size:11px;">(' + t('returned') + ' ' + i.returnedQty + ')</span>' : '') +
            '</div>' +
            '<span class="order-dish-price">' + SLF.money.format(lineBase) + '</span>' +
          '</div>';
        }).join('');
        const allItemsDone = SLF.orderStatus.allItemsDone(order);
        const canSettle = cashierInfo?.permissions?.can_settle && order.status === 'pending' && allItemsDone;
        const canCancel = cashierInfo?.permissions?.can_cancel && order.status === 'pending';
        const canRefund = cashierInfo?.permissions?.can_refund && order.status === 'done';
        const customerLabel = customerLabels.get(order.id) || '';
        const checked = selectedIds.has(order.id) ? 'checked' : '';
        const checkbox = (currentTab === 'pending')
          ? '<input type="checkbox" style="width:20px;height:20px;cursor:pointer;accent-color:#667eea;" ' + checked + ' onclick="event.stopPropagation();toggleSelect(' + order.id + ')">'
          : '';
        return '<div class="order-card status-' + statusClass + '" onclick="showOrderDetail(' + order.id + ')">' +
          '<div class="order-header" style="display:flex;align-items:center;gap:8px;">' + checkbox +
            '<span class="order-table">' +
              '<span class="order-table-icon">🪑</span>' +
              '<span class="order-table-name">' + esc(order.table_name || '-') + '</span>' +
              '<span class="order-id-badge">' + esc(order.order_no || ('#' + order.id)) + '</span>' +
              (customerLabel ? '<span class="customer-tag' + (customerLabel === t('staffOrder') ? ' staff' : '') + '">👤 ' + esc(customerLabel) + '</span>' : '') +
            '</span>' +
            '<span class="order-status ' + statusClass + '">' + esc(statusText) + '</span>' +
          '</div>' +
          '<div class="order-info">🕐 ' + formatTime(order.createdAt) + ' · ' + (order.items?.length || 0) + t('dishes') + '</div>' +
          '<div class="order-dishes">' + (dishesHTML || '<div style="color:var(--gray-4);">' + t('noDishes') + '</div>') + '</div>' +
          '<div class="order-footer">' +
            '<span class="order-total">' + SLF.money.format(Number(order.total) || 0) + '</span>' +
            '<div class="order-actions" onclick="event.stopPropagation()">' +
              ((cashierInfo?.permissions?.can_settle && order.status === 'pending') ? (canSettle ? '<button class="btn btn-primary" onclick="event.stopPropagation();showOrderDetail(' + order.id + ', ' + "'settle'" + ')">' + t('settleOrder') + '</button>' : '<button class="btn btn-primary" disabled style="opacity:0.5;cursor:not-allowed;" title="' + t('itemsNotReady') + '">' + t('settleOrder') + '</button>') : '') +
              (canCancel ? '<button class="btn btn-warning" onclick="event.stopPropagation();showOrderDetail(' + order.id + ', ' + "'cancel'" + ')">' + t('cancelOrder') + '</button>' : '') +
              (canRefund ? '<button class="btn btn-danger" onclick="refundOrder(' + order.id + ')">' + t('refundOrder') + '</button>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function updateBottomStats() {
      const pending = orders.filter(o => o.status === 'pending').length;
      const today = new Date().toISOString().split('T')[0];
      const todayOrders = orders.filter(o => (o.createdAt || '').startsWith(today));
      const revenueBase = todayOrders.filter(o => o.status === 'done').reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
      document.getElementById('pendingCount').textContent = pending;
      document.getElementById('todayCount').textContent = todayOrders.length;
      // 修复：revenue 用 formatMoney 而不是硬编码 $
      document.getElementById('todayRevenue').textContent = SLF.money.format(revenueBase);
    }

    function showOrderDetail(id, action) {
      const order = orders.find(o => o.id === id);
      if (!order) return;
      const detailCustomerLabel = buildSessionLabels([order]).get(order.id) || '';
      document.getElementById('detailTitle').textContent = t('orderDetail') + ' ' + (order.order_no || ('#' + order.id)) + (detailCustomerLabel ? ' · ' + detailCustomerLabel : '');
      document.getElementById('detailDishes').innerHTML = (order.items || []).map(item => {
        const unitBase = itemBasePrice(item);
        const lineBase = itemLineTotal(item);
        return '<div class="dish-item">' +
          '<div class="dish-left">' +
            '<span class="dish-name">' + esc(item.name) + '</span>' +
            '<span class="dish-qty">×' + item.quantity + '</span>' +
            '<span class="dish-unit">@' + SLF.money.primary(unitBase) + '</span>' +
            (item.returnedQty > 0 ? '<span style="color:#e74c3c;font-size:11px;">(' + t('returned') + ' ' + item.returnedQty + ')</span>' : '') +
          '</div>' +
          '<span class="dish-price">' + SLF.money.format(lineBase) + '</span>' +
        '</div>';
      }).join('') || '<div style="text-align:center;color:var(--gray-4);padding:20px;">' + t('noDishes') + '</div>';
      document.getElementById('detailTotal').textContent = SLF.money.format(Number(order.total) || 0);
      const canSettle = cashierInfo?.permissions?.can_settle && order.status === 'pending' && SLF.orderStatus.allItemsDone(order);
      const canCancel = cashierInfo?.permissions?.can_cancel && order.status === 'pending';
      const canRefund = cashierInfo?.permissions?.can_refund && order.status === 'done';
      const showSettle = canSettle && (!action || action === 'settle');
      const showCancel = canCancel && (!action || action === 'cancel');
      document.getElementById('detailActions').innerHTML =
        '<button class="btn btn-secondary" onclick="closeOrderDetail()">' + t('close') + '</button>' +
        (showSettle ? '<button class="btn btn-primary" onclick="settleOrder(' + order.id + ')">' + t('settleNow') + '</button>' : '') +
        (showCancel ? '<button class="btn btn-warning" onclick="cancelOrder(' + order.id + ')">' + t('cancelNow') + '</button>' : '') +
        (canRefund ? '<button class="btn btn-danger" onclick="refundOrder(' + order.id + ')">' + t('refundOrder') + '</button>' : '');
      document.getElementById('orderDetailModal').classList.add('show');
    }

    async function settleOrder(id) {
      showConfirm(t('settleOrder'), t('confirmSettle'), async function() {
        try {
          await api('/cashier/orders/' + id + '/settle', { method: 'PUT' });
          SLF.ui.toast('✅ ' + t('settleSuccess'));
          closeOrderDetail();
          loadOrders();
        } catch (e) {
          SLF.ui.toast('❌ ' + e.message);
        }
      }, { type: 'primary', icon: '💰', okText: t('confirmSettle'), cancelText: t('back') });
    }

    async function cancelOrder(id) {
      showConfirm(t('cancelOrder'), t('confirmCancel'), async function() {
        try {
          await api('/cashier/orders/' + id + '/cancel', { method: 'PUT' });
          SLF.ui.toast('✅ ' + t('cancelSuccess'));
          closeOrderDetail();
          loadOrders();
        } catch (e) {
          SLF.ui.toast('❌ ' + e.message);
        }
      }, { type: 'warning', icon: '⚠️', okText: t('confirmCancel'), cancelText: t('back') });
    }

    function closeOrderDetail() {
      document.getElementById('orderDetailModal').classList.remove('show');
    }

    // 自定义确认弹窗
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
        document.getElementById('confirmOkBtn').className = 'btn btn-warning';
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

    let selectedIds = new Set();
    function toggleSelect(id) {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      updateBatchBar();
    }
    function updateBatchBar() {
      const bar = document.getElementById('batchBar');
      const count = selectedIds.size;
      document.getElementById('batchCount').textContent = count;
      if (count > 0) {
        const total = orders.filter(o => selectedIds.has(o.id)).reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
        document.getElementById('batchTotal').textContent = SLF.money.format(total);
        bar.style.display = 'flex';
      } else {
        bar.style.display = 'none';
      }
    }
    function filterByTable() { renderOrders(); }
    function toggleSelectAll() {
      const cb = document.getElementById('selectAll');
      const pending = orders.filter(o => o.status === 'pending');
      if (cb.checked) {
        pending.forEach(o => selectedIds.add(o.id));
      } else {
        selectedIds.clear();
      }
      renderOrders();
      updateBatchBar();
    }
    async function batchSettle() {
      if (!selectedIds.size) return;
      const ids = [...selectedIds];
      const selectedOrders = orders.filter(o => selectedIds.has(o.id));
      const notReady = selectedOrders.filter(o => !SLF.orderStatus.allItemsDone(o));
      if (notReady.length) { SLF.ui.toast('⚠️ ' + t('batchNotReady') + ' ' + notReady.map(o => o.order_no || ('#' + o.id)).join(', ')); return; }
      const total = selectedOrders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
      const tables = [...new Set(selectedOrders.map(o => o.table_name))].join(', ');
      let html = '<div style="text-align:left;max-height:300px;overflow-y:auto;">';
      html += '<div style="margin-bottom:8px;color:#666;">' + t('table') + ': <b>' + esc(tables) + '</b> · ' + selectedOrders.length + ' ' + t('orders') + '</div>';
      selectedOrders.forEach(o => {
        html += '<div style="background:#f8f9fa;border-radius:8px;padding:8px;margin-bottom:6px;">';
        html += '<div style="font-weight:700;margin-bottom:4px;">' + esc(o.order_no || ('#' + o.id)) + ' · ' + esc(o.table_name || '-') + '</div>';
        (o.items || []).forEach(i => {
          html += '<div style="display:flex;justify-content:space-between;font-size:13px;color:#555;"><span>' + esc(i.name) + ' x' + i.quantity + ' <span style="color:#999;font-size:11px;">@' + SLF.money.primary(itemBasePrice(i)) + '</span></span><span>' + SLF.money.format(itemLineTotal(i)) + '</span></div>';
        });
        html += '<div style="text-align:right;font-weight:700;color:#333;margin-top:4px;">' + SLF.money.format(Number(o.total) || 0) + '</div>';
        html += '</div>';
      });
      html += '<div style="text-align:right;font-weight:700;font-size:16px;color:#667eea;margin-top:8px;">' + t('total') + ': ' + SLF.money.format(total) + '</div>';
      html += '</div>';
      showConfirm(t('batchSettleTitle'), html, async function() {
        try {
          await api('/cashier/orders/batch-settle', { method: 'PUT', body: { order_ids: ids } });
          SLF.ui.toast('✅ ' + t('settleSuccess'));
          selectedIds.clear();
          await loadOrders();
          if (currentTab === 'pending') renderOrders();
          updateBatchBar();
        } catch (e) { SLF.ui.toast('❌ ' + e.message); }
      }, { type: 'primary', icon: '💰', okText: t('settleNow'), cancelText: t('back') });
    }

    async function batchPrint() {
      if (!selectedIds.size) return;
      try {
        await api('/cashier/orders/batch-print', { method: 'POST', body: { order_ids: [...selectedIds] } });
        SLF.ui.toast('✅ ' + t('print') + ' OK');
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    }

    async function refundOrder(id) {
      showConfirm(t('refundOrder'), t('confirmRefund'), async function() {
        try {
          await api('/cashier/orders/' + id + '/refund', { method: 'PUT' });
          SLF.ui.toast('✅ ' + t('refundSuccess'));
          closeOrderDetail();
          loadOrders();
        } catch (e) {
          SLF.ui.toast('❌ ' + e.message);
        }
      }, { type: 'danger', icon: '💸' });
    }

    async function loadReport() {
      try {
        const data = await api('/cashier/report/today');
        // 修复：使用 formatMoney 而不是硬编码 $
        const totalRevenueDisplay = SLF.money.format(Number(data.totalRevenue) || 0);
        const avgDisplay = SLF.money.format(Number(data.avgOrderValue) || 0);
        document.getElementById('reportContent').innerHTML =
          '<div class="report-card">' +
            '<div class="report-title">' + t('todayRevenue') + '</div>' +
            '<div class="report-amount">' + totalRevenueDisplay + '</div>' +
            '<div class="report-stats">' +
              '<div class="report-stat"><div class="report-stat-value">' + data.orderCount + '</div><div class="report-stat-label">' + t('orderCount') + '</div></div>' +
              '<div class="report-stat"><div class="report-stat-value">' + avgDisplay + '</div><div class="report-stat-label">' + t('avgOrderValue') + '</div></div>' +
            '</div>' +
          '</div>' +
          (data.orders && data.orders.length ? '<div class="modal-section-title" style="margin-bottom:8px;">' + t('settledOrdersTitle') + '</div>' + data.orders.map(o =>
            '<div class="dish-item"><span class="dish-name">📋 ' + esc(o.table_name || '-') + ' · ' + formatTime(o.createdAt) + '</span><span class="dish-price">' + SLF.money.format(Number(o.total) || 0) + '</span></div>'
          ).join('') : '<div class="empty-hint">' + t('noSettledToday') + '</div>');
      } catch (e) {
        if (e.message.includes('没有')) {
          document.getElementById('reportContent').innerHTML = '<div class="empty-hint"><div class="empty-icon">🔒</div>' + t('noPermission') + '</div>';
        } else {
          SLF.ui.toast('❌ ' + e.message);
        }
      }
    }

    function formatTime(iso) {
      if (!iso) return '-';
      try {
        const d = new Date(iso);
        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
      } catch (e) { return iso; }
    }

    async function init() {
      applyLang();
      const token = SLF.store.rawGet('cashierToken');
      if (!token) {
        document.documentElement.removeAttribute('data-cashier-session');
        return;
      }
      try {
        const info = JSON.parse(SLF.store.rawGet('cashierInfo') || '{}');
        cashierInfo = info;
        const storeId = SLF.store.rawGet('cashierStoreId') || '1';
        SLF.store.rawSet('storeId', storeId);
        document.getElementById('storeName').textContent = cashierInfo.storeName || t('store') + ' #' + storeId;
        try {
          const cfg = await SLF.api.get('/public/config?store_id=' + (SLF.store.rawGet('storeId') || 1));
          currencies = cfg.currencies || [];
          defaultCurrency = cfg.defaultCurrency || { symbol: '$', rate: 1, code: 'USD' };
          dualCurrency = cfg.dualCurrency || { enabled: false, currency: null };
          SLF.money.configure({ currencies: currencies, defaultCurrency: defaultCurrency, dualCurrency: dualCurrency });
          // 修复：使用配置的刷新间隔
          const ri = parseInt(cfg.waiter_refresh_interval, 10);
          if (!isNaN(ri) && ri >= 3) refreshInterval = ri;
        } catch (e) { console.error('currency load failed', e); }
        await loadOrders();
        // 修复：使用配置的刷新间隔
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(loadOrders, refreshInterval * 1000);
      } catch (e) {
        console.error(e);
      }
    }

    document.getElementById('orderDetailModal').addEventListener('click', function(e) {
      if (e.target === this) closeOrderDetail();
    });

    document.getElementById('confirmModal').addEventListener('click', function(e) {
      if (e.target === this) hideConfirm();
    });

    // Socket（传 cashierToken）
    if (typeof io === 'function') {
      const cashierSocket = io({
        query: {
          storeId: SLF.store.rawGet('storeId') || 1,
          token: SLF.store.rawGet('cashierToken') || ''
        }
      });
      let socketDebounce = null;
      function debouncedLoadOrders() {
        clearTimeout(socketDebounce);
        socketDebounce = setTimeout(() => { if (typeof loadOrders === 'function') loadOrders(); }, 300);
      }
      cashierSocket.on('order:new', debouncedLoadOrders);
      cashierSocket.on('item:updated', debouncedLoadOrders);
      cashierSocket.on('order:settled', debouncedLoadOrders);
      cashierSocket.on('order:transfer', debouncedLoadOrders);
      cashierSocket.on('connect_error', (err) => { console.warn('cashierSocket connect_error:', err.message); });
      window.addEventListener('beforeunload', () => {
        try { cashierSocket.disconnect(); } catch (_) {}
      });
    }

    init();
    try { window.batchPrint = batchPrint; } catch(err) {}
    try { window.batchSettle = batchSettle; } catch(err) {}
    try { window.cancelOrder = cancelOrder; } catch(err) {}
    try { window.closeOrderDetail = closeOrderDetail; } catch(err) {}
    try { window.executeConfirm = executeConfirm; } catch(err) {}
    try { window.goLogin = goLogin; } catch(err) {}
    try { window.hideConfirm = hideConfirm; } catch(err) {}
    try { window.logout = logout; } catch(err) {}
    try { window.refundOrder = refundOrder; } catch(err) {}
    try { window.settleOrder = settleOrder; } catch(err) {}
    try { window.showOrderDetail = showOrderDetail; } catch(err) {}
    try { window.switchTab = switchTab; } catch(err) {}
    try { window.toggleSelect = toggleSelect; } catch(err) {}
    try { window.changeLang = changeLang; } catch(err) {}
    try { window.filterByTable = filterByTable; } catch(err) {}
    try { window.toggleSelectAll = toggleSelectAll; } catch(err) {}
})();
