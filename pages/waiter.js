/*
 * FoodFlow · waiter (waiter.html) 页面逻辑
 * 由原两段内联脚本抽出；onclick 引用的函数挂 window 供 HTML 内联事件使用。
 */
(function(){
'use strict';
  // ============================================================
  // 触摸滚动控制（修复版）
  // ============================================================
  // 说明：body 已 fixed + overflow:hidden，且各滚动容器已加
  //      overscroll-behavior:contain，理论上不需要 touchmove 拦截。
  //      这里保留一份"白名单"式拦截，允许所有滚动容器内滑动。
  document.addEventListener('touchmove', function(e) {
    const allowed = e.target.closest(
      '#mainContent, .modal-card, .modal-body, .dish-list, .selected-items, .dish-categories, .bill-items, #orderSelectList, .scroll-hide'
    );
    if (!allowed) e.preventDefault();
  }, { passive: false });

  // 禁止多指缩放（保留原有逻辑）
  document.body.addEventListener('touchstart', function(e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  // 三连击切换全屏
  let _tripleClickTimer = null, _clickCount = 0;
  window.toggleFullscreen = function() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      if (window.navigator.standalone) {
        SLF.ui.toast(t('fullscreenIosHint', null, '已在全屏模式'));
      } else {
        document.documentElement.requestFullscreen().catch(e => SLF.ui.toast(t('addToHomeScreenHint', null, '请用"添加到主屏幕"打开')));
      }
    }
  };
  function _handleTap() {
    _clickCount++;
    if (_clickCount === 3) {
      _clickCount = 0;
      clearTimeout(_tripleClickTimer);
      if (!document.fullscreenElement) {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
        if (req) req.call(el).catch(()=>{});
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      }
    }
    clearTimeout(_tripleClickTimer);
    _tripleClickTimer = setTimeout(() => { _clickCount = 0; }, 600);
  }
  document.addEventListener('touchend', _handleTap, { passive: true });
  document.addEventListener('click', _handleTap);
;
  // 安全兜底
  if (typeof SLF === 'undefined' || !SLF.audio) {
    window.SLF = window.SLF || {};
    SLF.audio = {
      _enabled: true,
      setEnabled(v) { this._enabled = !!v; },
      isEnabled() { return this._enabled; },
      unlock() {},
      playNewOrderChime() {},
      playCallChime() {},
    };
  }

  const $ = s => document.querySelector(s);

  const state = {
    tables: [],
    orders: [],
    menu: [],
    cart: {},
    cartMeta: {},
    currentTable: null,
    currencies: [],
    defaultCurrency: { symbol: '$', rate: 1, code: 'USD' },
    dualCurrency: { enabled: false, currency: null },
    waiter: null,
    token: SLF.store.rawGet('waiterToken') || '',
    editingOrderId: null,
    lockedItems: [],
    storeId: null,
    storeName: '',
    currentCategory: 'all',
    selectedItem: null
  };

  let waiterLang = SLF.store.rawGet('waiterLang') || 'zh';
  SLF.i18n.init(waiterLang);

  // t(key, params, fallback)
  const escNote = esc;


  function applyWaiterLanguage() {
    const titleEl = $('#waiterTitle'); if (titleEl) titleEl.textContent = t('title', null, '🍴 FoodFlow');
    const logoutEl = $('#logoutBtn'); if (logoutEl) logoutEl.title = t('logout', null, '退出');
    const langEl = $('#waiterLang'); if (langEl) langEl.value = waiterLang;
    if (!state.currentTable) { const badge = $('#currentTableBadge'); if (badge) badge.textContent = t('currentTable', null, '当前桌号') + ': '; }
    const submitBtn = $('#submitBtn'); if (submitBtn) submitBtn.textContent = t('submitOrder', null, '提交订单');
    const confirmCancelBtn = $('#confirmCancelBtn'); if (confirmCancelBtn) confirmCancelBtn.textContent = t('cancel', null, '取消');
    const confirmOkBtn = $('#confirmOkBtn'); if (confirmOkBtn) confirmOkBtn.textContent = t('confirm', null, '确定');
    const historyBtn = $('#orderHistoryBtn'); if (historyBtn) historyBtn.title = t('orderHistory', null, '订单历史');

  // ===== 2026-09-29 补充硬编码 i18n =====
  // document.title
  document.title = t('loginTitle', null, '服务员点餐');

  // 呼叫通知按钮 title
  const _cnb = $('#callNotificationBtn');
  if (_cnb) _cnb.title = t('callWaiter', null, '呼叫通知');

  // 全屏按钮 title
  const _fsb = $('#fullscreenBtn');
  if (_fsb) _fsb.title = t('fullscreen', null, '全屏');

    renderTables();
    const _newBtn = document.getElementById('createNewOrderBtn');
    if (_newBtn) _newBtn.textContent = '➕ ' + t('createNewOrder', null, '创建新订单');
  }

  let confirmCallback = null;
  function showConfirm(message, callback, title) {
    if ($('#confirmModal').classList.contains('open')) return;
    $('#confirmTitle').textContent = title || t('confirmTitle', null, '确认操作');
    $('#confirmMessage').textContent = message;
    confirmCallback = callback;
    $('#confirmModal').classList.add('open');
  }
  function hideConfirm() {
    $('#confirmModal').classList.remove('open');
    $('#confirmInput').style.display = 'none';
    confirmCallback = null;
  }
  $('#confirmCancelBtn').onclick = hideConfirm;
  $('#confirmOkBtn').onclick = function () { if (confirmCallback) confirmCallback(); hideConfirm(); };
  $('#confirmModal').onclick = function (e) { if (e.target === this) hideConfirm(); };

  async function api(path, opt = {}) {
    try {
      const method = (opt.method || 'GET').toUpperCase();
      let result;
      if (method === 'GET') result = await SLF.api.get(path, opt);
      else if (method === 'POST') result = await SLF.api.post(path, opt.body, opt);
      else if (method === 'PUT') result = await SLF.api.put(path, opt.body, opt);
      else if (method === 'DELETE') result = await SLF.api.del(path, opt);
      else result = await SLF.api._request(method, path, opt);
      return result;
    } catch (e) {
      throw e;
    }
  }

  let knownWaiterOrderIds = null;
  function logoutWaiter() {
    stopCallPolling();
    state.token = '';
    SLF.store.rawRemove('waiterToken');
    SLF.store.rawRemove('storeId');
    document.documentElement.removeAttribute('data-waiter-session');
    knownWaiterOrderIds = null;
    stopWaiterAutoRefresh();
    SLF.idle.stop();
    window.location.href = '/login?type=waiter';
  }

  let waiterIdleTimeoutMin = 20;

  $('#logoutBtn').onclick = function () { showConfirm(t('confirmLogout', null, '确认退出登录？'), logoutWaiter); };


  function buildSessionLabels(orders) {
    const sorted = [...orders].sort((a, b) => {
      const ta = a.createdAt ? (new Date(a.createdAt).getTime() || 0) : 0;
      const tb = b.createdAt ? (new Date(b.createdAt).getTime() || 0) : 0;
      return ta - tb;
    });
    const labels = new Map();
    const ctToIndex = SLF.customerGroup.buildIndex(sorted);
    for (const o of sorted) {
      labels.set(o.id, o.customerToken ? `${t('customer', null, '客')}${ctToIndex.get(o.customerToken)}` : (o.sessionToken ? `${t('customer', null, '客')}1` : t('staffOrder', null, '服务员下单')));
    }
    return labels;
  }

  function bill(table) {
    const active = state.orders.filter(o => o.table === table.name && o.status === 'pending');
    const totalBase = active.reduce((s, o) => s + Number(o.total || 0), 0);
    const totalDisplay = SLF.money.format(totalBase);
    const sessionLabels = buildSessionLabels(active);
    const blocks = active.slice(0, 5).map(o => {
      const orderTotalBase = (o.items || []).reduce((s, item) => s + SLF.money.toBase(item.price, item.currency_code) * (item.quantity - (item.returnedQty || 0)), 0);
      const orderTotalDisplay = SLF.money.format(orderTotalBase);
      const lines = (o.items || []).map((i, idx) => {
        const qty = Number(i.quantity || 1) - Number(i.returnedQty || 0);
        const unitPrices = SLF.money.menuPrice(i);
        const basePrice = SLF.money.toBase(i.price, i.currency_code);
        const subBase = basePrice * qty;
        let priceDisplay = `<span style="color:#e67e22;font-size:12px;">@${unitPrices.primary}${unitPrices.secondary ? ' <span style="color:#999;font-size:10px;">(' + unitPrices.secondary + ')</span>' : ''}</span> <b>${SLF.money.format(subBase, { secondaryCode: i.secondary_currency_code })}</b>`;
        const returnedHtml = i.returnedQty > 0 ? `<span class="item-status returned" style="background:#95a5a6;">${t('returned', null, '已退')} ${i.returnedQty}</span>` : '';
        const isSelected = state.selectedItem && state.selectedItem.orderId === o.id && state.selectedItem.index === idx;
        const returnBtn = i.itemStatus === 'done' && Number(i.quantity) > 1 && Number(i.quantity) > Number(i.returnedQty || 0) && isSelected ? `<button class="item-toggle return-btn" onclick="event.stopPropagation();returnWaiterItem(${o.id},${idx})" style="background:#e74c3c;color:#fff;">${t('returnDish', null, '退菜')}</button>` : '';
        return `<div class="line" onclick="event.stopPropagation();toggleSelectedItem(${o.id},${idx})" style="cursor:pointer;${isSelected ? 'background:rgba(52,152,219,0.12);border-radius:8px;padding:4px;' : ''}"><span class="dish-name">${esc(i.name)} ×${i.quantity}</span><span class="line-amount">${priceDisplay}</span>${i.itemStatus === 'done' ? `<span class="item-status done">${t('completed', null, '已完成')}</span>` + returnBtn + returnedHtml : (state.waiter && state.waiter.can_mark_item ? `<button class="item-toggle" onclick="event.stopPropagation();toggleWaiterItem(${o.id},${idx})">${t('pending', null, '制作中')}</button>` : '')}</div>`;
      }).join('');
      const timeLabel = o.createdAt ? SLF.utils.formatDateTime(o.createdAt) : '';
      const badgeLabel = sessionLabels.get(o.id);
      const badgeColor = badgeLabel ? SLF.customerGroup.color(badgeLabel) : null;
      const badge = badgeLabel ? `<span class="session-badge" style="background:${badgeColor.bg};color:${badgeColor.color};">${badgeLabel}</span>` : '';
      const noteHtml = o.note ? `<div class="order-note" style="margin:4px 0 6px;padding:6px 8px;border-radius:6px;background:rgba(255,193,7,.15);font-size:12px;color:#c98a1f;line-height:1.4;"><strong>${t('orderNoteDisplay', null, '备注')}：</strong>${escNote(o.note)}</div>` : '';
      const orderSettleBtn = (state.waiter && state.waiter.can_complete_order) ? `<button onclick="event.stopPropagation();completeWaiterOrder(${o.id})" style="background:var(--primary);color:#fff;border:none;padding:5px 14px;border-radius:16px;font-size:12px;cursor:pointer;font-weight:600;flex-shrink:0;">${t('settleOrder', null, '结算')}</button>` : '';
      return `<div class="order-block"><div class="order-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span>${o.order_no || ("#"+o.id)} · <span style="padding:2px 6px;border-radius:4px;background:#e3f2fd;color:#1976d2;font-size:12px;">🏷️ ${esc(o.table || '-')}</span> · ${t('orderPending', null, '未结算')}${badge}<span class="order-meta"> · ${timeLabel}</span></span>${orderSettleBtn}</div>${noteHtml}<div class="bill-items">${lines}</div></div>`;
    }).join('');
    return active.length ? `<div class="amount" style="display:flex;align-items:center;justify-content:space-between;">${active.length} ${t('order', null, '订单')} · ${totalDisplay}</div>${blocks}` : `<div class="amount" style="color:#c8c8d0">${t('noCustomerOrder', null, '暂无顾客下单')}</div>`;
  }

  async function toggleWaiterItem(id, index) {
    try {
      const order = state.orders.find(o => o.id === id);
      if (!order || !order.items[index]) return;
      const next = order.items[index].itemStatus === 'done' ? 'pending' : 'done';
      await api(`/orders/${id}/items/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemStatus: next }) });
      SLF.ui.toast('✅ ' + t('orderUpdated', null, '订单已更新'));
      await load();
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  }

  function toggleSelectedItem(orderId, index) {
    if (state.selectedItem && state.selectedItem.orderId === orderId && state.selectedItem.index === index) {
      state.selectedItem = null;
    } else {
      state.selectedItem = { orderId, index };
    }
    renderTables();
  }
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.line') && !e.target.closest('.return-btn') && state.selectedItem) {
      state.selectedItem = null;
      renderTables();
    }
  });

  async function returnWaiterItem(id, index) {
    try {
      const order = state.orders.find(o => o.id === id);
      if (!order || !order.items[index]) return;
      const item = order.items[index];
      const qty = Number(item.quantity) || 1;
      const returned = Number(item.returnedQty || 0);
      const maxReturn = qty - returned;
      if (maxReturn <= 0) { SLF.ui.toast('❌ ' + t('noMoreToReturn', null, '已全部退回')); return; }
      const input = $('#confirmInput');
      showConfirm(t('returnQuantityPrompt', null, '请输入退回数量') + ' (1-' + maxReturn + ')', async function () {
        const returnQty = parseInt(input.value) || 0;
        if (returnQty < 1 || returnQty > maxReturn) { SLF.ui.toast('❌ ' + t('invalidReturnQty', null, '退回数量无效')); return; }
        await api(`/orders/${id}/items/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnQty: returned + returnQty }) });
        SLF.ui.toast('✅ ' + t('returnSuccess', null, '退菜成功'));
        await load();
      }, t('returnDish', null, '退菜'));
      input.style.display = 'block';
      input.max = maxReturn;
      input.value = 1;
      input.focus();
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  }

  async function completeWaiterOrder(id) {
    showConfirm(t('confirmComplete', null, '确认结算该订单？'), async function () {
      try {
        await api(`/orders/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
        SLF.ui.toast('✅ ' + t('settleOrder', null, '已结算'));
        await load();
      } catch (e) {
        const msg = e.message.includes('未完成菜品') ? (t('incompleteItemsError', null, e.message)) : e.message;
        SLF.ui.toast('❌ ' + msg);
      }
    });
  }

  async function load() {
    if (!state.token) { logoutWaiter(); return; }
    try {
      const overview = await api('/waiter/overview');
      const [menuRes, configRes] = await Promise.all([
        SLF.api.get('/menu?store_id=' + (overview.waiter?.store_id || 1)),
        SLF.api.get('/public/config')
      ]);
      detectNewWaiterOrders(overview.orders || []);
      state.tables = overview.tables;
      state.orders = overview.orders;
      state.waiter = overview.waiter;
      state.menu = menuRes;
      state.currencies = configRes.currencies || [];
      state.defaultCurrency = configRes.defaultCurrency || state.defaultCurrency;
      state.dualCurrency = configRes.dualCurrency || { enabled: false, currency: null };
      SLF.money.configure({ currencies: state.currencies, defaultCurrency: state.defaultCurrency, dualCurrency: state.dualCurrency });
      if (typeof configRes.newOrderSoundEnabled === 'boolean' && SLF.audio) SLF.audio.setEnabled(configRes.newOrderSoundEnabled);
      startWaiterAutoRefresh(configRes.waiter_refresh_interval || 8);
      waiterIdleTimeoutMin = configRes.waiter_idle_timeout || 20;
      SLF.idle.start({ timeoutMin: waiterIdleTimeoutMin, onTimeout: logoutWaiter, rememberKey: 'waiterRemember' });
      if (state.dualCurrency.enabled && !state.dualCurrency.currency) {
        const defaultSec = state.currencies.find(c => c.code === 'USD') || state.currencies[0];
        if (defaultSec) state.dualCurrency.currency = defaultSec;
      }
      $('#mainHeader').style.display = 'flex';
      $('#mainContent').style.display = 'block';
      if (state.waiter && state.waiter.display_name) $('#waiterNameDisplay').textContent = '👤 ' + state.waiter.display_name;
      if (state.waiter && state.waiter.store_id) loadStoreInfo(state.waiter.store_id);
      renderTables();
    } catch (e) {
      SLF.ui.toast('❌ ' + e.message);
      if (e.message.includes('请先登录')) logoutWaiter();
    }
  }

  function detectNewWaiterOrders(orders) {
    const pendingIds = new Set((orders || []).filter(o => o.status === 'pending').map(o => o.id));
    if (knownWaiterOrderIds !== null) {
      let hasNew = false;
      for (const id of pendingIds) { if (!knownWaiterOrderIds.has(id)) { hasNew = true; break; } }
      if (hasNew && SLF.audio) SLF.audio.playNewOrderChime();
    }
    knownWaiterOrderIds = pendingIds;
  }

  ['click', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
    document.addEventListener(evt, () => { if (SLF.audio) SLF.audio.unlock(); }, { passive: true });
  });

  async function loadStoreInfo(storeId) {
    if (!storeId) return;
    if (state.storeId === storeId && state.storeName) {
      $('#storeNameDisplay').textContent = '🏬 ' + state.storeName;
      $('#storeNameDisplay').style.display = 'inline-block';
      return;
    }
    try {
      const info = await SLF.api.get('/public/store-info?store_id=' + storeId);
      if (info && info.name) {
        state.storeId = storeId;
        state.storeName = info.name;
        $('#storeNameDisplay').textContent = '🏬 ' + info.name;
        $('#storeNameDisplay').style.display = 'inline-block';
      }
    } catch (e) { /* 静默忽略 */ }
  }

  // 呼叫/催单实时通知
  let knownCallIds = new Set();
  let callPollTimer = null;
  let pendingCalls = [];

  async function pollCalls() {
    if (!state.token || document.hidden) return;
    try {
      const calls = await api('/waiter-calls');
      pendingCalls = calls || [];
      const btn = $('#callNotificationBtn');
      const count = $('#callNotificationCount');
      if (pendingCalls.length > 0) {
        btn.style.display = 'inline-flex';
        count.textContent = pendingCalls.length;
        let hasNew = false;
        for (const c of pendingCalls) { if (!knownCallIds.has(c.id)) { hasNew = true; break; } }
        if (hasNew) {
          if (SLF.audio) SLF.audio.playCallChime();
          const newCall = pendingCalls.find(c => !knownCallIds.has(c.id));
          if (newCall) {
              const isUrge = newCall.type === 'urge';
              const icon = isUrge ? '⚡' : '🔔';
              const label = isUrge ? t('urgeOrder', null, '催单') : t('callWaiter', null, '呼叫');
              SLF.ui.toast(`${icon} ${newCall.table_name} ${label}`);
          }
        }
        knownCallIds = new Set(pendingCalls.map(c => c.id));
      } else {
        btn.style.display = 'none';
        knownCallIds.clear();
      }
    } catch (e) { /* 静默失败 */ }
  }

  function startCallPolling() {
    stopCallPolling();
    callPollTimer = setInterval(pollCalls, 5000);
    pollCalls();
  }
  function stopCallPolling() {
    if (callPollTimer) clearInterval(callPollTimer);
    callPollTimer = null;
  }

  function showCallNotifications() {
      if (pendingCalls.length === 0) { SLF.ui.toast(t('noCalls', null, '暂无呼叫')); return; }
      const list = pendingCalls.map(c => {
          const isUrge = c.type === 'urge';
          const icon = isUrge ? '⚡' : '🔔';
          const label = isUrge ? t('urgeOrder', null, '催单') : t('callWaiter', null, '呼叫');
          const bg = isUrge ? 'rgba(231,76,60,.1)' : 'rgba(255,176,32,.1)';
          const border = isUrge ? 'rgba(231,76,60,.3)' : 'rgba(255,176,32,.3)';
          return `<div style="background:${bg};border:1px solid ${border};border-radius:10px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
              <div>
                  <div style="font-weight:700;">${icon} ${esc(c.table_name)} ${label}</div>
                  <div style="color:#999;font-size:12px;margin-top:2px;">${esc(c.created_at) || ''}${c.message ? ' · ' + esc(c.message) : ''}</div>
              </div>
              <button onclick="handleCall('${c.id}')" style="background:#27ae60;color:#fff;border:0;padding:6px 14px;border-radius:6px;cursor:pointer;">${t('handled', null, '已处理')}</button>
          </div>`;
      }).join('');
      let modal = document.getElementById('callNotifyModal');
      if (modal) modal.remove();
      modal = document.createElement('div');
      modal.className = 'modal';
      modal.id = 'callNotifyModal';
      modal.innerHTML = `<div class="modal-card" style="max-width:400px;">
        <div class="modal-head"><h2>🔔 ${t('callWaiter', null, '顾客呼叫')} / ⚡ ${t('urgeOrder', null, '催单')}</h2><button class="close" onclick="document.getElementById('callNotifyModal').remove()">✕</button></div>
        <div class="modal-body" style="flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;">${list}</div>
      </div>`;
      modal.style.display = 'flex';
      document.body.appendChild(modal);
  }

  async function handleCall(id) {
    try {
      await api('/waiter-calls/' + id + '/handle', { method: 'PUT' });
      SLF.ui.toast(t('handled', null, '已处理'));
      const modal = document.getElementById('callNotifyModal');
      if (modal) modal.remove();
      pollCalls();
    } catch (e) { SLF.ui.toast(t('handleFailed', null, '处理失败') + ': ' + e.message); }
  }

  // 订单历史
  let historyOrders = [];

  function showOrderHistory() {
    document.getElementById('orderHistoryModal').style.display = 'flex';
    document.getElementById('orderHistoryTitle').textContent = '📋 ' + t('orderHistory', null, '订单历史');
    const statusSelect = document.getElementById('historyStatusFilter');
    statusSelect.options[0].text = t('allStatus', null, '全部状态');
    statusSelect.options[1].text = t('pending', null, '制作中');
    statusSelect.options[2].text = t('completed', null, '已完成');
    statusSelect.options[3].text = t('canceled', null, '已取消');
    loadOrderHistory();
  }
  function hideOrderHistory() {
    document.getElementById('orderHistoryModal').style.display = 'none';
  }

  async function loadOrderHistory() {
    try {
      const statusFilter = document.getElementById('historyStatusFilter').value;
      const dateFilter = document.getElementById('historyDateFilter').value;
      let url = '/orders';
      const params = [];
      if (statusFilter) params.push('status=' + encodeURIComponent(statusFilter));
      if (params.length > 0) url += '?' + params.join('&');
      const orders = await api(url);
      historyOrders = orders || [];
      let filtered = historyOrders;
      if (dateFilter) {
        filtered = historyOrders.filter(o => {
          const d = new Date(o.createdAt);
          if (isNaN(d.getTime())) return false;
          const orderDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          return orderDate === dateFilter;
        });
      }
      const container = document.getElementById('orderHistoryList');
      if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:#999;">' + t('noOrders', null, '暂无订单') + '</div>';
        return;
      }
      const statusMap = { pending: t('pending', null, '制作中'), done: t('completed', null, '已完成'), canceled: t('canceled', null, '已取消') };
      container.innerHTML = filtered.map(o => `
        <div onclick="showOrderDetail(${o.id})" style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:10px;padding:14px;margin-bottom:10px;cursor:pointer;transition:all .2s;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <div style="font-weight:700;font-size:15px;">${esc(o.order_no || ("#"+o.id))} ${t('table', null, '桌号')} ${esc(o.table) || '-'}</div>
            <span style="background:${o.status === 'done' ? '#27ae60' : o.status === 'canceled' ? '#95a5a6' : '#f39c12'};color:#fff;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600;">${statusMap[o.status] || o.status}</span>
          </div>
          <div style="color:#666;font-size:13px;">${SLF.utils.formatDateTime(o.createdAt)}</div>
          <div style="display:flex;justify-content:space-between;margin-top:8px;">
            <span style="color:#888;font-size:13px;">${(o.items || []).length} ${t('dishes', null, '道菜品')}</span>
            <span style="font-weight:700;color:#e74c3c;">${SLF.money.format(o.total)}</span>
          </div>
        </div>
      `).join('');
    } catch (e) {
      document.getElementById('orderHistoryList').innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">' + e.message + '</div>';
    }
  }

  function showOrderDetail(id) {
    const order = historyOrders.find(o => o.id === id);
    if (!order) return;
    const modal = document.getElementById('orderDetailModal');
    const content = document.getElementById('orderDetailContent');
    document.getElementById('orderDetailTitle').textContent = t('order', null, '订单') + ' #' + id;
    const statusMap = { pending: t('pending', null, '制作中'), done: t('completed', null, '已完成'), canceled: t('canceled', null, '已取消') };
    content.innerHTML = `
      <div style="margin-bottom:15px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#666;">${t('table', null, '桌号')}</span><span style="font-weight:600;">${esc(order.table) || '-'}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#666;">${t('status', null, '状态')}</span><span style="font-weight:600;">${statusMap[order.status] || order.status}</span></div>
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#666;">${t('orderTime', null, '下单时间')}</span><span>${SLF.utils.formatDateTime(order.createdAt)}</span></div>
        ${order.note ? `<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:#666;">${t('note', null, '备注')}</span><span>${esc(order.note)}</span></div>` : ''}
      </div>
      <div style="border-top:1px solid #eee;padding-top:12px;margin-bottom:12px;">
        <div style="font-weight:700;margin-bottom:10px;">${t('dishes', null, '菜品')}</div>
        ${(order.items || []).map((item) => `
          <div class="order-detail-item">
            <span class="dish-name">${esc(item.emoji) || '🍽️'} ${esc(item.name)} x${item.quantity}</span>
            <span class="item-price">${SLF.money.format((Number(item.price) || 0) * item.quantity, { secondaryCode: item.secondary_currency_code })}</span>
          </div>
        `).join('')}
      </div>
      <div style="border-top:2px solid #333;padding-top:12px;display:flex;justify-content:space-between;font-size:18px;font-weight:700;">
        <span>${t('total', null, '合计')}</span>
        <span style="color:#e74c3c;">${SLF.money.format(order.total)}</span>
      </div>
    `;
    modal.style.display = 'flex';
  }
  function hideOrderDetail() {
    document.getElementById('orderDetailModal').style.display = 'none';
  }

  // 自动刷新
  let waiterAutoRefreshTimer = null;
  let _socketConnected = false;
  function startWaiterAutoRefresh(intervalSec) {
    stopWaiterAutoRefresh();
    const secs = Math.max(3, parseInt(intervalSec, 10) || 8);
    if (_socketConnected) {
      console.log('[waiter] socket connected, paused polling');
      return;
    }
    waiterAutoRefreshTimer = setInterval(() => {
      if (state.token && !document.hidden && !_socketConnected) load();
    }, secs * 1000);
  }

  function updateWaiterPollingBySocket(intervalSec) {
    if (_socketConnected && waiterAutoRefreshTimer) {
      clearInterval(waiterAutoRefreshTimer);
      waiterAutoRefreshTimer = null;
      console.log('[waiter] socket connected, paused polling');
    } else if (!_socketConnected && !waiterAutoRefreshTimer) {
      startWaiterAutoRefresh(intervalSec || 8);
    }
  }
  function stopWaiterAutoRefresh() {
    if (waiterAutoRefreshTimer) clearInterval(waiterAutoRefreshTimer);
    waiterAutoRefreshTimer = null;
  }

  // 转移桌号
  let transferFromTable = null;
  window.showTransferModal = function(tableName) {
    transferFromTable = tableName;
    const active = state.orders.filter(o => o.table === tableName && o.status === 'pending');
    if (!active.length) { SLF.ui.toast(t('noPending', null, '暂无未结算订单')); return; }
    document.getElementById('transferTitle').textContent = '↔ ' + t('transferOrder', null, '转移');
    document.getElementById('transferToLabel').textContent = t('transferTo', null, '转移到');
    document.getElementById('transferCancelBtn').textContent = t('cancel', null, '取消');
    document.getElementById('transferConfirmBtn').textContent = t('confirm', null, '确定');
    document.getElementById('transferFromLabel').textContent = t('transferFrom', null, '当前桌') + ': ' + tableName + ' (' + active.length + ' ' + t('order', null, '订单') + ')';
    const select = document.getElementById('transferTargetSelect');
    const others = state.tables.filter(x => x.name !== tableName);
    select.innerHTML = others.map(x => '<option value="' + esc(x.name) + '">' + esc(x.name) + '</option>').join('');
    document.getElementById('transferModal').classList.add('open');
  };
  window.closeTransferModal = function() {
    document.getElementById('transferModal').classList.remove('open');
    transferFromTable = null;
  };
  window.confirmTransfer = async function() {
    if (!transferFromTable) return;
    const target = document.getElementById('transferTargetSelect').value;
    showConfirm(t('transferConfirmMsg', null, '确认转移') + ' ' + transferFromTable + ' → ' + target, async function() {
      try {
        const res = await api('/tables/move', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ from_table: transferFromTable, target_table: target }) });
        if (res && res.count > 0) SLF.ui.toast('✅ ' + t('transferSuccess', null, '转移成功') + ' (' + res.count + ' 单)');
        else SLF.ui.toast('ℹ️ ' + t('noUnsettledOrders', null, '当前桌没有未结算订单'));
        closeTransferModal();
        await load();
      } catch(e) { SLF.ui.toast('❌ ' + e.message); }
    });
  };

  function renderTables() {
    $('#tableGrid').innerHTML = state.tables.map(table => {
      const hasActiveOrder = state.orders.some(o => o.table === table.name && o.status === 'pending');
      const statusClass = hasActiveOrder ? 'occupied' : 'available';
      const statusText = hasActiveOrder ? t('occupied', null, '已占') : t('available', null, '空闲');
      const transferBtn = hasActiveOrder ? `<div style="position:absolute;top:14px;right:14px;"><button data-table='${esc(table.name)}' class='transfer-btn' style="width:44px;height:44px;border-radius:50%;background:#fff;border:2px solid rgba(232,74,42,0.4);color:var(--primary);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.1);z-index:10;transition:all 0.2s;" title="${t('transferOrder', null, '转移')}">↔</button></div>` : '';
      return `<div class="table-card" onclick="openModal('${esc(table.name)}')">${transferBtn}<div class="name">🍽️ ${esc(table.name)} <span class="status ${statusClass}">${statusText}</span></div><div class="bill">${bill(table)}</div></div>`;
    }).join('') || `<div style="color:#c8c8d0">${t('noTables', null, '暂无桌号')}</div>`;
    $('#submitBtn').style.display = state.waiter && state.waiter.can_order ? 'block' : 'none';
    document.querySelectorAll('.transfer-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        window.showTransferModal(this.dataset.table);
      });
    });
  }

  function openModal(table) {
    state.currentTable = table;
    const tableOrders = state.orders.filter(o => o.table === table && o.status === 'pending');
    if (tableOrders.length > 1) {
      showOrderSelect(tableOrders);
      return;
    }
    openOrderEditor(table, tableOrders[0] || null);
  }

  function openOrderEditor(table, order) {
    state.currentTable = table;
    state.cart = {};
    state.cartMeta = {};
    state.lockedItems = [];
    state.currentCategory = 'all';
    if (order && order.items && order.items.length) {
      state.lockedItems = order.items.filter(i => i.itemStatus === 'done' || i.status === 'done' || i.completed === true);
      order.items.filter(i => !(i.itemStatus === 'done' || i.status === 'done' || i.completed === true)).forEach(i => {
        const menuItem = state.menu.find(m => (m.id == i.id || m.id === +i.id || m.name === i.name));
        const itemId = menuItem ? menuItem.id : (i.id || i.name);
        const qty = i.quantity || i.qty || 1;
        state.cart[itemId] = (state.cart[itemId] || 0) + qty;
        state.cartMeta[itemId] = menuItem || i;
      });
    }
    let tableLabel = t('currentTable', null, '当前桌号') + '：' + table;
    if (order && order.sessionToken) {
      const tableOrders = state.orders.filter(o => o.table === table && o.status === 'pending');
      const labels = buildSessionLabels(tableOrders);
      const customerLabel = labels.get(order.id);
      if (customerLabel) {
        const customerColor = SLF.customerGroup.color(customerLabel);
        tableLabel += ' <span class="session-badge" style="background:' + customerColor.bg + ';color:' + customerColor.color + ';">' + customerLabel + '</span>';
      }
    }
    $('#currentTableBadge').innerHTML = tableLabel;
    $('#submitBtn').textContent = order ? t('saveChanges', null, '保存修改') : t('submitOrder', null, '提交订单');
    renderDishes();
    $('#orderModal').classList.add('open');
  }

  function showOrderSelect(tableOrders) {
    $('#orderSelectTitle').textContent = t('currentTable', null, '当前桌号') + '：' + state.currentTable + ' - ' + t('selectOrder', null, '选择订单');
    const labels = buildSessionLabels(tableOrders);
    const listEl = $('#orderSelectList');
    let html = '';
    tableOrders.forEach((order, idx) => {
      const customerLabel = labels.get(order.id) || (t('order', null, '订单') + (idx + 1));
      const itemCount = order.items ? order.items.length : 0;
      const timeStr = order.createdAt ? new Date(order.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      html += '<div class="order-select-item" onclick="selectOrder(' + order.id + ')" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border:1px solid var(--gray-2);border-radius:10px;margin-bottom:10px;cursor:pointer;transition:all .2s;">';
      html += '<div><div style="font-weight:600;font-size:15px;">' + esc(customerLabel) + '</div><div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">' + itemCount + ' ' + t('dishes', null, '道菜品') + ' · ' + timeStr + '</div></div>';
      html += '<div style="font-weight:700;color:var(--primary);">' + SLF.money.format(order.total || 0) + '</div>';
      html += '</div>';
    });
    listEl.innerHTML = html;
    $('#orderSelectModal').classList.add('open');
  }

  function selectOrder(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (!order) return;
    const t_ = state.currentTable;
    closeOrderSelect();
    openOrderEditor(t_, order);
  }
  function createNewOrderFromSelect() {
    const t_ = state.currentTable;
    closeOrderSelect();
    openOrderEditor(t_, null);
  }
  function closeOrderSelect() {
    $('#orderSelectModal').classList.remove('open');
    state.currentTable = null;
  }

  function closeModal() {
    $('#orderModal').classList.remove('open');
    state.currentTable = null;
    state.cart = {};
    state.cartMeta = {};
    state.editingOrderId = null;
    state.lockedItems = [];
    $('#submitBtn').textContent = t('submitOrder', null, '提交订单');
  }

  function renderSelected() {
    const items = Object.entries(state.cart).filter(([id, q]) => q > 0).map(([id, q]) => {
      let m = state.menu.find(x => (x.id == id || x.id === +id || x.name === id)) || state.cartMeta[id];
      if (!m) m = state.menu.find(x => state.cartMeta[id] && (x.id == state.cartMeta[id].id || x.name === state.cartMeta[id].name));
      return m ? { m, q, id } : null;
    }).filter(Boolean);

    const cartHtml = items.length ? items.map(x => {
      const prices = SLF.money.menuPrice(x.m);
      let priceDisplay = prices.primary;
      if (prices.secondary) priceDisplay += ' (' + prices.secondary + ')';
      const statusLabel = '<span class="item-status new">' + t('newItem', null, '新下单') + '</span>';
      const itemId = x.m.id || x.id;
      return '<div class="selected-item"><span class="sel-name">' + esc(x.m.name) + ' ' + statusLabel + '</span><span class="sel-price">' + priceDisplay + '</span><div class="qty"><button onclick="changeQty(' + itemId + ',-1)">−</button><span>' + x.q + '</span><button onclick="changeQty(' + itemId + ',1)">+</button></div><button class="remove-btn" onclick="removeItem(' + itemId + ')">' + t('remove', null, '移除') + '</button></div>';
    }).join('') : '';

    let doneHtml = '';
    if (state.lockedItems.length) {
      doneHtml = state.lockedItems.map(i => {
        const prices = SLF.money.menuPrice(i);
        let priceDisplay = prices.primary;
        if (prices.secondary) priceDisplay += ' (' + prices.secondary + ')';
        return '<div class="selected-item" style="opacity:.55;pointer-events:none;"><span class="sel-name">' + esc(i.name) + ' <span class="item-status done">' + t('dishServed', null, '已上菜') + '</span></span><span class="sel-price">' + priceDisplay + '</span><div class="qty"><span>×' + (i.quantity || 1) + '</span></div></div>';
      }).join('');
    }
    const emptyHtml = (!items.length && !state.lockedItems.length) ? '<div style="color:#c8c8d0">' + t('emptySelected', null, '尚未选择菜品') + '</div>' : '';
    $('#selectedItems').innerHTML = '<div class="title">' + t('selectedDishes', null, '已选菜品') + '</div>' + cartHtml + doneHtml + emptyHtml;
  }

  function transCategory(cat) {
      const lang = SLF.i18n.lang;
      const localDict = (SLF.i18n.dicts[lang] && SLF.i18n.dicts[lang].categories) || {};
      if (localDict[cat]) return localDict[cat];
      const globalDict = (window.LANGUAGES && window.LANGUAGES[lang] && window.LANGUAGES[lang].categories) || {};
      return globalDict[cat] || cat;
  }

  function renderCategories() {
    const categories = ['all', ...new Set(state.menu.map(m => m.category).filter(Boolean))];
    const catHtml = categories.map(cat => {
      const label = cat === 'all' ? t('allCategories', null, '全部') : transCategory(cat);
      const active = state.currentCategory === cat ? 'active' : '';
      return `<button class="cat-btn ${active}" onclick="setDishCategory('${esc(cat)}')">${esc(label)}</button>`;
    }).join('');
    $('#dishCategories').innerHTML = catHtml;
  }

  function setDishCategory(cat) {
    state.currentCategory = cat;
    renderDishes();
  }

  function renderDishes() {
    renderCategories();
    let sortedMenu = [...state.menu].sort((a, b) => (Number(b.sales_count) || 0) - (Number(a.sales_count) || 0));
    if (state.currentCategory !== 'all') {
      sortedMenu = sortedMenu.filter(m => m.category === state.currentCategory);
    }
    $('#dishList').innerHTML = sortedMenu.map(m => {
      const cartQty = state.cart[m.id] || 0;
      const prices = SLF.money.menuPrice(m);
      let priceDisplay = prices.primary;
      if (prices.secondary) priceDisplay += ` <span class="price-secondary">(${prices.secondary})</span>`;
      const qtyHtml = `<button onclick="changeQty(${m.id},-1)">−</button><span>${cartQty}</span><button onclick="changeQty(${m.id},1)">+</button>`;
      return `<div class="dish-item"><div class="dish-thumb">${m.image ? `<img src="/uploads/${esc(m.image)}" alt="${esc(m.name)}">` : esc(m.emoji) || '🍽️'}</div><div class="info"><div class="name">${esc(m.name)}</div><div class="price">${priceDisplay}/${esc(m.unit) || t('unit', null, '份')}</div></div><div class="qty">${qtyHtml}</div></div>`;
    }).join('');
    renderSelected();
    updateTotal();
  }

  function changeQty(id, delta) {
    state.cart[id] = (state.cart[id] || 0) + delta;
    if (state.cart[id] <= 0) delete state.cart[id];
    renderDishes();
  }

  function removeItem(id) {
    delete state.cart[id];
    delete state.cartMeta[id];
    renderDishes();
  }

  function updateTotal() {
    let totalBase = 0;
    for (const [id, q] of Object.entries(state.cart)) {
      const m = state.menu.find(x => x.id === +id) || state.cartMeta[id];
      if (m) totalBase += SLF.money.toBase(m.price, m.currency_code) * q;
    }
    for (const i of state.lockedItems) {
      totalBase += SLF.money.toBase(i.price, i.currency_code) * i.quantity;
    }
    $('#orderTotal').textContent = SLF.money.format(totalBase);
  }

  $('#submitBtn').onclick = async function () {
    if (!state.currentTable) { SLF.ui.toast(t('noTables', null, '暂无桌号')); return; }
    showConfirm(t('confirmSubmit', null, '确认提交此订单？'), async function () {
      const cartItems = Object.entries(state.cart).filter(([id, q]) => q > 0).map(([id, q]) => {
        const m = state.menu.find(x => x.id === +id);
        return { id: m.id, name: m.name, price: m.price, quantity: q, emoji: m.emoji, itemStatus: 'pending', show_dual: m.show_dual || 0, secondary_currency_code: m.secondary_currency_code || '', unit: m.unit || t('unit', null, '份') };
      });
      const lockedItems = state.lockedItems.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity, emoji: i.emoji, itemStatus: 'done', show_dual: i.show_dual || 0, secondary_currency_code: i.secondary_currency_code || '', unit: i.unit || t('unit', null, '份') }));
      const items = [...lockedItems, ...cartItems];
      if (!items.length) { SLF.ui.toast(t('selectDish', null, '请先选择菜品')); return; }
      try {
        if (state.editingOrderId) {
          await api('/orders/' + state.editingOrderId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
          SLF.ui.toast('✅ ' + t('orderUpdated', null, '订单已更新'));
        } else {
          const res = await api('/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ table: state.currentTable, items }) });
          SLF.ui.toast(`✅ ${state.currentTable} ${t('orderSubmitted', null, '订单已提交')} ${res.orderNo || ("#"+res.orderId)}`);
        }
        closeModal();
        await load();
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    });
  };

  async function setLanguage(lang) {
      waiterLang = lang;
      SLF.i18n.lang = lang;

      if (!SLF.i18n.dicts[lang] && window.LANGUAGES && window.LANGUAGES[lang]) {
          SLF.i18n.dicts[lang] = { ...window.LANGUAGES[lang] };
      }

      SLF.store.rawSet('waiterLang', lang);
      SLF.store.rawSet('lang', lang);
      if (state.token) {
          applyWaiterLanguage();
          if (state.menu) renderDishes();
      }
  }

  document.getElementById('waiterLang').addEventListener('change', async function () {
    await setLanguage(this.value);
  });

  const savedLang = SLF.store.rawGet('waiterLang') || 'zh';
  waiterLang = savedLang;

  function initWaiterPage() {
    try {
      if (state.token) {
        document.getElementById('mainHeader').style.display = 'flex';
        document.getElementById('mainContent').style.display = 'block';
        applyWaiterLanguage();
        load().then(() => { startCallPolling(); }).catch((e) => {
          if (e && e.message && e.message.includes('登录已过期')) {
            logoutWaiter();
          } else {
            console.error('加载失败:', e);
            SLF.ui.toast(t('loadFailed', null, '加载失败'));
          }
        });
      } else {
        window.location.href = '/login?type=waiter';
      }
    } catch (e) {
      console.error('服务员端初始化错误:', e);
      window.location.href = '/login?type=waiter';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWaiterPage);
  } else {
    initWaiterPage();
  }

  // Socket（传 waiterToken）
  if (typeof io === 'function') {
    const waiterSocket = io({
      query: {
        storeId: SLF.store.rawGet('storeId') || 1,
        token: SLF.store.rawGet('waiterToken') || ''
      }
    });
    // ============ Socket 增量更新（避免全量拉取）============
    function belongsToStore(o) {
      const sid = SLF.store.rawGet('storeId') || '1';
      return !o || !o.store_id || String(o.store_id) === String(sid);
    }

    waiterSocket.on('order:new', (order) => {
      if (!order || !belongsToStore(order)) return;
      if (order.status !== 'pending') return;
      // 本地插入
      state.orders = state.orders.filter(o => o.id !== order.id);
      state.orders.unshift(order);
      // 若当前桌台已打开，不自动重绘（避免打断用户操作）
      renderTables();
    });

    waiterSocket.on('item:updated', (payload) => {
      if (!payload || !payload.order) return;
      const updated = payload.order;
      if (!belongsToStore(updated)) return;
      state.orders = state.orders.map(o => o.id === updated.id ? updated : o);
      renderTables();
    });

    waiterSocket.on('order:settled', (payload) => {
      const id = payload && payload.orderId;
      if (!id) return;
      state.orders = state.orders.filter(o => o.id !== id);
      renderTables();
    });

    // 转移订单 / 整桌转移：涉及状态重组，仍拉全量
    let transferDebounce = null;
    waiterSocket.on('order:transfer', () => {
      clearTimeout(transferDebounce);
      transferDebounce = setTimeout(() => { if (typeof load === 'function') load(); }, 300);
    });
    waiterSocket.on('table:moved', () => {
      clearTimeout(transferDebounce);
      transferDebounce = setTimeout(() => { if (typeof load === 'function') load(); }, 300);
    });

    // 重连成功后全量刷新一次
    waiterSocket.on('connect', () => {
      console.log('[waiter] socket connected');
      _socketConnected = true;
      updateWaiterPollingBySocket();
      if (typeof load === 'function') load();
    });
    waiterSocket.on('disconnect', () => {
      console.warn('[waiter] socket disconnected, will rely on polling');
      _socketConnected = false;
      updateWaiterPollingBySocket();
    });

    waiterSocket.on('connect_error', (err) => { console.warn('waiterSocket connect_error:', err.message); });
    window.addEventListener('beforeunload', () => {
      try { waiterSocket.disconnect(); } catch (_) {}
    });
  }
    try { window.changeQty = changeQty; } catch(err) {}
    try { window.closeModal = closeModal; } catch(err) {}
    try { window.closeOrderSelect = closeOrderSelect; } catch(err) {}
    try { window.closeTransferModal = closeTransferModal; } catch(err) {}
    try { window.completeWaiterOrder = completeWaiterOrder; } catch(err) {}
    try { window.confirmTransfer = confirmTransfer; } catch(err) {}
    try { window.createNewOrderFromSelect = createNewOrderFromSelect; } catch(err) {}
    try { window.handleCall = handleCall; } catch(err) {}
    try { window.hideOrderDetail = hideOrderDetail; } catch(err) {}
    try { window.hideOrderHistory = hideOrderHistory; } catch(err) {}
    try { window.openModal = openModal; } catch(err) {}
    try { window.removeItem = removeItem; } catch(err) {}
    try { window.returnWaiterItem = returnWaiterItem; } catch(err) {}
    try { window.selectOrder = selectOrder; } catch(err) {}
    try { window.setDishCategory = setDishCategory; } catch(err) {}
    try { window.showCallNotifications = showCallNotifications; } catch(err) {}
    try { window.showOrderDetail = showOrderDetail; } catch(err) {}
    try { window.showOrderHistory = showOrderHistory; } catch(err) {}
    try { window.toggleFullscreen = toggleFullscreen; } catch(err) {}
    try { window.toggleSelectedItem = toggleSelectedItem; } catch(err) {}
    try { window.toggleWaiterItem = toggleWaiterItem; } catch(err) {}
    try { window.loadOrderHistory = loadOrderHistory; } catch(err) {}
})();