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
    selectedItem: null,
    tableSearchQuery: '',
    tableFilter: 'all',
    expandedOrderIds: new Set()
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

    // ===== 通用 data-i18n 扫描：翻译所有带 data-i18n / data-i18n-title 的元素 =====
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        const translated = t(key, null, el.textContent);
        if (translated && translated !== key) el.textContent = translated;
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (key) {
        const translated = t(key, null, el.placeholder || '');
        if (translated && translated !== key) el.placeholder = translated;
      }
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        const translated = t(key, null, el.title || '');
        if (translated && translated !== key) el.title = translated;
      }
    });

    if (SLF.ui && SLF.ui.applyI18n) SLF.ui.applyI18n();
    renderTables();
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

  const api = (path, opt) => SLF.api.page(path, opt);

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

      // 统计该订单未完成菜品数
      const pendingCount = (o.items || []).filter(i => i.itemStatus !== 'done').length;
      const totalDishCount = (o.items || []).length;
      const isExpanded = state.expandedOrderIds.has(o.id);
      const arrow = isExpanded ? '▼' : '▶';
      const pendingTip = pendingCount > 0
        ? `<span class="pending-tip">⚠️ ${pendingCount} ${t('dishesPending', null, '道未完成')}</span>`
        : `<span class="ready-tip">✅ ${t('allDone', null, '全部完成')}</span>`;

      const _awaitingTip = o.awaiting_confirm
        ? `<span class="pending-tip" style="background:rgba(255,193,7,.18);color:#856404;">🔔 已通知收银员</span>`
        : '';
      return `<div class="order-block ${isExpanded ? 'expanded' : 'collapsed'}">
        <div class="order-head" onclick="event.stopPropagation();toggleOrderExpand(${o.id})" style="cursor:pointer;">
          <div class="order-head-left">
            <span class="order-arrow">${arrow}</span>
            <span class="order-no">${o.order_no || ("#"+o.id)}</span>
            ${badge}
            <span class="order-dish-count">${totalDishCount} ${t('dishes', null, '道')}</span>
          </div>
          <div class="order-head-right">
            ${_awaitingTip}
            ${pendingTip}
            <span class="order-amount">${orderTotalDisplay}</span>
            
          </div>
        </div>
        ${isExpanded ? `${noteHtml}<div class="bill-items">${lines}</div>` : ''}
      </div>`;
    }).join('');
    return active.length ? `<div class="amount" style="display:flex;align-items:center;justify-content:space-between;">${active.length} ${t('order', null, '订单')} · ${totalDisplay}</div>${blocks}` : `<div class="amount" style="color:#c8c8d0">${t('noCustomerOrder', null, '暂无顾客下单')}</div>`;
  }

  function toggleOrderExpand(orderId) {
    if (state.expandedOrderIds.has(orderId)) {
      state.expandedOrderIds.delete(orderId);
    } else {
      state.expandedOrderIds.add(orderId);
    }
    renderTables();
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

  // ===== 从编辑卡片点结算：弹订单详情二次确认 =====
  const _settleConfirmedIds = new Set();   // 已确认过的订单 id，后续同订单不再弹
  let _settlePayMethod = 'cash';           // 结算弹窗里选中的收款方式

  function syncSettlePayMethodUI() {
    document.querySelectorAll('#settlePayMethods .pay-method-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.method === _settlePayMethod);
    });
  }
  window.selectSettlePayMethod = function(method) {
    _settlePayMethod = method;
    syncSettlePayMethodUI();
  };

  function handleSettleFromEditor() {
    const id = state.editingOrderId;
    if (!id) { SLF.ui.toast('❌ ' + t('pleaseSaveFirst', null, '请先保存订单再结算')); return; }
    const order = state.orders.find(o => o.id === id);
    if (!order) { SLF.ui.toast('❌ ' + t('orderNotFound', null, '订单不存在')); return; }
    // 打开收款弹窗（与收银台一致），收款完成后由 waiter-payment.js 回调 doSettleFromEditor
    if (typeof window.openPaymentModal === 'function') {
      window.openPaymentModal(id, order);
      return;
    }
    // 兜底：没有 payment 模块时走旧逻辑
    if (_settleConfirmedIds.has(id)) { doSettleFromEditor(id); return; }

    // 已确认过：直接结算
    if (_settleConfirmedIds.has(id)) {
      doSettleFromEditor(id);
      return;
    }

    // 首次确认：展示订单详情
    const body = document.getElementById('settleConfirmBody');
    if (body) {
      let html = '';
      html += `<div style="margin-bottom:12px;color:#666;font-size:13px;">`;
      html += `🏷️ ${esc(order.table || '-')} &nbsp; `;
      html += `<span style="font-size:16px;color:#e85d3a;font-weight:700;padding:2px 8px;background:#fff2ec;border-radius:6px;">${esc(order.order_no || ('#' + order.id))}</span>`;
      html += `</div>`;

      html += `<div style="border:1px solid #f0f0f0;border-radius:10px;overflow:hidden;">`;
      (order.items || []).forEach((it, idx) => {
        const qty = Number(it.quantity) || 0;
        const returned = Number(it.returnedQty) || 0;
        const unitBase = SLF.money.toBase(it.price, it.currency_code);
        const lineBase = unitBase * (qty - returned);
        const unitDisplay = SLF.money.primary(unitBase);
        const lineDisplay = SLF.money.format(lineBase);
        html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;${idx > 0 ? 'border-top:1px solid #f5f5f5;' : ''}">`;
        html += `<span style="flex:1;min-width:0;"><span style="margin-right:6px;">${esc(it.emoji || '🍽️')}</span>${esc(it.name)}`;
        html += `<span style="color:#999;font-size:12px;margin-left:6px;">×${qty}${returned > 0 ? ' (' + t('returned', null, '退') + returned + ')' : ''} @${unitDisplay}</span></span>`;
        html += `<span style="font-weight:600;color:#e74c3c;white-space:nowrap;">${lineDisplay}</span>`;
        html += `</div>`;
      });
      html += `</div>`;

      const totalBase = (order.items || []).reduce((sum, it) => {
        const unitBase = SLF.money.toBase(it.price, it.currency_code);
        const q = Number(it.quantity) || 0;
        const r = Number(it.returnedQty) || 0;
        return sum + unitBase * (q - r);
      }, 0);
      html += `<div style="margin-top:12px;padding-top:12px;border-top:2px solid #333;display:flex;justify-content:space-between;font-size:16px;font-weight:700;">`;
      html += `<span>${t('total', null, '合计')}</span><span style="color:#e74c3c;">${SLF.money.format(totalBase)}</span>`;
      html += `</div>`;

      body.innerHTML = html;
    }
    _settlePayMethod = 'cash';
    syncSettlePayMethodUI();
    document.getElementById('settleConfirmModal').classList.add('open');
  }

  function closeSettleConfirm() {
    document.getElementById('settleConfirmModal').classList.remove('open');
  }

  async function confirmSettleFromEditor() {
    const id = state.editingOrderId;
    closeSettleConfirm();
    if (!id) return;
    _settleConfirmedIds.add(id);   // 记住已确认，后续同订单不再弹
    await doSettleFromEditor(id);
  }

  async function doSettleFromEditor(id) {
    try {
      await api('/orders/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done', pay_method: _settlePayMethod })
      });
      SLF.ui.toast('✅ ' + t('settleOrder', null, '已结算'));
      if (typeof closeModal === 'function') closeModal();
      await load();
    } catch (e) {
      const msg = e.message.includes('未完成菜品')
        ? (t('incompleteItemsError', null, e.message))
        : e.message;
      SLF.ui.toast('❌ ' + msg);
    }
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
            <span class="item-price">${SLF.money.format((Number(item.price) || 0) * item.quantity)}</span>
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
      SLF.log.debug('[waiter] socket connected, paused polling');
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
      SLF.log.debug('[waiter] socket connected, paused polling');
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
    // 搜索 + 过滤
    const q = (state.tableSearchQuery || '').trim().toLowerCase();
    let tables = state.tables;
    if (q) {
      tables = tables.filter(t => String(t.name).toLowerCase().includes(q));
    }
    if (state.tableFilter === 'occupied') {
      tables = tables.filter(t => state.orders.some(o => o.table === t.name && o.status === 'pending'));
    } else if (state.tableFilter === 'available') {
      tables = tables.filter(t => !state.orders.some(o => o.table === t.name && o.status === 'pending'));
    }

    $('#tableGrid').innerHTML = tables.map(table => {
      const hasActiveOrder = state.orders.some(o => o.table === table.name && o.status === 'pending');
      const statusClass = hasActiveOrder ? 'occupied' : 'available';
      const statusText = hasActiveOrder ? t('occupied', null, '已占') : t('available', null, '空闲');
      // 右上角按钮组（放在 .name 行内，不用绝对定位）
      const canOrder = state.waiter && state.waiter.can_order;
      const newBtn = canOrder
        ? `<button data-table='${esc(table.name)}' class='new-order-btn' title="${t('createNewOrder', null, '新建订单')}">+</button>`
        : '';
      const transferBtn = hasActiveOrder
        ? `<button data-table='${esc(table.name)}' class='transfer-btn' title="${t('transferOrder', null, '转移')}">↔</button>`
        : '';
      const actions = (newBtn || transferBtn)
        ? `<div class="table-card-actions">${newBtn}${transferBtn}</div>`
        : '';
      return `<div class="table-card" onclick="openModal('${esc(table.name)}')"><div class="name"><span class="name-left">🍽️ ${esc(table.name)} <span class="status ${statusClass}">${statusText}</span></span>${actions}</div><div class="bill">${bill(table)}</div></div>`;
    }).join('') || `<div style="color:#c8c8d0;text-align:center;padding:40px;grid-column:1/-1;">${state.tableSearchQuery || state.tableFilter !== 'all' ? '🔍 ' + t('noData', null, '无匹配结果') : t('noTables', null, '暂无桌号')}</div>`;
    $('#submitBtn').style.display = state.waiter && state.waiter.can_order ? 'block' : 'none';
    document.querySelectorAll('.transfer-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        window.showTransferModal(this.dataset.table);
      });
    });
    document.querySelectorAll('.new-order-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        openOrderEditor(this.dataset.table, null);
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
    let tableLabel = '<span data-i18n="currentTable">' + t('currentTable', null, '当前桌号') + '</span>：' + table;
    // 有订单时显示订单号
    if (order && (order.order_no || order.id)) {
      const orderNoText = order.order_no || ('#' + order.id);
      tableLabel += ' <span style="font-size:13px;color:#888;font-weight:500;margin-left:8px;" data-i18n="orderNoPrefix">' + t('order', null, '订单') + '</span> <span style="font-size:16px;color:#e85d3a;font-weight:700;padding:2px 8px;background:#fff2ec;border-radius:6px;">' + esc(orderNoText) + '</span>';
    }
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
    state.editingOrderId = order ? order.id : null;
    $('#submitBtn').textContent = order ? t('submitOrder', null, '提交') : t('submitOrder', null, '提交订单');
    // 编辑已有未结算订单且服务员有结算权限时，显示"结算"按钮
    const settleBtn = $('#settleBtn');
    if (settleBtn) {
      const canSettle = order && order.status === 'pending' && state.waiter && state.waiter.can_complete_order;
      settleBtn.textContent = t('settleOrder', null, '结算');
      settleBtn.style.display = canSettle ? 'inline-block' : 'none';
    }
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
    const settleBtn = $('#settleBtn');
    if (settleBtn) settleBtn.style.display = 'none';
  }

  function renderSelected() {
    const items = Object.entries(state.cart).filter(([id, q]) => q > 0).map(([id, q]) => {
      let m = state.menu.find(x => (x.id == id || x.id === +id || x.name === id)) || state.cartMeta[id];
      if (!m) m = state.menu.find(x => state.cartMeta[id] && (x.id == state.cartMeta[id].id || x.name === state.cartMeta[id].name));
      return m ? { m, q, id } : null;
    }).filter(Boolean);

    const cartHtml = items.length ? items.map(x => {
      const prices = SLF.money.menuPrice(x.m);
      let priceDisplay = '<span class="money-primary">' + prices.primary + '</span>';
      if (prices.secondary) priceDisplay += ' <span class="money-secondary">(' + prices.secondary + ')</span>';
      const statusLabel = '<span class="item-status new">' + t('newItem', null, '新下单') + '</span>';
      const itemId = x.m.id || x.id;
      return '<div class="selected-item"><span class="sel-name">' + esc(x.m.name) + ' ' + statusLabel + '</span><span class="sel-price">' + priceDisplay + '</span><div class="qty"><button onclick="changeQty(' + itemId + ',-1)">−</button><span>' + x.q + '</span><button onclick="changeQty(' + itemId + ',1)">+</button></div><button class="remove-btn" onclick="removeItem(' + itemId + ')">' + t('remove', null, '移除') + '</button></div>';
    }).join('') : '';

    let doneHtml = '';
    if (state.lockedItems.length) {
      doneHtml = state.lockedItems.map(i => {
        const prices = SLF.money.menuPrice(i);
        let priceDisplay = '<span class="money-primary">' + prices.primary + '</span>';
        if (prices.secondary) priceDisplay += ' <span class="money-secondary">(' + prices.secondary + ')</span>';
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
      let priceDisplay = `<span class="money-primary">${prices.primary}</span>`;
      if (prices.secondary) priceDisplay += ` <span class="money-secondary">(${prices.secondary})</span>`;
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

  let _submittingWaiterOrder = false;
  $('#submitBtn').onclick = async function () {
    if (_submittingWaiterOrder) return;
    _submittingWaiterOrder = true;
    try {
    if (!state.currentTable) { SLF.ui.toast(t('noTables', null, '暂无桌号')); _submittingWaiterOrder = false; return; }
    showConfirm(t('confirmSubmit', null, '确认提交此订单？'), async function () {
      const cartItems = Object.entries(state.cart).filter(([id, q]) => q > 0).map(([id, q]) => {
        const m = state.menu.find(x => x.id === +id);
        return { id: m.id, name: m.name, price: m.price, quantity: q, emoji: m.emoji, itemStatus: 'pending', show_dual: 0, secondary_currency_code: '', unit: m.unit || t('unit', null, '份') };
      });
      const lockedItems = state.lockedItems.map(i => ({ id: i.id, name: i.name, price: i.price, quantity: i.quantity, emoji: i.emoji, itemStatus: 'done', show_dual: 0, secondary_currency_code: '', unit: i.unit || t('unit', null, '份') }));
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
    } finally { _submittingWaiterOrder = false; }
  };

  async function setLanguage(lang) {
      waiterLang = lang;
      // 走 core.js 统一逻辑：优先用内置 LANGUAGES(zh)，否则从 /api/i18n/:lang 加载
      await SLF.i18n.setLang(lang);
      SLF.store.rawSet('waiterLang', lang);
      SLF.store.rawSet('lang', lang);
      if (state.token) {
          applyWaiterLanguage();
          if (state.menu) renderDishes();
          const settleBtn = document.getElementById('settleBtn');
          if (settleBtn) settleBtn.textContent = t('settleOrder', null, '结算');
      }
  }

  document.getElementById('waiterLang').addEventListener('change', async function () {
    await setLanguage(this.value);
  });

  const savedLang = SLF.store.rawGet('waiterLang') || 'zh';
  waiterLang = savedLang;

  // 语言切换时自动翻译所有 data-i18n 元素
if (SLF.i18n && typeof SLF.i18n.onChange === 'function') {
  SLF.i18n.onChange(function() {
    if (SLF.ui && SLF.ui.applyI18n) SLF.ui.applyI18n();
    if (typeof applyWaiterLanguage === 'function') applyWaiterLanguage();
  });
}

function initWaiterPage() {
    try {
      // ===== 桌台搜索 + 过滤事件绑定 =====
      const searchInput = document.getElementById('tableSearchInput');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          state.tableSearchQuery = e.target.value;
          renderTables();
        });
      }
      document.querySelectorAll('.filter-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          state.tableFilter = btn.dataset.filter;
          renderTables();
        });
      });

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
    waiterSocket.on('order:urge', () => {
      if (typeof pollCalls === 'function') pollCalls();
    });
    waiterSocket.on('table:moved', () => {
      clearTimeout(transferDebounce);
      transferDebounce = setTimeout(() => { if (typeof load === 'function') load(); }, 300);
    });

    // 首次 connect 不 load（init 已 load），只有断线重连才补偿刷新
    let socketEverConnected = false;
    waiterSocket.on('connect', () => {
      SLF.log.debug('[waiter] socket connected');
      _socketConnected = true;
      updateWaiterPollingBySocket();
      if (!socketEverConnected) {
        socketEverConnected = true;
        return;
      }
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
    try { window.handleSettleFromEditor = handleSettleFromEditor; window.doWaiterSettle = doSettleFromEditor; window.closeWaiterModal = closeModal; window.reloadWaiterData = load; } catch(err) {}
    try { window.closeSettleConfirm = closeSettleConfirm; } catch(err) {}
    try { window.confirmSettleFromEditor = confirmSettleFromEditor; } catch(err) {}
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
    try { window.toggleOrderExpand = toggleOrderExpand; } catch(err) {}
    try { window.toggleWaiterItem = toggleWaiterItem; } catch(err) {}
    try { window.loadOrderHistory = loadOrderHistory; } catch(err) {}
})();