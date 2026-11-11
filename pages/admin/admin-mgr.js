/*
 * pages/admin/admin-mgr.js — 管理员管理（自包含权限渲染）
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, showConfirm } = ctx;

/* ========= 权限清单 ========= */
const ADMIN_PERMISSIONS = [
  { key: 'can_manage_menu',     labelKey: 'permMenu',        icon: '🍽️', group: 'permGroupOps' },
  { key: 'can_manage_table',    labelKey: 'permTable',       icon: '🪑', group: 'permGroupOps' },
  { key: 'can_manage_order',    labelKey: 'permOrder',       icon: '📋', group: 'permGroupOps' },
  { key: 'can_delete_order',    labelKey: 'permDeleteOrder', icon: '🗑️', group: 'permGroupOps' },
  { key: 'can_edit_order',      labelKey: 'permEditOrder',   icon: '✏️', group: 'permGroupOps' },
  { key: 'can_manage_store',    labelKey: 'permStore',       icon: '🏪', group: 'permGroupBase' },
  { key: 'can_manage_waiter',   labelKey: 'permWaiter',      icon: '👥', group: 'permGroupBase' },
  { key: 'can_manage_currency', labelKey: 'permCurrency',    icon: '💱', group: 'permGroupBase' },
  { key: 'can_manage_printer',  labelKey: 'permPrinter',     icon: '🖨️', group: 'permGroupBase' },
  { key: 'can_manage_cashier',  labelKey: 'permCashier',     icon: '💳', group: 'permGroupBase' },
  { key: 'can_manage_admin',    labelKey: 'permAdmin',       icon: '👤', group: 'permGroupSystem' },
  { key: 'can_view_logs',       labelKey: 'permLogs',        icon: '📝', group: 'permGroupSystem' },
  { key: 'can_manage_financial_reconciliation', labelKey: 'permFinancialReconciliation', icon: '📒', group: 'permGroupSystem' }
];

function renderPerms(containerId, permissions, disabled) {
  const container = document.getElementById(containerId);
  if (!container) { console.warn('[admin-mgr] 容器未找到:', containerId); return; }
  const groups = {};
  ADMIN_PERMISSIONS.forEach(p => {
    if (!groups[p.group]) groups[p.group] = [];
    groups[p.group].push(p);
  });
  let html = '';
  for (const groupKey of Object.keys(groups)) {
    html += '<div class="admin-perm-group">' +
      '<div class="admin-perm-group-title">' + (tAdmin(groupKey) || groupKey) + '</div>' +
      '<div class="admin-perm-items">';
    groups[groupKey].forEach(p => {
      const checked = permissions && permissions[p.key] ? 'checked' : '';
      const dis = disabled ? 'disabled' : '';
      html += '<label class="admin-perm-item ' + (disabled ? 'disabled' : '') + '">' +
        '<span class="admin-perm-icon">' + p.icon + '</span>' +
        '<span class="admin-perm-label">' + (tAdmin(p.labelKey) || p.key) + '</span>' +
        '<label class="store-switch">' +
          '<input type="checkbox" class="admin-perm-checkbox" data-perm="' + p.key + '" ' + checked + ' ' + dis + '>' +
          '<span class="store-switch-slider"></span>' +
        '</label>' +
      '</label>';
    });
    html += '</div></div>';
  }
  container.innerHTML = html;
}

function collectPerms(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return {};
  const perms = {};
  container.querySelectorAll('input[type="checkbox"][data-perm]').forEach(cb => {
    perms[cb.dataset.perm] = cb.checked ? 1 : 0;
  });
  return perms;
}

/* ========= 列表 ========= */
let adminListCache = [];

async function loadAdmins() {
  try {
    const rows = await api('/admin/admins');
    adminListCache = rows;
    const currentAdminId = ctx.adminId;
    $('#adminList').innerHTML = rows.length ?
      rows.map((a, i) =>
        '<div class="admin-card">' +
        '<div class="info">' +
          '<div class="title">' + esc(a.display_name) + ' · ' + esc(a.username) + (a.id === currentAdminId ? ' ' + tAdmin('currentAdmin') : '') + '</div>' +
          '<div class="sub">' + (a.active ? '<span style="color:#43e97b">' + tAdmin('adminActive') + '</span>' : '<span style="color:#f5576c">' + tAdmin('adminInactive') + '</span>') + ' · ' + tAdmin('lastLogin') + ' ' + (a.last_login_at ? SLF.utils.formatDateTime(a.last_login_at) : tAdmin('neverLogin')) + '</div>' +
        '</div>' +
        '<div class="actions">' +
          (hasPermission('can_manage_admin') ? '<button class="edit-btn" onclick="editAdminByIndex(' + i + ')">✏️ ' + tAdmin('editAdminBtn') + '</button>' : '') +
          (hasPermission('can_manage_admin') ? '<button class="danger" onclick="deleteAdminByIndex(' + i + ')"' + (a.id === currentAdminId ? ' disabled style="opacity:.4;cursor:not-allowed;"' : '') + '>' + tAdmin('deleteAdminBtn') + '</button>' : '') +
        '</div>' +
      '</div>'
      ).join('') :
      '<div class="empty-hint">' + tAdmin('noAdmins') + '</div>';
  } catch (e) {
    $('#adminList').innerHTML = '<div class="empty-hint">' + tAdmin('loadFailed') + '</div>';
  }
}

