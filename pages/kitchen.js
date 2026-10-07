/*
 * FoodFlow · kitchen (kitchen.html) 后厨/KDS 页面逻辑
 */
(function(){
'use strict';
    const $ = s => document.querySelector(s);

    // 兜底：兼容旧 core.js
    const audio = SLF.audio || { unlock: () => {}, setEnabled: () => {}, playNewOrderChime: () => {}, playUrgeChime: () => {} };
    const utils = SLF.utils || { esc: s => String(s ?? ''), formatTime: d => new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) };

    let lang = SLF.store.rawGet('kitchenLang') || 'zh';
    SLF.i18n.init(lang);

    // t(key, params, fallback)
    let token = SLF.store.rawGet('kitchenToken') || '';
    let waiter = null;
    let pollTimer = null;
    let _socketConnected = false;  // Socket 状态：连接时暂停轮询
    const _newTicketIds = new Set();      // 需要播放"新订单"动画的订单 id
    const _updatedTicketIds = new Set();  // 需要播放"更新"动画的订单 id
    let clockTimer = null;
    let knownOrderIds = null;
    let kitchenAutoHideMinutes = 10;
    let hiddenOrderIds = new Set(JSON.parse(SLF.store.rawGet('kitchenHiddenOrders') || '[]'));
    const allDoneSince = {};

    // 修复：显式声明 lastOrders（严格模式下必须有）
    let lastOrders = [];

    // 修复：loadSoundSetting 只加载一次（用 flag 防止重复请求）
    let soundSettingLoaded = false;
    async function loadSoundSetting() {
      if (soundSettingLoaded) return;
      soundSettingLoaded = true;
      try {
        const data = await SLF.api.get('/public/config');
        if (typeof data.newOrderSoundEnabled === 'boolean') audio.setEnabled(data.newOrderSoundEnabled);
        if (typeof data.kitchen_auto_hide_minutes === 'number') kitchenAutoHideMinutes = data.kitchen_auto_hide_minutes;
      } catch (e) {
        // 失败时允许重试
        soundSettingLoaded = false;
      }
    }

    // 修复：使用 sessionStorage 保存"已播报过新订单的 ID"，防止刷新重复播报
    const SEEN_ORDERS_KEY = 'kitchen_seen_orders';
    let seenOrderIds = new Set();
    try {
      const saved = JSON.parse(sessionStorage.getItem(SEEN_ORDERS_KEY) || '[]');
      if (Array.isArray(saved)) seenOrderIds = new Set(saved);
    } catch (e) {}

    function saveSeenOrders() {
      try {
        // 只保留最近 200 个，避免 sessionStorage 无限增长
        const arr = [...seenOrderIds].slice(-200);
        sessionStorage.setItem(SEEN_ORDERS_KEY, JSON.stringify(arr));
      } catch (e) {}
    }

    function detectNewOrders(orders) {
      const pendingIds = new Set((orders || []).filter(o => o.status === 'pending').map(o => o.id));
      if (knownOrderIds !== null) {
        const newOrders = [];
        for (const o of (orders || [])) {
          if (o.status === 'pending' && !knownOrderIds.has(o.id) && !seenOrderIds.has(o.id)) {
            newOrders.push(o);
          }
        }
        if (newOrders.length > 0) {
          audio.playNewOrderChime();
          const tableNames = newOrders.map(o => o.table_name || o.table || '-').join('、');
          SLF.ui.toast('🔔 ' + t('newOrderArrived', null, '新订单来了') + '：' + tableNames, 'success', 4000);
          for (const o of newOrders) seenOrderIds.add(o.id);
          saveSeenOrders();
        }
      }
      knownOrderIds = pendingIds;
    }


    const api = (path, opt) => SLF.api.page(path, opt);

  function applyDataI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const translated = t(key, null, el.textContent || '');
      if (translated && translated !== key) el.textContent = translated;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (!key) return;
      const translated = t(key, null, el.placeholder || '');
      if (translated && translated !== key) el.placeholder = translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (!key) return;
      const translated = t(key, null, el.title || '');
      if (translated && translated !== key) el.title = translated;
    });
  }

    function applyLoginLanguage() {
      const el = (id) => document.getElementById(id);
      const set = (id, txt) => { const e = el(id); if (e) e.textContent = txt; };
      set('loginTitle', t('kitchenLogin', null, '后厨登录'));
      set('loginDesc', t('kitchenLoginDesc', null, '请使用服务员账号登录后厨显示屏'));
      const u = el('username'); if (u) u.placeholder = t('username', null, '账号');
      const p = el('password'); if (p) p.placeholder = t('password', null, '密码');
      set('loginBtn', t('login', null, '登录'));
      const ls = el('langSelect'); if (ls) ls.value = lang;
      applyDataI18n();
    }

    function applyMainLanguage() {
      const el = (id) => document.getElementById(id);
      const set = (id, txt) => { const e = el(id); if (e) e.textContent = txt; };
      set('pageTitle', t('kitchenDisplay', null, '后厨订单显示'));
      set('updatedLabel', t('updatedAt', null, '更新于'));
      set('fullscreenLabel', document.fullscreenElement ? t('exitFullscreen', null, '退出全屏') : t('fullscreen', null, '全屏'));
      set('logoutLabel', t('logout', null, '退出登录'));
      const lsm = el('langSelectMain'); if (lsm) lsm.value = lang;
      set('urgeModalTitle', t('urgeNotifications', null, '催单通知'));
      applyDataI18n();
    }

    async function setLang(next) {
      lang = next;
      // 走 core.js 统一逻辑：优先用内置 LANGUAGES(zh)，否则从 /api/i18n/:lang 加载
      await SLF.i18n.setLang(next);
      SLF.store.rawSet('kitchenLang', lang);
      SLF.store.rawSet('lang', lang);
      applyLoginLanguage();
      applyMainLanguage();
      renderTickets(lastOrders);
    }
    $('#langSelect').addEventListener('change', e => setLang(e.target.value));
    $('#langSelectMain').addEventListener('change', e => setLang(e.target.value));

    function timeAgoLabel(createdAt) {
      const mins = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
      if (mins < 1) return { text: t('justNow', null, '刚刚'), level: 'ok' };
      const text = `${mins} ${t('minutesAgo', null, '分钟前')}`;
      if (mins >= 20) return { text, level: 'danger' };
      if (mins >= 10) return { text, level: 'urgent' };
      if (mins >= 5) return { text, level: 'warn' };
      return { text, level: 'ok' };
    }

    function renderTickets(orders) {
      lastOrders = orders || [];
      const grid = $('#ticketGrid');
      const now = Date.now();

      // 修复：o.items 空值保护
      const pending = lastOrders
        .filter(o => o.status === 'pending')
        .filter(o => !hiddenOrderIds.has(o.id))
        .filter(o => {
          const items = Array.isArray(o.items) ? o.items : [];
          const allDone = SLF.orderStatus.allItemsDone(o);
          if (allDone) {
            if (!allDoneSince[o.id]) allDoneSince[o.id] = now;
            if (kitchenAutoHideMinutes > 0 && now - allDoneSince[o.id] > kitchenAutoHideMinutes * 60 * 1000) return false;
          } else {
            delete allDoneSince[o.id];
          }
          return true;
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      $('#countBadge').textContent = pending.length;

      if (pending.length === 0) {
        grid.innerHTML = `<div class="empty-state" id="emptyState">${t('noPendingOrders', null, '暂无待处理订单')}</div>`;
        return;
      }

      grid.innerHTML = pending.map(o => {
        const time = timeAgoLabel(o.createdAt);
        const items = Array.isArray(o.items) ? o.items : [];
        const allDone = SLF.orderStatus.allItemsDone(o);
        const ticketClass = allDone ? 'ready' : (time.level === 'danger' ? 'danger' : (time.level === 'urgent' ? 'urgent' : (time.level === 'warn' ? 'warn' : '')));
        const timeClass = time.level === 'danger' ? 'danger' : (time.level === 'urgent' ? 'urgent' : (time.level === 'warn' ? 'warn' : ''));

        const itemsHtml = items.map((item, idx) => {
          const isDone = item.itemStatus === 'done';
          const canMark = waiter && waiter.can_mark_item;
          let action = '';
          if (isDone) {
            action = `<span class="done-badge">✓ ${t('itemDone', null, '已完成')}</span>`;
          } else if (canMark) {
            action = `<button class="mark-btn" onclick="markItemDone(${o.id},${idx})">${t('markDone', null, '完成')}</button>`;
          }
          return `
            <div class="item-row ${isDone ? 'done' : ''}">
              <span class="qty">×${item.quantity}</span>${item.returnedQty > 0 ? `<span style="color:#e74c3c;font-size:12px;"> (${t('returned', null, '已退')} ${item.returnedQty})</span>` : ''}
              <span class="emoji">${utils.esc(item.emoji || '🍽️')}</span>
              <span class="name">${utils.esc(item.name)}</span>
              <span class="unit">${utils.esc(item.unit || '')}</span>
              ${action}
            </div>`;
        }).join('');

        const noteHtml = o.note ? `<div class="ticket-note"><strong>${t('orderNoteDisplay', null, '备注')}：</strong>${utils.esc(o.note)}</div>` : '';
        const readyTag = allDone ? `<button class="ticket-serve-btn" onclick="serveOrder(${o.id})">✅ ${t('servedDone', null, '出餐完成')}</button>` : '';

        const extraClass = _newTicketIds.has(o.id) ? ' new-ticket' : (_updatedTicketIds.has(o.id) ? ' updated-ticket' : '');
        return `
          <div class="ticket ${ticketClass}${extraClass}" data-order-id="${o.id}">
            <div class="ticket-head">
              <span class="table-name">🪑 ${utils.esc(o.table || '-')}</span>
              <span class="order-id ${ticketClass}">${utils.esc(o.order_no || ("#"+o.id))}</span>
            </div>
            <div class="ticket-time ${timeClass}">🕒 ${time.text}</div>
            ${noteHtml}
            <div class="ticket-items">${itemsHtml}</div>
            ${readyTag}
          </div>`;
      }).join('');

      // 动画播完自动清理标记（下次刷新不再加类）
      if (_newTicketIds.size > 0) {
        setTimeout(() => {
          _newTicketIds.forEach(id => _newTicketIds.delete(id));
        }, 2000);
      }
      if (_updatedTicketIds.size > 0) {
        setTimeout(() => {
          _updatedTicketIds.forEach(id => _updatedTicketIds.delete(id));
        }, 1000);
      }
    }

    window.serveOrder = async function(orderId) {
      // ===== 1. 先打印出餐单 =====
      try {
        SLF.ui.toast('🖨 ' + (t('printingKitchenTicket') || '正在打印出餐单...'));
        const result = await api('/orders/' + orderId + '/print-kitchen', { method: 'POST' });
        if (result.printed) {
          SLF.ui.toast('✅ ' + (t('orderPrinted', null, '出餐单已打印')), 'success');
        } else if (result.error) {
          SLF.ui.toast('⚠️ ' + (t('printFailed', null, '打印失败')) + ': ' + result.error, 'error', 3000);
        } else if (result.printData) {
          SLF.ui.toast('🖨 ' + (t('noPrinterHint', null, '未配置网络打印机')), '', 2500);
        }
      } catch (e) {
        console.error('打印出餐单失败:', e);
        SLF.ui.toast('⚠️ ' + (t('printFailed', null, '打印失败')) + '，继续出餐', 'error', 3000);
      }

      // ===== 2. 隐藏卡片（无论打印成功与否）=====
      hiddenOrderIds.add(orderId);
      try { SLF.store.rawSet('kitchenHiddenOrders', JSON.stringify([...hiddenOrderIds])); } catch(e) {}
      renderTickets(lastOrders);
    };

    let isMarking = false;
    window.markItemDone = async function(orderId, index) {
      if (isMarking) return;
      isMarking = true;
      try {
        await api(`/orders/${orderId}/items/${index}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemStatus: 'done' })
        });
        await loadOrders();
      } catch (e) {
        SLF.ui.toast('❌ ' + (e.message || t('networkError', null, '网络错误')), 'error');
      } finally {
        isMarking = false;
      }
    };

    async function loadOrders() {
      try {
        const data = await api('/waiter/overview');
        waiter = data.waiter;
        const storeNameEl = document.getElementById('kitchenStoreName');
        if (storeNameEl && data.storeName) {
          storeNameEl.textContent = '🏪 ' + data.storeName;
          storeNameEl.style.display = 'inline-block';
        }
        detectNewOrders(data.orders || []);
        renderTickets(data.orders || []);
        $('#statusDot').classList.remove('off');
        $('#updatedTime').textContent = utils.formatTime(new Date());
      } catch (e) {
        $('#statusDot').classList.add('off');
        if (/请先登录|无操作权限|401|登录已过期/.test(e.message || '')) {
          // 清除 token，回到本页自带的登录界面（不跳 /login）
          SLF.store.rawRemove('kitchenToken');
          SLF.store.rawRemove('waiterToken');
          token = '';
          waiter = null;
          showLoginScreen();
        } else {
          SLF.ui.toast('❌ ' + (e.message || t('networkError', null, '网络错误')), 'error');
        }
      }
    }

    // ----- 催单实时通知 -----
    let knownUrgeIds = new Set();
    let urgePollTimer = null;
    let pendingUrges = [];
    async function pollUrges() {
      if (document.hidden) return;
      try {
        const calls = await SLF.api.get('/waiter-calls', { headers: { 'X-Waiter-Token': token } });
        pendingUrges = (calls || []).filter(c => c.type === 'urge');
        const btn = document.getElementById('urgeNotificationBtn');
        const count = document.getElementById('urgeNotificationCount');
        if (pendingUrges.length > 0) {
          btn.style.display = 'inline-flex';
          count.textContent = pendingUrges.length;
          let hasNew = false;
          for (const c of pendingUrges) { if (!knownUrgeIds.has(c.id)) { hasNew = true; break; } }
          if (hasNew) {
            audio.playUrgeChime();
            const newUrge = pendingUrges.find(c => !knownUrgeIds.has(c.id));
            if (newUrge) SLF.ui.toast('⚡ ' + newUrge.table_name + ' ' + t('urgeOrder', null, '催单'));
          }
          knownUrgeIds = new Set(pendingUrges.map(c => c.id));
        } else {
          btn.style.display = 'none';
          knownUrgeIds.clear();
        }
      } catch (e) { /* 静默失败 */ }
    }
    function startUrgePolling() {
      stopUrgePolling();
      urgePollTimer = setInterval(pollUrges, 5000);
      pollUrges();
    }
    function stopUrgePolling() {
      if (urgePollTimer) clearInterval(urgePollTimer);
      urgePollTimer = null;
    }
    function showUrgeNotifications() {
      if (pendingUrges.length === 0) { SLF.ui.toast(t('noUrges', null, '暂无催单')); return; }
      $('#urgeModalTitle').textContent = t('urgeOrder', null, '催单') + ' (' + pendingUrges.length + ')';
      const list = pendingUrges.map(c => `
        <div class="urge-item">
          <div class="urge-item-info">
            <div class="urge-item-table">⚡ ${utils.esc(c.table_name)} ${t('urgeOrder', null, '催单')}</div>
            <div class="urge-item-msg">${utils.esc(c.message || '')}</div>
          </div>
          <button class="urge-item-btn" onclick="handleUrge('${c.id}')">${t('handled', null, '已处理')}</button>
        </div>
      `).join('');
      $('#urgeList').innerHTML = list;
      $('#urgeModal').classList.add('open');
    }
    function hideUrgeModal(){ $('#urgeModal').classList.remove('open'); }
    window.hideUrgeModal = hideUrgeModal;
    $('#urgeModal').onclick = function(e){ if (e.target === this) hideUrgeModal(); };
    window.handleUrge = async function(id) {
      try {
        await SLF.api.put('/waiter-calls/' + id + '/handle', null, { headers: { 'X-Waiter-Token': token } });
        hideUrgeModal();
        SLF.ui.toast(t('handled', null, '已处理'), 'success');
        pollUrges();
      } catch (e) { SLF.ui.toast(t('handleFailed', null, '处理失败') + ': ' + e.message, 'error'); }
    };

    function startPolling() {
      stopPolling();
      knownOrderIds = null;
      loadSoundSetting();
      loadOrders();
      // 只有 socket 未连接时才启动业务轮询
      if (!_socketConnected) {
        pollTimer = setInterval(() => {
          if (_socketConnected) return;  // socket 已恢复，跳过
          loadOrders();
        }, 30000);
      }
      clockTimer = setInterval(() => { renderTickets(lastOrders); }, 30000);
      startUrgePolling();
    }

    // Socket 连接状态变化时，动态启停业务轮询
    function updatePollingBySocket() {
      if (_socketConnected && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        SLF.log.debug('[kitchen] socket connected, paused polling');
      } else if (!_socketConnected && !pollTimer) {
        pollTimer = setInterval(() => {
          if (_socketConnected) return;
          loadOrders();
        }, 30000);
        SLF.log.debug('[kitchen] socket disconnected, resumed polling');
      }
    }
    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      if (clockTimer) clearInterval(clockTimer);
      pollTimer = null; clockTimer = null;
      stopUrgePolling();
    }

    function showKitchenApp() {
      $('#loginWrap').classList.add('hide');
      $('#kitchenApp').classList.add('show');
      applyMainLanguage();
      startPolling();
    }

    function showLoginScreen() {
      $('#kitchenApp').classList.remove('show');
      $('#loginWrap').classList.remove('hide');
      applyLoginLanguage();
      stopPolling();
    }

    async function doLogin() {
      audio.unlock();
      const username = $('#username').value.trim();
      const password = $('#password').value.trim();
      if (!username || !password) { $('#loginError').textContent = t('pleaseLogin', null, '请输入账号和密码'); return; }
      try {
        const data = await SLF.api.post('/waiter/login', { username, password });
        token = data.token;
        waiter = data.waiter;
        SLF.store.rawSet('kitchenToken', token);
        $('#loginError').textContent = '';
        showKitchenApp();
      } catch (e) {
        $('#loginError').textContent = e.message || t('loginError', null, '登录失败');
      }
    }
    $('#loginBtn').addEventListener('click', doLogin);
    $('#password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    $('#username').addEventListener('keydown', e => { if (e.key === 'Enter') $('#password').focus(); });

    let confirmCallback = null;
    function showConfirm(message, callback, title, icon) {
      $('#confirmTitle').textContent = title || t('confirmTitle', null, '确认操作');
      $('#confirmMessage').textContent = message;
      $('.confirm-icon').textContent = icon || '⚠️';
      confirmCallback = callback;
      $('#confirmModal').classList.add('open');
      $('#confirmCancelBtn').textContent = t('cancel', null, '取消');
      $('#confirmOkBtn').textContent = t('confirm', null, '确定');
    }
    function hideConfirm(){ $('#confirmModal').classList.remove('open'); confirmCallback = null; }
    $('#confirmCancelBtn').onclick = hideConfirm;
    $('#confirmOkBtn').onclick = function(){ if (confirmCallback) confirmCallback(); hideConfirm(); };
    $('#confirmModal').onclick = function(e){ if (e.target === this) hideConfirm(); };

    function logout(confirmFirst = true) {
      if (confirmFirst) { showConfirm(t('confirmLogout', null, '确认退出登录？'), function(){ logout(false); }); return; }
      token = '';
      waiter = null;
      SLF.store.rawRemove('kitchenToken');
      showLoginScreen();
    }
    $('#logoutBtn').addEventListener('click', () => logout(true));

    // 空闲超时（统一 SLF.idle）
    let kitchenIdleTimeoutMin = 120;
    SLF.idle.start({ timeoutMin: kitchenIdleTimeoutMin, onTimeout: function(){ logout(false); } });
    SLF.api.get('/public/global-config').then(cfg => {
      if (cfg.kitchen_idle_timeout) SLF.idle.update(cfg.kitchen_idle_timeout, function(){ logout(false); });
    }).catch(() => {});

    $('#fullscreenBtn').addEventListener('click', () => {
      audio.unlock();
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const el = document.getElementById('fullscreenLabel');
      if (el) el.textContent = document.fullscreenElement ? t('exitFullscreen', null, '退出全屏') : t('fullscreen', null, '全屏');
    });

    // 音频解锁
    ['click', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
      document.addEventListener(evt, () => audio.unlock(), { passive: true });
    });

    // 初始化
    applyLoginLanguage();
    applyMainLanguage();
    if (token) {
      showKitchenApp();
    } else {
      showLoginScreen();
    }

    // Socket（传 kitchenToken + 防抖）
    if (typeof io === 'function') {
      const socket = io({
        query: {
          storeId: SLF.store.rawGet('waiterStoreId') || SLF.store.rawGet('storeId') || 1,
          token: SLF.store.rawGet('kitchenToken') || ''
        }
      });

      // ============ 优化：本地增量更新，避免全量拉取 ============

      // 检查订单是否属于当前 store
      function belongsToStore(o) {
        const sid = SLF.store.rawGet('waiterStoreId') || SLF.store.rawGet('storeId') || '1';
        return !o || !o.store_id || String(o.store_id) === String(sid);
      }

      // 新订单：直接插入卡片（无需拉全量）
      socket.on('order:new', (order) => {
        if (!order || !belongsToStore(order)) return;
        if (order.status !== 'pending') return;
        // 若已存在（重复推送），先移除旧的
        lastOrders = lastOrders.filter(o => o.id !== order.id);
        lastOrders.unshift(order);
        // 触发新订单提醒
        if (knownOrderIds !== null && !knownOrderIds.has(order.id)) {
          audio.playNewOrderChime();
          SLF.ui.toast('🔔 ' + t('newOrderArrived', null, '新订单来了') + '：' + (order.table || '-'), 'success', 4000);
          _newTicketIds.add(order.id);  // 标记动画
        }
        renderTickets(lastOrders);
      });

      // 菜品更新：替换那一条订单（无需拉全量）
      socket.on('item:updated', (payload) => {
        if (!payload || !payload.order) return;
        const updated = payload.order;
        if (!belongsToStore(updated)) return;
        let found = false;
        lastOrders = lastOrders.map(o => {
          if (o.id === updated.id) { found = true; return updated; }
          return o;
        });
        if (!found) lastOrders.unshift(updated);
        if (found) _updatedTicketIds.add(updated.id);  // 标记动画
        renderTickets(lastOrders);
      });

      // 订单结算：从列表移除（无需拉全量）
      socket.on('order:settled', (payload) => {
        const id = payload && payload.orderId;
        if (!id) return;
        lastOrders = lastOrders.filter(o => o.id !== id);
        renderTickets(lastOrders);
      });

      // 转移订单：涉及状态重组，仍拉全量
      let transferDebounce = null;
      socket.on('order:transfer', () => {
        clearTimeout(transferDebounce);
        transferDebounce = setTimeout(() => loadOrders(), 300);
      });
      socket.on('table:moved', () => {
        clearTimeout(transferDebounce);
        transferDebounce = setTimeout(() => loadOrders(), 300);
      });

      // 催单：提示 + 拉全量（催单只更新 waiter_calls，不影响 order）
      socket.on('order:urge', (payload) => {
        // 在催单通知里处理（pollUrges 会拉取）
      });

      // 连接状态：断开时开启轮询，重连时刷新一次
      // 首次 connect 不 load（init 已 load），只有断线重连才补偿刷新
      let socketEverConnected = false;
      socket.on('connect', () => {
        SLF.log.debug('[kitchen] socket connected');
        _socketConnected = true;
        updatePollingBySocket();
        if (!socketEverConnected) {
          socketEverConnected = true;
          return;
        }
        // 断线重连 → 补偿一次全量刷新
        loadOrders();
      });
      socket.on('disconnect', () => {
        console.warn('[kitchen] socket disconnected, will rely on polling');
        _socketConnected = false;
        updatePollingBySocket();
      });
      socket.on('connect_error', (err) => {
        console.warn('[kitchen] socket connect_error:', err.message);
      });
      window.addEventListener('beforeunload', () => {
        try { socket.disconnect(); } catch (_) {}
      });
    }
    try { window.handleUrge = handleUrge; } catch(err) {}
    try { window.hideUrgeModal = hideUrgeModal; } catch(err) {}
    try { window.markItemDone = markItemDone; } catch(err) {}
    try { window.showUrgeNotifications = showUrgeNotifications; } catch(err) {}
})();
