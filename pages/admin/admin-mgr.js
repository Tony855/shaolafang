/*
 * pages/admin/admin-mgr.js — 管理员管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, showConfirm, adminId } = ctx;

async function loadAdmins() {
  try {
    const rows = await api('/admin/admins');
    $('#adminList').innerHTML = rows.length ?
      rows.map(a => `<div class="admin-card">
      <div class="info">
        <div class="title">${esc(a.display_name)} · ${esc(a.username)}${a.id === adminId ? ' ' + tAdmin('currentAdmin') : ''}</div>
        <div class="sub">${a.active?'<span style="color:#43e97b">' + tAdmin('adminActive') + '</span>':'<span style="color:#f5576c">' + tAdmin('adminInactive') + '</span>'} · ${tAdmin('lastLogin')} ${a.last_login_at ? SLF.utils.formatDateTime(a.last_login_at) : tAdmin('neverLogin')}</div>
      </div>
      <div class="actions">
        ${hasPermission('can_manage_admin') ? `<button class="edit-btn" onclick="editAdmin(${a.id}, '${esc(a.username)}', '${esc(a.display_name)}', ${a.active}, {can_manage_menu:${a.can_manage_menu},can_manage_table:${a.can_manage_table},can_manage_order:${a.can_manage_order},can_delete_order:${a.can_delete_order},can_edit_order:${a.can_edit_order},can_manage_store:${a.can_manage_store},can_manage_waiter:${a.can_manage_waiter},can_manage_currency:${a.can_manage_currency},can_manage_printer:${a.can_manage_printer},can_manage_cashier:${a.can_manage_cashier},can_manage_admin:${a.can_manage_admin},can_view_logs:${a.can_view_logs}}, ${a.is_primary})">✏️ ${tAdmin('editAdminBtn')}</button>` : ''}
        ${hasPermission('can_manage_admin') ? `<button class="danger" onclick="deleteAdmin(${a.id}, '${esc(a.username)}')" ${a.id === adminId ? 'disabled style="opacity:.4;cursor:not-allowed;"' : ''}>${tAdmin('deleteAdminBtn')}</button>` : ''}
      </div>
    </div>`).join('') :
      `<div class="empty-hint">${tAdmin('noAdmins')}</div>`;
  } catch (e) {
    $('#adminList').innerHTML = `<div class="empty-hint">${tAdmin('loadFailed')}</div>`;
  }
}

function collectPermissionsFromPrefix(prefix) {
  const perms = {};
  document.querySelectorAll('#' + prefix + ' input[type="checkbox"]').forEach(cb => {
    perms[cb.dataset.perm] = cb.checked ? 1 : 0;
  });
  return perms;
}

function updateAdminPermissions(prefix, permissions, isPrimary) {
  document.querySelectorAll('#' + prefix + ' input[type="checkbox"]').forEach(cb => {
    cb.checked = permissions && permissions[cb.dataset.perm] ? true : false;
    cb.disabled = isPrimary ? true : false;
  });
}

function openAddAdminModal() {
  if (!hasPermission('can_manage_admin')) { SLF.ui.toast('❌ ' + tAdmin('noPermission')); return; }
  $('#addAdminUsername').value = '';
  $('#addAdminPassword').value = '';
  $('#addAdminDisplayName').value = '';
  updateAdminPermissions('addAdminPermissions', {}, false);
  $('#addAdminModal').classList.add('open');
}

function closeAddAdminModal() { $('#addAdminModal').classList.remove('open'); }

async function submitAddAdmin() {
  if (!hasPermission('can_manage_admin')) { SLF.ui.toast('❌ ' + tAdmin('noPermission')); return; }
  const username = $('#addAdminUsername').value.trim();
  const password = $('#addAdminPassword').value;
  const display_name = $('#addAdminDisplayName').value.trim();
  if (!username || !password || !display_name) { SLF.ui.toast(tAdmin('fillAllFields')); return; }
  if (password.length < 6) { SLF.ui.toast(tAdmin('passwordMin6')); return; }
  const permissions = collectPermissionsFromPrefix('addAdminPermissions');
  try {
    await api('/admin/admins', { method: 'POST', body: { username, password, display_name, active: 1, permissions } });
    closeAddAdminModal();
    SLF.ui.toast('✅ ' + tAdmin('adminAdded'));
    loadAdmins();
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

function editAdmin(id, username, displayName, active, permissions, isPrimary) {
  document.getElementById('editAdminId').value = id;
  document.getElementById('editAdminUsername').value = username || '';
  document.getElementById('editAdminDisplayName').value = displayName || '';
  document.getElementById('editAdminPassword').value = '';
  document.getElementById('editAdminActive').checked = active ? true : false;
  updateAdminPermissions('editAdminPermissions', permissions, isPrimary);
  document.getElementById('editAdminPermNotice').style.display = isPrimary ? 'block' : 'none';
  document.getElementById('adminEditModal').classList.add('open');
}

function closeAdminEdit() { document.getElementById('adminEditModal').classList.remove('open'); }

function saveAdminEdit() {
  const id = document.getElementById('editAdminId').value;
  const displayName = document.getElementById('editAdminDisplayName').value.trim();
  const password = document.getElementById('editAdminPassword').value;
  const active = document.getElementById('editAdminActive').checked ? 1 : 0;
  if (!displayName) { SLF.ui.toast('❌ 请输入显示名称'); return; }
  if (password && password.length < 6) { SLF.ui.toast('❌ 密码至少6位'); return; }
  const body = { display_name: displayName, active };
  if (password) body.password = password;
  const notice = document.getElementById('editAdminPermNotice');
  if (!notice || notice.style.display !== 'block') {
    body.permissions = collectPermissionsFromPrefix('editAdminPermissions');
  }
  api('/admin/admins/' + id, { method: 'PUT', body }).then(() => {
    SLF.ui.toast('✅ ' + tAdmin('adminUpdated'));
    closeAdminEdit();
    loadAdmins();
  }).catch(e => SLF.ui.toast('❌ ' + e.message));
}

function deleteAdmin(id, username) {
  showConfirm(tAdmin('deleteAdminConfirm').replace('{username}', username), function() {
    api('/admin/admins/' + id, { method: 'DELETE' }).then(() => {
      SLF.ui.toast('✅ ' + tAdmin('adminDeleted'));
      loadAdmins();
    }).catch(e => SLF.ui.toast('❌ ' + e.message));
  }, tAdmin('deleteAdminBtn'));
}

// 挂到 window
window.loadAdmins = loadAdmins;
window.collectPermissionsFromPrefix = collectPermissionsFromPrefix;
window.updateAdminPermissions = updateAdminPermissions;
window.openAddAdminModal = openAddAdminModal;
window.closeAddAdminModal = closeAddAdminModal;
window.submitAddAdmin = submitAddAdmin;
window.editAdmin = editAdmin;
window.closeAdminEdit = closeAdminEdit;
window.saveAdminEdit = saveAdminEdit;
window.deleteAdmin = deleteAdmin;

})();
