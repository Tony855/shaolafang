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
  if (msg.includes('用户名不存在')) return tAdmin('usernameNotExist');
  if (msg.includes('密码错误')) return tAdmin('wrongPassword');
  if (msg.includes('请输入用户名和密码')) return tAdmin('pleaseEnterCredentials');
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
  const pending = orders.filter(o => o.status === 'pending');
  const total = pending.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const el = $('#orderSummary');
  if (el) el.textContent = `${pending.length} ${tAdmin('pendingOrders') || '待处理'} · ${SLF.money.primary(total)}`;
}

function switchAdminModule(module) {
  document.querySelectorAll('.admin-module').forEach(m => m.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const panel = document.getElementById('module-' + module);
  if (panel) panel.classList.add('active');
  const navItem = document.querySelector(`.nav-item[data-module="${module}"]`);
  if (navItem) navItem.classList.add('active');

  if (module === 'menu') { if (window.loadMenus) window.loadMenus(); if (window.loadMenuCategories) window.loadMenuCategories(); }
  if (module === 'tables') { if (window.loadTables) window.loadTables(); }
  if (module === 'orders') { if (window.loadOrders) window.loadOrders(); }
  if (module === 'currencies') { if (window.loadCurrencies) window.loadCurrencies(); }
  if (module === 'stores') { if (window.loadStores) window.loadStores(); }
  if (module === 'waiters') { if (window.loadWaiters) window.loadWaiters(); }
  if (module === 'admins') { if (window.loadAdmins) window.loadAdmins(); }
  if (module === 'cashiers') { if (window.loadCashiers) window.loadCashiers(); }
  if (module === 'printers') { if (window.loadPrinters) window.loadPrinters(); }
  if (module === 'reports') { if (window.loadDailyReport) window.loadDailyReport(); }
  if (module === 'calls') { if (window.loadWaiterCalls) window.loadWaiterCalls(); }
  if (module === 'logs') { if (window.loadLoginLogs) window.loadLoginLogs(); if (window.loadAuditLogs) window.loadAuditLogs(); }
}

function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
}

function logoutAdmin() {
  SLF.store.rawRemoveSession('adminToken');
  SLF.store.rawRemoveSession('adminId');
  SLF.store.rawRemoveSession('adminPermissions');
  SLF.store.rawRemoveSession('adminIsPrimary');
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
      SLF.i18n.lang = lang;
      if (window.applyAdminLanguage) window.applyAdminLanguage();
      if (window.loadAdminInfo) window.loadAdminInfo();
      const navItem = document.querySelector('.nav-item.active');
      if (navItem && window.switchAdminModule) window.switchAdminModule(navItem.dataset.module);
    };
  }
  const adminStoreSelect = document.getElementById('adminStoreSelect');
  if (adminStoreSelect) {
    adminStoreSelect.onchange = function() {
      SLF.store.rawSetSession('adminStoreId', this.value);
      if (window.updateSidebarStore) window.updateSidebarStore();
      if (window.refresh) window.refresh();
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
});

// 挂到 window
window.dualAmountSuffix = dualAmountSuffix;
window.translateLoginMessage = translateLoginMessage;
window.loadLoginLogs = loadLoginLogs;
window.updateOrderSummary = updateOrderSummary;
window.switchAdminModule = switchAdminModule;
window.toggleSidebar = toggleSidebar;
window.logoutAdmin = logoutAdmin;
window.showAdminInfo = showAdminInfo;
window.hideAdminInfo = hideAdminInfo;
window.updateReservation = updateReservation;

})();
