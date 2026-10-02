/*
 * pages/admin/shared.js — 共享工具函数
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, L } = ctx;

function dualAmountSuffix(base) {
  if (!ctx.dualCurrencyEnabled() || !ctx.secondaryCurrencyCode()) return '';
  const sec = SLF.money.secondary(base, ctx.secondaryCurrencyCode());
  return sec ? ` (${sec})` : '';
}

function translateLoginMessage(msg) {
  if (!msg) return '';
  if (msg.includes('商户管理员登录成功')) { const username = msg.split(':')[1] || ''; return tAdmin('merchantAdminLogin') + ': ' + username.trim(); }
  if (msg.includes('超级管理员登录成功')) { const username = msg.split(':')[1] || ''; return tAdmin('superAdminLogin') + ': ' + username.trim(); }
  if (msg.includes('服务员登录成功')) return tAdmin('loginSuccess') || '登录成功';
  if (msg.includes('收银员登录成功')) return tAdmin('loginSuccess') || '登录成功';
  if (msg.includes('用户名不存在')) return tAdmin('usernameNotExist');
  if (msg.includes('密码错误')) return tAdmin('passwordError');
  if (msg.includes('账号不存在')) return tAdmin('usernameNotExist');
  if (msg.includes('请输入用户名和密码')) return tAdmin('pleaseEnterCredentials');
  if (msg.includes('IP不在白名单内')) return tAdmin('noPermission') || '无权限';
  return msg;
}

async function loadLoginLogs() {
  try {
    const logs = await api('/admin/login-logs');
    $('#loginLogs').innerHTML = logs.length ?
      logs.map(log => `<div class="row"><div><b>${SLF.utils.formatDateTime(log.createdAt)}</b><small>${esc(log.ip||'-')} · ${esc(translateLoginMessage(log.message))}</small></div><span class="badge ${log.success?'done':'canceled'}">${log.success ? tAdmin('loginSuccess') : tAdmin('loginFailed')}</span></div>`).join('') :
      `<div class="empty-hint">${tAdmin('noData')}</div>`;
  } catch (e) {
    $('#loginLogs').innerHTML = `<div class="empty-hint">${tAdmin('noData')}</div>`;
  }
}

function updateOrderSummary() {
  const orders = ctx.ordersCache();
  // 统计未结算订单
  const pending = orders.filter(o => o.status === 'pending');
  const pendingTotal = pending.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const pendingCountEl = document.getElementById('pendingOrderCount');
  const pendingAmountEl = document.getElementById('pendingOrderAmount');
  if (pendingCountEl) pendingCountEl.textContent = pending.length;
  if (pendingAmountEl) pendingAmountEl.textContent = SLF.money.primary(pendingTotal);
  // 统计已结算订单
  const done = orders.filter(o => o.status === 'done');
  const doneTotal = done.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const doneCountEl = document.getElementById('doneOrderCount');
  const doneAmountEl = document.getElementById('doneOrderAmount');
  if (doneCountEl) doneCountEl.textContent = done.length;
  if (doneAmountEl) doneAmountEl.textContent = SLF.money.primary(doneTotal);
}

function closeSidebar() {
  const sidebar = document.getElementById("adminSidebar");
  if (sidebar) sidebar.classList.remove("open");
  const overlay = document.getElementById("sidebarOverlay");
  if (overlay) overlay.classList.remove("show");
}

function toggleSidebar() {
  const sidebar = document.getElementById('adminSidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (!sidebar) return;
  sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('show');
}

function getCurrentModule() {
  const activeNav = document.querySelector(".nav-item.active");
  return activeNav ? activeNav.dataset.module : null;
}

function switchAdminModule(module) {
  const permMap = {
    menu: 'can_manage_menu', tables: 'can_manage_table', orders: 'can_manage_order',
    stores: 'can_manage_store', waiters: 'can_manage_waiter', currencies: 'can_manage_currency',
    printers: 'can_manage_printer', admins: 'can_manage_admin', cashiers: 'can_manage_cashier',
    logs: 'can_view_logs'
  };
  const needPerm = permMap[module];
  if (needPerm && ctx.hasPermission && !ctx.hasPermission(needPerm)) {
    const msg = ctx.tAdmin ? ctx.tAdmin('noPermission') : 'No permission';
    if (SLF.ui && SLF.ui.toast) SLF.ui.toast('❌ ' + msg);
    return;
  }
  document.querySelectorAll('.module-panel').forEach(m => m.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const panel = document.getElementById('module-' + module);
  if (panel) panel.classList.add('active');
  const navItem = document.querySelector(`.nav-item[data-module="${module}"]`);
  if (navItem) navItem.classList.add('active');

  if (module === 'menu') { if (window.loadMenus) window.loadMenus(); if (window.loadMenuCategories) window.loadMenuCategories(); }
  if (module === 'tables') { if (window.loadTables) window.loadTables(); }
  if (module === 'orders') { if (window.loadOrders) window.loadOrders(); }
  if (module === 'currencies') { if (window.loadCurrencies) window.loadCurrencies(); if (window.loadDisplaySettings) window.loadDisplaySettings(); }
  if (module === 'stores') { if (window.loadStores) window.loadStores(); }
  if (module === 'waiters') { if (window.loadWaiters) window.loadWaiters(); }
  if (module === 'admins') { if (window.loadAdmins) window.loadAdmins(); }
  if (module === 'cashiers') { if (window.loadCashiers) window.loadCashiers(); }
  if (module === 'printers') { if (window.loadPrinters) window.loadPrinters(); }
  if (module === 'reports') { if (window.loadReportSummary) window.loadReportSummary(); if (window.loadDailyReport) window.loadDailyReport(); }
  if (module === 'calls') { if (window.loadWaiterCalls) window.loadWaiterCalls(); }
  if (module === 'logs') { if (window.loadLoginLogs) window.loadLoginLogs(); if (window.loadAuditLogs) window.loadAuditLogs(); }
}

// 汉堡按钮拖动
(function() {
  const btn = document.getElementById('hamburgerBtn');
  if (!btn) return;
  let isDragging = false;
  let startX, startY, startLeft, startTop;
  let hasMoved = false;
  function getPos(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }
  function onStart(e) {
    isDragging = true;
    hasMoved = false;
    const pos = getPos(e);
    startX = pos.x; startY = pos.y;
    const rect = btn.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    btn.classList.add('dragging');
    btn.style.transition = 'none';
  }
  function onMove(e) {
    if (!isDragging) return;
    const pos = getPos(e);
    const dx = pos.x - startX, dy = pos.y - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { hasMoved = true; e.preventDefault(); }
    let newLeft = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, startLeft + dx));
    let newTop = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, startTop + dy));
    btn.style.left = newLeft + 'px';
    btn.style.top = newTop + 'px';
    e.preventDefault();
  }
  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    btn.classList.remove('dragging');
    btn.style.transition = '';
    if (hasMoved) {
      const rect = btn.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      if (centerX < window.innerWidth / 2) btn.style.left = '8px';
      else btn.style.left = (window.innerWidth - btn.offsetWidth - 8) + 'px';
      if (rect.top < 60) btn.style.top = '8px';
      else if (rect.bottom > window.innerHeight - 60) btn.style.top = (window.innerHeight - btn.offsetHeight - 8) + 'px';
    }
  }
  btn.addEventListener('mousedown', onStart);
  btn.addEventListener('touchstart', onStart, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchend', onEnd);
})();

function logoutAdmin() {
  SLF.store.rawRemoveSession('adminToken');
  SLF.store.rawRemoveSession('adminId');
  SLF.store.rawRemoveSession('adminPermissions');
  SLF.store.rawRemoveSession('adminIsPrimary');
  // 清理商户相关的 storeId，避免下次登录其它商户时残留
  SLF.store.rawRemoveSession('adminStoreId');
  SLF.store.rawRemoveSession('adminMerchantId');
  SLF.store.rawRemoveSession('adminMerchantName');
  SLF.store.rawRemove('storeId');
  location.href = '/login';
}

function showAdminInfo() {
  document.getElementById('adminInfoModal').classList.add('open');
}
function hideAdminInfo() {
  document.getElementById('adminInfoModal').classList.remove('open');
}

async function updateReservation(id, status) {
  try {
    await api('/admin/reservations/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { status } });
    SLF.ui.toast(tAdmin('reservationUpdated'));
    if (typeof loadReservations === 'function') loadReservations();
  } catch (err) {
    SLF.ui.toast(tAdmin('updateFailed') + ': ' + err.message);
  }
}

document.addEventListener('DOMContentLoaded', function() {
  const passwordForm = document.getElementById('passwordForm');
  if (passwordForm) {
    passwordForm.onsubmit = async function(e) {
      e.preventDefault();
      try {
        await api('/admin/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {
          oldPassword: $('#oldPassword').value,
          newPassword: $('#newPassword').value
        }});
        e.target.reset();
        SLF.ui.toast('✅ ' + tAdmin('passwordTitle') + ' ' + tAdmin('updated'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
  const resetDataBtn = document.getElementById('resetDataBtn');
  if (resetDataBtn) {
    resetDataBtn.onclick = function() {
      ctx.showPasswordModal(tAdmin('resetDataPasswordMsg'), function(password) {
        ctx.showConfirm(tAdmin('resetDataConfirmMsg'), async function() {
          try {
            await SLF.api.post('/admin/reset-data', { password });
            SLF.ui.toast('✅ ' + tAdmin('resetSuccess'));
            if (window.loadOrders) await window.loadOrders();
            if (window.loadTables) await window.loadTables();
            if (window.loadLoginLogs) await window.loadLoginLogs();
          } catch (e) { SLF.ui.toast('❌ ' + e.message); }
        }, tAdmin('resetDataConfirmTitle'));
      }, tAdmin('resetDataPasswordTitle'));
    };
  }
  const adminLang = document.getElementById('adminLang');
  if (adminLang) {
    adminLang.onchange = async function() {
      const lang = this.value;
      SLF.store.rawSet('adminLang', lang);
      // 先加载语言字典
      try { if (window.loadAdminLanguage) await window.loadAdminLanguage(lang); } catch(e) { console.error('loadAdminLanguage:', e); }
      try { if (window.applyAdminLanguage) window.applyAdminLanguage(); } catch(e) { console.error('applyAdminLanguage:', e); }
      try { if (window.loadAdminInfo) window.loadAdminInfo(); } catch(e) { console.error('loadAdminInfo:', e); }
      const navItem = document.querySelector('.nav-item.active');
      if (navItem && window.switchAdminModule) window.switchAdminModule(navItem.dataset.module);
    };
  }
  const adminStoreSelect = document.getElementById('adminStoreSelect');
  if (adminStoreSelect) {
    adminStoreSelect.onchange = function() {
      SLF.store.rawSetSession('adminStoreId', this.value);
      SLF.store.rawSet('storeId', String(this.value));
      if (window._adminSocket && typeof window._adminSocket.disconnect === 'function') {
        try { window._adminSocket.disconnect(); window._adminSocket.connect(); } catch(_) {}
      }
      if (window.updateSidebarStore) window.updateSidebarStore();
      // 重载当前激活模块（switchAdminModule 内部会调用对应 loadXxx）
      try {
        const activeNav = document.querySelector('.nav-item.active');
        const mod = activeNav && activeNav.dataset.module;
        if (mod && typeof window.switchAdminModule === 'function') {
          window.switchAdminModule(mod);
        } else if (typeof window.refresh === 'function') {
          window.refresh();
        }
      } catch(_) {}
    };
  }
  const pwdInput = document.getElementById('passwordModalInput');
  if (pwdInput) {
    pwdInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && window.executePasswordModal) window.executePasswordModal();
    });
  }
  const confirmModal = document.getElementById('confirmModal');
  if (confirmModal) {
    confirmModal.addEventListener('click', function(e) {
      if (e.target === this && window.hideConfirm) window.hideConfirm();
    });
  }
  const adminInfoModal = document.getElementById('adminInfoModal');
  if (adminInfoModal) {
    adminInfoModal.addEventListener('click', function(e) {
      if (e.target === this && window.hideAdminInfo) window.hideAdminInfo();
    });
  }
});

// 挂到 window
window.dualAmountSuffix = dualAmountSuffix;
window.translateLoginMessage = translateLoginMessage;
window.loadLoginLogs = loadLoginLogs;
window.updateOrderSummary = updateOrderSummary;
window.switchAdminModule = switchAdminModule;
window.getCurrentModule = getCurrentModule;
window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;
window.logoutAdmin = logoutAdmin;
window.showAdminInfo = showAdminInfo;
window.hideAdminInfo = hideAdminInfo;
window.updateReservation = updateReservation;

})();