/* ========= 编辑 ========= */
function editAdminByIndex(i) {
  const a = adminListCache[i];
  if (!a) return;
  const perms = {
    can_manage_menu: a.can_manage_menu,
    can_manage_table: a.can_manage_table,
    can_manage_order: a.can_manage_order,
    can_delete_order: a.can_delete_order,
    can_edit_order: a.can_edit_order,
    can_manage_store: a.can_manage_store,
    can_manage_waiter: a.can_manage_waiter,
    can_manage_currency: a.can_manage_currency,
    can_manage_printer: a.can_manage_printer,
    can_manage_cashier: a.can_manage_cashier,
    can_manage_admin: a.can_manage_admin,
    can_view_logs: a.can_view_logs
  };
  editAdmin(a.id, a.username, a.display_name, a.active, perms, a.is_primary);
}

function editAdmin(id, username, displayName, active, permissions, isPrimary) {
  document.getElementById('editAdminId').value = id;
  document.getElementById('editAdminUsername').value = username || '';
  document.getElementById('editAdminDisplayName').value = displayName || '';
  document.getElementById('editAdminPassword').value = '';
  document.getElementById('editAdminActive').checked = active ? true : false;
  renderPerms('editAdminPermissions', permissions || {}, !!isPrimary);
  document.getElementById('editAdminPermNotice').style.display = isPrimary ? 'block' : 'none';
  document.getElementById('adminEditModal').classList.add('open');
}

function closeAdminEdit() { document.getElementById('adminEditModal').classList.remove('open'); }

function saveAdminEdit() {
  const id = document.getElementById('editAdminId').value;
  const displayName = document.getElementById('editAdminDisplayName').value.trim();
  const password = document.getElementById('editAdminPassword').value;
  const active = document.getElementById('editAdminActive').checked ? 1 : 0;
  if (!displayName) { SLF.ui.toast('❌ ' + tAdmin('enterDisplayName')); return; }
  if (password && password.length < 6) { SLF.ui.toast('❌ ' + tAdmin('passwordMin6')); return; }
  const body = { display_name: displayName, active };
  if (password) body.password = password;
  const notice = document.getElementById('editAdminPermNotice');
  if (!notice || notice.style.display !== 'block') {
    body.permissions = collectPerms('editAdminPermissions');
  }
  api('/admin/admins/' + id, { method: 'PUT', body }).then(() => {
    SLF.ui.toast('✅ ' + tAdmin('adminUpdated'));
    closeAdminEdit();
    loadAdmins();
  }).catch(e => SLF.ui.toast('❌ ' + e.message));
}

function deleteAdminByIndex(i) {
  const a = adminListCache[i];
  if (!a) return;
  deleteAdmin(a.id, a.username);
}

function deleteAdmin(id, username) {
  showConfirm(tAdmin('deleteAdminConfirm').replace('{username}', username), function() {
    api('/admin/admins/' + id, { method: 'DELETE' }).then(() => {
      SLF.ui.toast('✅ ' + tAdmin('adminDeleted'));
      loadAdmins();
    }).catch(e => SLF.ui.toast('❌ ' + e.message));
  }, tAdmin('deleteAdminBtn'));
}

/* ========= 添加 ========= */
function openAddAdminModal() {
  if (!hasPermission('can_manage_admin')) { SLF.ui.toast('❌ ' + tAdmin('noPermission')); return; }
  document.getElementById('addAdminUsername').value = '';
  document.getElementById('addAdminPassword').value = '';
  document.getElementById('addAdminDisplayName').value = '';
  renderPerms('addAdminPermissions', {}, false);
  document.getElementById('adminAddModal').classList.add('open');
}

function closeAddAdminModal() { document.getElementById('adminAddModal').classList.remove('open'); }

async function submitAddAdmin() {
  if (!hasPermission('can_manage_admin')) { SLF.ui.toast('❌ ' + tAdmin('noPermission')); return; }
  const username = document.getElementById('addAdminUsername').value.trim();
  const password = document.getElementById('addAdminPassword').value;
  const display_name = document.getElementById('addAdminDisplayName').value.trim();
  if (!username || !password || !display_name) { SLF.ui.toast('❌ ' + tAdmin('fillAllFields')); return; }
  if (password.length < 6) { SLF.ui.toast('❌ ' + tAdmin('passwordMin6')); return; }
  const permissions = collectPerms('addAdminPermissions');
  try {
    await api('/admin/admins', { method: 'POST', body: { username, password, display_name, active: 1, permissions } });
    closeAddAdminModal();
    SLF.ui.toast('✅ ' + tAdmin('adminAdded'));
    loadAdmins();
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

/* ========= 导出 ========= */
window.loadAdmins = loadAdmins;
window.editAdminByIndex = editAdminByIndex;
window.editAdmin = editAdmin;
window.closeAdminEdit = closeAdminEdit;
window.saveAdminEdit = saveAdminEdit;
window.deleteAdminByIndex = deleteAdminByIndex;
window.deleteAdmin = deleteAdmin;
window.openAddAdminModal = openAddAdminModal;
window.closeAddAdminModal = closeAddAdminModal;
window.submitAddAdmin = submitAddAdmin;

})();
