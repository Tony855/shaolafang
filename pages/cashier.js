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
let refundOrderId = null;

// KHQR 支付弹窗状态
let khqrState = { orderId: null, expiresAt: 0, timer: null, pollTimer: null, providerId: null, bankName: '' };
let khqrProviders = [];
let enabledPaymentMethods = { cash: true, wechat: false, alipay: false, card: false, khqr: false };
  const awaitingOrders = new Map();  // 收银员待确认订单（服务员已标记，等待确认到账）

  SLF.i18n.init(currentLang);

  /* ===== 工具 ===== */
  const esc = SLF.utils.esc;
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

  // 金额 HTML：主货币红色，副货币灰色
  const moneyHtml = SLF.money.formatHtml;

  /* ===== 加载商户启用的支付方式 ===== */
  async function loadPaymentMethods() {
    try {
      const data = await api('/cashier/payment-methods');
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
      const el = document.querySelector(map[k]);
      if (el) el.style.display = enabledPaymentMethods[k] ? '' : 'none';
    });
    // KHQR 动态按钮：按每个 bank 独立配置显示
    document.querySelectorAll('.payment-methods [data-provider-id]').forEach(el => {
      const key = el.dataset.bankKey;
      el.style.display = enabledPaymentMethods[key] ? '' : 'none';
    });
  }

  /* ===== KHQR providers 加载与渲染 ===== */
  async function loadKhqrProviders() {
    try {
      const data = await api('/cashier/khqr/providers');
      khqrProviders = (data.providers || []).filter(p => p.enabled !== false);  // 所有启用的都显示
      SLF.log.debug('[khqr] providers loaded:', khqrProviders.map(p => p.bank + '/' + p.currency));
      renderProviderButtons();
    } catch (e) {
      console.warn('[khqr] load providers failed:', e.message);
      khqrProviders = [];
    }
  }

  // bank 名 → 图标文件名（大小写/别名映射）
  const BANK_ICON_MAP = {
    'ABA': 'aba',
    'ACLEDA': 'acleda',
    'Bakong': 'KHQR',
    'Wing': 'Wing',
    'Chip Mong': 'ChipMong',
  };
  const ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

  function renderProviderButtons() {
    const container = document.querySelector('.payment-methods');
    if (!container) return;

    container.querySelectorAll('[data-provider-id]').forEach(b => b.remove());
    const abaBtn = container.querySelector('[data-method="aba"]');
    if (abaBtn) abaBtn.style.display = 'none';

    if (!khqrProviders.length) return;
    // 按钮永远创建，显隐由 applyPaymentMethodsVisibility 按 bankKey 控制

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
      const labelHtml = '<span class="pm-label" style="font-size:12px;font-weight:700;">' + esc(label) + '</span>';
      btn.innerHTML = '<span class="pm-icon" style="font-size:22px;">📱</span>' + labelHtml;

      let extIdx = 0;
      function tryNext() {
        if (extIdx >= ICON_EXTS.length) {
          SLF.log.debug('[khqr] 图标不存在:', iconFile);
          return;
        }
        const ext = ICON_EXTS[extIdx++];
        const url = '/assets/vendor/payment-icons/' + iconFile + '.' + ext;
        const img = new Image();
        img.onload = function() {
          btn.innerHTML = '<span class="pm-icon pm-icon-aba"><img src="' + url + '" alt="' + esc(label) + '"></span>' + labelHtml;
        };
        img.onerror = tryNext;
        img.src = url;
      }
      tryNext();

      btn.addEventListener('click', () => selectPayMethod('provider', p.id));
      container.appendChild(btn);
    });
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
    // 页面标题跟随语言
    const _pt = document.getElementById('pageTitle');
    if (_pt) _pt.textContent = 'FoodFlow · ' + (t('cashierDesk') || 'Cashier');
    // 顶部品牌标题跟随语言
    const _bt = document.getElementById('posBrandTitle');
    if (_bt) _bt.textContent = 'FoodFlow · ' + (t('cashierDesk') || 'Cashier');
    document.getElementById('tabPending').innerHTML = t('pendingOrders') + ' <span class="pos-tab-count" id="pendingCount">0</span>';
    document.getElementById('tabSettled').innerHTML = t('settledOrders') + ' <span class="pos-tab-count" id="settledCount">0</span>';
    document.getElementById('tabRefunded').innerHTML = (t('refundOrder') || '退款订单') + ' <span class="pos-tab-count" id="refundedCount">0</span>';
    document.getElementById('todayLabel').textContent = t('todayCount');
    document.getElementById('revenueLabel').textContent = t('todayRevenue');
    document.getElementById('logoutBtn').textContent = t('logout');
    document.getElementById('searchInput').placeholder = '🔍 ' + t('searchPlaceholder');
    document.getElementById('detailEmpty').querySelector('p').textContent = t('selectOrder') || '← 从左侧选择一个订单';
    document.getElementById('paymentTitle').textContent = t('settleOrder') || '收款';
    // 兜底：把所有带 data-i18n 的静态元素翻译一遍
    if (SLF.ui && SLF.ui.applyI18n) SLF.ui.applyI18n();
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
  const api = (path, opt) => SLF.api.page(path, opt);

  function renderAwaitingBanner() {
    const el = document.getElementById('awaitingBanner');
    const list = document.getElementById('awaitingBannerList');
    const cnt = document.getElementById('awaitingBannerCount');
    if (!el || !list) return;
    if (awaitingOrders.size === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (cnt) cnt.textContent = awaitingOrders.size;
    list.innerHTML = Array.from(awaitingOrders.values()).map(o => `
      <div class="awaiting-item">
        <div class="awaiting-item-info">
          <strong>🪑 ${esc(o.table_name || '-')}</strong>
          <span>${esc(o.order_no || ('#' + o.id))}</span>
        </div>
        <div class="awaiting-item-actions">
          <button onclick="confirmAwaiting(${o.id})">${t('confirmReceived') || '确认收款'}</button>
          <button onclick="dismissAwaiting(${o.id})">${t('close') || '关闭'}</button>
        </div>
      </div>
    `).join('');
  }

  function addAwaitingOrder(order) {
    if (!order || !order.id) return;
    awaitingOrders.set(order.id, order);
    renderAwaitingBanner();
  }

  function dismissAwaiting(orderId) {
    awaitingOrders.delete(orderId);
    renderAwaitingBanner();
  }
  window.dismissAwaiting = dismissAwaiting;

  async function loadOrders() {
    try {
      const data = await api('/cashier/orders');
      orders = data.orders || [];
      // 只把服务器返回的待确认订单**加进**横幅，不清理
      // （避免 awaiting_confirm 字段偶发延迟/缺失导致横幅刚显示就消失）
      orders.forEach(o => {
        if (o.awaiting_confirm && o.status === 'pending') {
          awaitingOrders.set(o.id, o);
        }
      });
      renderAwaitingBanner();
      renderOrders();
      renderDetail();
      updateBottomStats();
    } catch (e) {
      if (e.message.includes('请先登录') || e.message.includes('登录已过期')) {
        SLF.store.rawRemove('cashierToken');
      } else {
        SLF.ui.toast('❌ ' + e.message);
      }
    }
  }

  /* ===== 左侧列表渲染 ===== */
  function renderOrders() {
    const container = document.getElementById('orderList');
    let filtered;
    if (currentTab === 'refunded') {
      filtered = orders.filter(o => o.status === 'refunded');
    } else if (currentTab === 'settled') {
      filtered = orders.filter(o => o.status === 'done' || o.status === 'canceled');
    } else {
      filtered = orders.filter(o => o.status === 'pending');
    }

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
      return currentTab === 'pending' ? ta - tb : tb - ta;
    });

    // 更新计数
    const pendingCountEl = document.getElementById('pendingCount');
    const settledCountEl = document.getElementById('settledCount');
    const refundedCountEl = document.getElementById('refundedCount');
    if (pendingCountEl) pendingCountEl.textContent = orders.filter(o => o.status === 'pending').length;
    if (settledCountEl) settledCountEl.textContent = orders.filter(o => o.status === 'done' || o.status === 'canceled').length;
    if (refundedCountEl) refundedCountEl.textContent = orders.filter(o => o.status === 'refunded').length;

    if (!filtered.length) {
      container.innerHTML = '<div style="text-align:center;padding:40px 20px;color:#9ca3af;font-size:14px;">' + (searchKeyword ? t('noSearchResult') : t('noOrders')) + '</div>';
      return;
    }

    // 状态徽章映射（4 色）
    const _statusMap = {
      pending:  { text: t('pendingSettlement') || t('pending') || '未结算', cls: 'pending',  icon: '⏳' },
      done:     { text: t('settled')          || '已结算',                  cls: 'done',     icon: '✅' },
      refunded: { text: t('refunded')         || '已退款',                  cls: 'refunded', icon: '💸' },
      canceled: { text: t('canceled')         || '已取消',                  cls: 'canceled', icon: '❌' }
    };

    container.innerHTML = filtered.map(order => {
      const total = moneyHtml(Number(order.total) || 0);
      const itemCount = (order.items || []).length;

      // 支付方式标签（仅已结算订单显示）
      // 支付方式标签（logo 资源路径映射）
      const _ICON_FILE_MAP = {
        'aba': 'aba', 'acleda': 'acleda', 'wing': 'Wing',
        'bakong': 'KHQR', 'chipmong': 'ChipMong', 'khqr': 'KHQR',
      };
      const _ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
      let _payLabel = '';
      if (order.status === 'done') {
        const _pm = String(order.pay_method || '').toLowerCase();
        const _pmTrim = _pm.replace(/\s+/g, '');
        if (_pm === 'cash')               _payLabel = '💵 ' + (t('cashPay') || '现金');
        else if (_pm === 'wechat')        _payLabel = '💚 ' + (t('wechatPay') || '微信');
        else if (_pm === 'alipay')        _payLabel = '💙 ' + (t('alipayPay') || '支付宝');
        else if (_pm === 'card')          _payLabel = '💳 ' + (t('cardPay') || '刷卡');
        else if (_ICON_FILE_MAP[_pmTrim]) {
          const _bankLabel = _pmTrim === 'bakong' ? 'Bakong'
                           : _pmTrim === 'chipmong' ? 'Chip Mong'
                           : _pmTrim.toUpperCase();
          // 尝试多个扩展名，第一个能加载的用
          const _iconBase = '/assets/vendor/payment-icons/' + _ICON_FILE_MAP[_pmTrim];
          _payLabel = '<img src="' + _iconBase + '.png" alt="' + esc(_bankLabel) + '" '
                    + 'style="height:14px;width:auto;max-width:36px;vertical-align:middle;margin-right:4px;object-fit:contain;border-radius:2px;" '
                    + 'onerror="this.style.display=\'none\'">' + esc(_bankLabel);
        }
        else if (_pmTrim === 'provider')  _payLabel = t('khqrPay') || '扫码';
        else if (_pm)                     _payLabel = esc(_pm.toUpperCase());
      }
      const isSelected = order.id === selectedOrderId;
      const sessionLabels = buildSessionLabels([order]);
      const customerLabel = sessionLabels.get(order.id) || '';

      const _st = _statusMap[order.status];
      // 待结订单按"是否可结算"细分：全做完=ready，未做完=waiting
      let _readyCls = '';
      let _readyTip = '';
      if (order.status === 'pending') {
        const _items = order.items || [];
        const _pending = _items.filter(it => it.itemStatus !== 'done').length;
        if (_pending === 0 && _items.length > 0) {
          _readyCls = ' ready-to-settle';
          _readyTip = `<span class="pos-card-ready-tip">${t('readyToSettle')}</span>`;
        } else if (_pending > 0) {
          _readyCls = ' waiting-items';
          _readyTip = `<span class="pos-card-wait-tip">${t('itemsPendingPre')}${_pending}${t('itemsPendingSuf')}</span>`;
        }
      }
      const _hidePendingBadge = (order.status === 'pending' && _readyCls === ' ready-to-settle');
      const _statusBadge = (_st && !_hidePendingBadge) ? `<span class="pos-card-status ${_st.cls}">${_st.icon} ${esc(_st.text)}</span>` : '';
      const _cardCls = (_st ? ' status-' + _st.cls : '') + _readyCls;
      const _awaitingTag = order.awaiting_confirm
        ? '<span class="pos-card-wait-tip" style="background:#fff3cd;color:#856404;"' + t('khqrAwaitConfirm') + '</span>'
        : '';
      const _hasLabel = customerLabel && customerLabel.trim();
      const _payTag = _payLabel ? `<span class="pos-tag pay-method">${_payLabel}</span>` : '';
      const _tagsHtml = (_hasLabel || _statusBadge || _readyTip || _awaitingTag || _payTag)
        ? `<div class="pos-order-card-tags">${_hasLabel ? `<span class="pos-tag ${customerLabel === t('staffOrder') ? 'staff' : 'customer'}">${esc(customerLabel)}</span>` : ''}${_awaitingTag}${_readyTip}${_payTag}${_statusBadge}</div>`
        : '';

      return `<div class="pos-order-card ${isSelected ? 'selected' : ''}${_cardCls}" onclick="selectOrder(${order.id})">
        <div class="pos-order-card-head">
          <div class="pos-order-card-table">🪑 ${esc(order.table_name || '-')}</div>
          <div class="pos-order-card-time">${formatTime(order.createdAt)}</div>
        </div>
        <div class="pos-order-card-no">${esc(order.order_no || ('#' + order.id))}</div>
        <div class="pos-order-card-meta">
          <span class="pos-order-card-items">${itemCount} ${t('dishes') || '道菜品'}</span>
          <span class="pos-order-card-amount">${total}</span>
        </div>
        ${_tagsHtml}
      </div>`;
    }).join('');
  }

  function selectOrder(id) {
    selectedOrderId = id;
    // 移动端：切换为详情视图
    document.body.classList.add('pos-detail-open');
    renderOrders();
    renderDetail();
  }

  function closeDetail() {
    selectedOrderId = null;
    // 移动端：回到列表视图
    document.body.classList.remove('pos-detail-open');
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
      const isDone = item.itemStatus === 'done';
      const statusBadge = isDone
        ? '<span class="pos-dish-status done">✅ ' + (t('done') || '已完成') + '</span>'
        : '<span class="pos-dish-status pending">⏳ ' + (t('pending') || '制作中') + '</span>';
      return `<div class="pos-detail-item ${isDone ? 'item-done' : 'item-pending'}">
        <div class="pos-detail-item-name">
          <span class="emoji">${esc(item.emoji || '🍽️')}</span>
          <span>${esc(item.name)}${returned > 0 ? ` <span style="color:#e74c3c;font-size:12px;">(${t('returned') || '退'} ${returned})</span>` : ''}</span>
          ${statusBadge}
        </div>
        <div class="pos-detail-item-qty">× ${qty}</div>
        <div class="pos-detail-item-price">${moneyHtml(lineBase)}</div>
      </div>`;
    }).join('') || '<div style="text-align:center;padding:20px;color:#9ca3af;">' + (t('noDishes') || '无菜品') + '</div>';

    // 金额
    const totalDisplay = moneyHtml(Number(order.total) || 0);
    document.getElementById('detailTotal').innerHTML = totalDisplay;
    document.getElementById('detailDue').innerHTML = totalDisplay;

    // 按钮
    const btnsEl = document.getElementById('detailButtons');
    const perms = (cashierInfo && cashierInfo.permissions) || {};
    const allowSettle = perms.can_settle !== false;
    const allowCancel = perms.can_cancel !== false;
    const allowRefund = perms.can_refund === true;
    const canSettle = allowSettle && order.status === 'pending' && SLF.orderStatus.allItemsDone(order);
    const canCancel = allowCancel && order.status === 'pending';
    const canRefund = allowRefund && ['done', 'settled', 'paid', 'completed'].includes(order.status);
    let btns = '';
    if (canSettle) {
      btns += `<button class="btn btn-pay" onclick="openPaymentModal(${order.id})">💵 ${t('settleOrder')}</button>`;
    } else if (order.status === 'pending') {
      btns += `<button class="btn btn-pay" disabled title="${t('itemsNotReady')}">💵 ${t('settleOrder') || '收款'} (${t('incompleteShort')})</button>`;
    }
    btns += `<button class="btn btn-print" onclick="printOrder(${order.id})" title="${t('print') || '打印'}">🖨</button>`;
    if (canRefund) {
      btns += `<button class="btn btn-refund" onclick="openRefundModal(${order.id})" title="${t('refund') || '退款'}">💸 ${t('refund') || '退款'}</button>`;
    }
    if (canCancel) {
      btns += `<button class="btn btn-cancel-order" onclick="cancelOrder(${order.id})" title="${t('cancelOrder') || '取消'}">✕</button>`;
    }
    btnsEl.innerHTML = btns;

    // 详情渲染完后，重新翻译这一区域的 data-i18n
    if (SLF.ui && SLF.ui.applyI18n) {
      const dv = document.getElementById('detailView');
      if (dv) SLF.ui.applyI18n(dv);
    }
  }

  function updateBottomStats() {
    const today = new Date().toISOString().split('T')[0];
    const todayOrders = orders.filter(o => (o.createdAt || '').startsWith(today));
    const revenueBase = todayOrders.filter(o => o.status === 'done').reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
    document.getElementById('todayCount').textContent = todayOrders.length;
    document.getElementById('todayRevenue').innerHTML = moneyHtml(revenueBase);
  }

  /* ===== 收款弹窗 ===== */
  async function confirmAwaiting(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    const body = { pay_method: order.pay_method || 'cash' };
    if (body.pay_method === 'cash') {
      body.cash_received = Number(order.cash_received) || 0;
      body.cash_change = Number(order.cash_change) || 0;
      if (body.cash_received < Number(order.total || 0)) {
        // Waiter requested cashier confirmation without recording a sufficient cash amount.
        // Open the normal POS payment dialog instead of trusting a zero/short cash receipt.
        return openPaymentModal(orderId);
      }
    }
    try {
      await api('/cashier/orders/' + orderId + '/settle', { method: 'PUT', body });
      SLF.ui.toast('✅ ' + (t('settleSuccess') || '收款成功'));
      // ★ 从待确认横幅里移除
      awaitingOrders.delete(orderId);
      renderAwaitingBanner();
      selectedOrderId = null;
      document.body.classList.remove('pos-detail-open');
      await loadOrders();
    } catch (e) {
      SLF.ui.toast('❌ ' + e.message);
    }
  }
  window.confirmAwaiting = confirmAwaiting;

  async function openPaymentModal(orderId) {
    // 实时拉取支付方式配置（不缓存，保证超管后台改动立即生效）
    try { await loadPaymentMethods(); } catch (e) { console.warn('[payment] 刷新支付方式失败', e); }

    const order = orders.find(o => o.id === orderId);
    if (!order) return;
    paymentOrderId = orderId;
    payMethod = 'cash';
    const amount = Number(order.total) || 0;
    document.getElementById('paymentAmount').innerHTML = moneyHtml(amount);
    document.getElementById('cashReceived').value = '';
    document.getElementById('cashChange').innerHTML = moneyHtml(0);
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

  function selectPayMethod(method, providerId) {
    payMethod = method;
    document.querySelectorAll('.payment-method').forEach(btn => {
      const isActive = btn.dataset.method === method
        && (!providerId || btn.dataset.providerId === providerId);
      btn.classList.toggle('active', isActive);
    });
    document.getElementById('cashArea').style.display = method === 'cash' ? 'block' : 'none';

    // provider（含所有 KHQR 银行）→ 打开动态码弹窗
    if (method === 'provider' && paymentOrderId) {
      openKhqrModal(paymentOrderId, providerId);
    }
  }

  /* ===== KHQR 动态收款 ===== */
  function openKhqrModal(orderId, providerId, selectedCurrency) {
    // ★ 关键：先清掉所有旧的定时器，否则每次打开都会叠加，越用越卡
    if (typeof stopKhqrTimers === 'function') stopKhqrTimers();
    selectedCurrency = String(selectedCurrency || "USD").toUpperCase();
    if (!["USD", "KHR"].includes(selectedCurrency)) selectedCurrency = "USD";
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    // 保留底下的收款弹窗，KHQR 叠在其上；点取消可回到上一级

    khqrState.orderId = orderId;
    khqrState.providerId = providerId || null;
    document.getElementById('khqrImage').src = '';
    document.getElementById('khqrMerchant').textContent = '...';
    document.getElementById('khqrOrderNo').textContent = order.order_no || ('#' + order.id);
    document.getElementById('khqrStatusBar').innerHTML = '<span>' + t('khqrGenerating') + '</span>';

    const btn = document.getElementById('khqrConfirmBtn');
    btn.disabled = true;
    btn.textContent = t('khqrGeneratingBtn');

    document.getElementById('khqrModal').classList.add('show');

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
    if (SLF.ui && SLF.ui.applyI18n) SLF.ui.applyI18n(document.getElementById('khqrModal'));

    // 请求生成
    api('/cashier/khqr/generate', { method: 'POST', body: { order_id: orderId, provider_id: providerId || undefined, currency: selectedCurrency } })
      .then(res => {
        // 优先用后端返回的 base64（<img> 无法带 token，不能直接用 URL 接口）
        if (res.qr_data_url) {
          document.getElementById('khqrImage').src = res.qr_data_url;
        } else {
          // 兜底：老接口（无 auth 时可能失败）
          const size = Math.min(560, Math.max(280, Math.floor(window.innerWidth * 0.7)));
          document.getElementById('khqrImage').src = '/api/cashier/khqr/qrimage?order_id=' + orderId + '&size=' + size + '&_t=' + Date.now();
        }
        // 金额渲染（按币种加符号 + 副币）
        (function(){
          var cur = String(res.currency || 'USD').toUpperCase();
          var sym = cur === 'KHR' ? '៛' : (cur === 'USD' ? '$' : '');
          var amt = Number(res.amount) || 0;
          var amtStr = ['KHR','VND','THB'].indexOf(cur) >= 0 ? Math.round(amt).toLocaleString('en-US') : amt.toFixed(2);

          // 换算成 USD base
          var baseUSD = amt;
          if (cur !== 'USD') {
            try {
              var curObj = SLF.money.find(cur);
              if (curObj && Number(curObj.rate)) baseUSD = amt / Number(curObj.rate);
            } catch (e) {}
          }

          // KHQR 弹窗强制显示"另一种币种"（USD 或 KHR），与店铺副币设置无关
          var secHtml = '';
          try {
            var altCode = (cur === 'KHR') ? 'USD' : 'KHR';
            var altStr = SLF.money.secondary(baseUSD, altCode);
            if (altStr) secHtml = '<span style="color:#999;font-size:13px;margin-left:6px;">(' + altStr + ')</span>';
          } catch (e) {}

          document.getElementById('khqrAmount').style.cssText =
            'display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px;width:100%;text-align:center;line-height:1.35;';
          document.getElementById('khqrAmount').innerHTML =
            '' +
            '<span style="color:#e85d3a;font-size:clamp(28px,6vw,42px);font-weight:800;">' + sym + amtStr + '</span>' +
            (secHtml ? secHtml.replace('margin-left:6px;', 'margin-left:0;') : '');
          const sw = document.getElementById('khqrCurrencySwitch');
          if (sw) sw.textContent = cur === 'USD' ? '$ USD  ⇄  ៛ KHR' : '៛ KHR  ⇄  $ USD';
        })();

        khqrState.bankName = res.provider_bank || '';
        if (window.KHQRShared) {
          KHQRShared.renderPayee('khqrMerchant', 'khqrOrderNo', res);
        }
        khqrState.expiresAt = new Date(res.expires_at).getTime();
        startKhqrCountdown();
        startKhqrPolling();
        btn.disabled = false;
        btn.textContent = t('khqrReceived');
        document.getElementById('khqrStatusBar').innerHTML =
          '<span>' + t('khqrWaitingScan') + '</span>';
      })
      .catch(e => {
        document.getElementById('khqrStatusBar').innerHTML =
          '<span style="color:#e74c3c;">❌ ' + esc(e.message || t('khqrGenerateFailed')) + '</span>';
        btn.textContent = '❌ ' + t('khqrGenerateFailed');
      });
  }

  function closeKhqrModal() {
    document.getElementById('khqrModal').classList.remove('show');
    stopKhqrTimers();
    // 取消本次支付（清掉 pay_khqr_ref）
    if (khqrState.orderId) {
      api('/cashier/khqr/cancel', { method: 'POST', body: { order_id: khqrState.orderId } }).catch(() => {});
    }
    khqrState.orderId = null;
  }

  function startKhqrCountdown() {
    stopKhqrTimers();
    const update = () => {
      const left = Math.max(0, khqrState.expiresAt - Date.now());
      const totalSec = Math.floor(left / 1000);
      const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
      const s = String(totalSec % 60).padStart(2, '0');
      const el = document.getElementById('khqrCountdown');
      if (el) {
        el.textContent = m + ':' + s;
        if (totalSec <= 60) {
          el.style.color = '#e74c3c';
          el.style.animation = 'khqr-blink 1s infinite';
        }
      }
      if (left <= 0) {
        stopKhqrTimers();
        const bar = document.getElementById('khqrStatusBar');
        if (bar) bar.innerHTML = '<span style="color:#e74c3c;">' + t('khqrExpired') + '</span>';
        const btn = document.getElementById('khqrConfirmBtn');
        if (btn) { btn.disabled = true; btn.textContent = t('khqrExpiredShort'); }
      }
    };
    update();
    khqrState.timer = setInterval(update, 1000);
  }

  function startKhqrPolling() {
    // 每 3 秒查一次订单状态
    khqrState.pollTimer = setInterval(async () => {
      if (!khqrState.orderId) return;
      try {
        const o = orders.find(x => x.id === khqrState.orderId);
        if (!o) return;
        // 直接拉最新订单
        const fresh = await api('/cashier/orders/' + khqrState.orderId);
        if (fresh && fresh.status === 'done') {
          stopKhqrTimers();
          SLF.ui.toast('✅ ' + (t('settleSuccess') || '收款成功'));
          closeKhqrModalSilent();
          await loadOrders();
        } else if (fresh && fresh.awaiting_confirm) {
          document.getElementById('khqrStatusBar').innerHTML =
            '<span style="color:#ffb020;">' + t('khqrServicePaid') + '</span>';
        }
      } catch (e) { /* 静默 */ }
    }, 5000);
  }

  function stopKhqrTimers() {
    if (khqrState.timer) { clearInterval(khqrState.timer); khqrState.timer = null; }
    if (khqrState.pollTimer) { clearInterval(khqrState.pollTimer); khqrState.pollTimer = null; }
  }

  function closeKhqrModalSilent() {
    document.getElementById('khqrModal').classList.remove('show');
    stopKhqrTimers();
    khqrState.orderId = null;
  }

  async function confirmKhqrReceived() {
    if (!khqrState.orderId) return;
    const btn = document.getElementById('khqrConfirmBtn');
    btn.disabled = true;
    btn.textContent = t('khqrConfirming');
    try {
      const res = await api('/cashier/khqr/confirm', {
        method: 'POST',
        body: { order_id: khqrState.orderId, role: 'cashier' }
      });
      SLF.ui.toast('✅ ' + (t('settleSuccess') || '已收款'));
      closeKhqrModalSilent();
      selectedOrderId = null;
      document.body.classList.remove('pos-detail-open');
      await loadOrders();
    } catch (e) {
      SLF.ui.toast('❌ ' + e.message);
      btn.disabled = false;
      btn.textContent = t('khqrReceived');
    }
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
    document.getElementById('cashChange').innerHTML = moneyHtml(change);
  }

  // ===== 退款 =====

  function refundOrder(id) {
    const order = orders.find(o => o.id === id);
    if (!order) return;
    if (order.status !== 'done') {
      SLF.ui.toast('⚠️ ' + (t('onlySettledRefund', null, '只有已结算订单才能退款')));
      return;
    }
    refundOrderId = id;
    document.getElementById('refundAmount').innerHTML = moneyHtml(Number(order.total) || 0);
    document.getElementById('refundReason').value = '';
    document.getElementById('refundNote').value = '';
    document.getElementById('refundModal').classList.add('show');
  }





  async function confirmPay() {
    if (!paymentOrderId) return;
    const order = orders.find(o => o.id === paymentOrderId);
    if (!order) return;
    const due = Number(order.total) || 0;

    if (payMethod === 'cash') {
      const received = parseFloat(document.getElementById('cashReceived').value) || 0;
      if (received < due) {
        SLF.ui.toast('❌ ' + (t('insufficientCash') || '实收金额不足'));
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
      document.body.classList.remove('pos-detail-open');
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
        document.body.classList.remove('pos-detail-open');
        await loadOrders();
      } catch (e) {
        SLF.ui.toast('❌ ' + e.message);
      }
    }, { type: 'warning', icon: '⚠️' });
  }

  
  /* ===== 退款弹窗 ===== */
  function openRefundModal(orderId) {
    const order = orders.find(o => String(o.id) === String(orderId));
    if (!order) { SLF.ui.toast('❌ ' + (t('orderNotFound') || '未找到订单')); return; }
    refundOrderId = order.id;
    const total = Number(order.total) || 0;
    document.getElementById('refundAmount').innerHTML = moneyHtml(total);
    const _inp = document.getElementById('refundInput');
    if (_inp) _inp.value = total.toFixed(2);
    document.getElementById('refundReason').value = '';
    document.getElementById('refundModal').classList.add('show');
    setTimeout(() => { const el = document.getElementById('refundInput'); if (el) el.focus(); }, 100);
  }

  function closeRefundModal() {
    document.getElementById('refundModal').classList.remove('show');
    refundOrderId = null;
  }

  async function confirmRefund() {
    if (!refundOrderId) return;
    const order = orders.find(o => String(o.id) === String(refundOrderId));
    if (!order) { SLF.ui.toast('❌ ' + (t('orderNotFound') || '未找到订单')); return; }
    const reason = document.getElementById('refundReason').value.trim();
    const total = Number(order.total) || 0;
    const _inpEl = document.getElementById('refundInput');
    const amount = _inpEl ? (parseFloat(_inpEl.value) || 0) : total;

    if (amount <= 0) { SLF.ui.toast('❌ ' + (t('refundMustBePositive') || '退款金额必须大于 0')); return; }
    if (amount > total) { SLF.ui.toast('❌ ' + (t('refundExceedsTotal') || '退款金额不能超过订单金额')); return; }

    const btn = document.getElementById('confirmRefundBtn');
    btn.disabled = true;
    try {
      await api('/cashier/orders/' + refundOrderId + '/refund', {
        method: 'PUT',
        body: { amount, reason }
      });
      SLF.ui.toast('✅ ' + (t('refundSuccess') || '退款成功'));
      closeRefundModal();
      selectedOrderId = null;
      document.body.classList.remove('pos-detail-open');
      await loadOrders();
    } catch (e) {
      SLF.ui.toast('❌ ' + e.message);
    } finally {
      btn.disabled = false;
    }
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
      document.getElementById('cashierName').textContent = cashierInfo.display_name || cashierInfo.username || t('cashier');
      try {
        const cfg = await SLF.api.get('/public/config?store_id=' + (SLF.store.rawGet('storeId') || 1));
        currencies = cfg.currencies || [];
        defaultCurrency = cfg.defaultCurrency || { symbol: '$', rate: 1, code: 'USD' };
        dualCurrency = cfg.dualCurrency || { enabled: false, currency: null };
        SLF.money.configure({ currencies, primaryCurrency: cfg.primaryCurrency || cfg.defaultCurrency, secondaryCurrency: cfg.secondaryCurrency || (cfg.dualCurrency && cfg.dualCurrency.enabled ? cfg.dualCurrency.currency : null) });
        const ri = parseInt(cfg.waiter_refresh_interval, 10);
        if (!isNaN(ri) && ri >= 3) refreshInterval = ri;
      } catch (e) { console.error('currency load failed', e); }

      // 事件绑定
      document.getElementById('searchInput').addEventListener('input', e => {
        searchKeyword = e.target.value.trim();
        renderOrders();
      });

      await loadOrders();
      await loadPaymentMethods();
      await loadKhqrProviders();
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
  document.getElementById('refundModal').addEventListener('click', function(e) {
    if (e.target === this) closeRefundModal();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (document.getElementById('refundModal') && document.getElementById('refundModal').classList.contains('show')) {
        closeRefundModal();
      } else if (document.getElementById('refundModal').classList.contains('show')) {
        closeRefundModal();
      } else if (document.getElementById('paymentModal').classList.contains('show')) {
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
        storeId: SLF.store.rawGet('cashierStoreId') || SLF.store.rawGet('storeId') || 1,
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
    cashierSocket.on('khqr:awaiting', (payload) => {
      if (!payload || !belongsToStore(payload)) return;
      // ★ 加入持久横幅（不用 toast，toast 会自动消失）
      addAwaitingOrder({
        id: payload.orderId,
        table_name: payload.table,
        order_no: payload.orderNo,
        total: payload.total,
        awaiting_confirm: 1,
        status: 'pending',
      });
      // 刷新订单列表
      loadOrders();
      // 如果当前正打开这个订单详情，自动刷新
      if (selectedOrderId === payload.orderId) {
        renderDetail();
      }
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
    cashierSocket.on('table:moved', () => { loadOrders(); });
    cashierSocket.on('order:urge', () => { loadOrders(); });
    // 首次 connect 不 load（init 已 load），只有断线重连才补偿刷新
    let socketEverConnected = false;
    cashierSocket.on('connect', () => {
      _socketConnected = true;
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      if (!socketEverConnected) {
        socketEverConnected = true;
        return;
      }
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
  window.refundOrder = refundOrder;
  window.closeRefundModal = closeRefundModal;
  window.confirmRefund = confirmRefund;
  window.openPaymentModal = openPaymentModal;
  window.closePaymentModal = closePaymentModal;
  window.selectPayMethod = selectPayMethod;
  window.setCash = setCash;
  window.onCashInput = onCashInput;
  window.confirmPay = confirmPay;
  window.printOrder = printOrder;
  window.cancelOrder = cancelOrder;
  window.openRefundModal = openRefundModal;
  window.hideConfirm = hideConfirm;
  window.executeConfirm = executeConfirm;
  window.logout = logout;
  window.goLogin = goLogin;
  window.changeLang = changeLang;
  window.openKhqrModal = openKhqrModal;
  window.closeKhqrModal = closeKhqrModal;
  window.confirmKhqrReceived = confirmKhqrReceived;

  init();
})();
