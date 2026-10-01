/*
 * pages/admin/cashier-mgr.js — 收银员管理（跨店铺聚合列表 + 创建/编辑可选店铺）
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, showConfirm, L } = ctx;

let editingCashierId = null;
let allCashiers = [];
let allStores = [];

async function ensureStores() {
  if (allStores.length) return allStores;
  try {
    const rows = await api('/admin/stores');
    allStores = Array.isArray(rows) ? rows : [];
  } catch (e) {
    allStores = [];
  }
  return allStores;
}

function getCurrentStoreId() {
  const v = SLF.store.rawGetSession('adminStoreId') || SLF.store.rawGet('storeId') || '1';
  return String(v);
}

function populateStoreSelect(selectedId) {
  const sel = document.getElementById('cashierStoreSelect');
  if (!sel) return;
  sel.innerHTML = allStores.map(s =>
    '<option value="' + s.id + '">' + esc(s.name) + (s.id == 1 ? ' (' + tAdmin('mainStore') + ')' : '') + '</option>'
  ).join('');
  const target = selectedId != null ? String(selectedId) : getCurrentStoreId();
  if (allStores.some(s => String(s.id) === target)) sel.value = target;
  sel.disabled = false;
}

async function openAddCashierModal() {
  if (!hasPermission('can_manage_cashier')) { SLF.ui.toast('❌ ' + tAdmin('noPermission')); return; }
  await ensureStores();
  editingCashierId = null;
  document.getElementById('cashierModalTitle').textContent = tAdmin('addCashier');
  document.getElementById('cashierUsername').value = '';
  document.getElementById('cashierUsername').disabled = false;
  document.getElementById('cashierName').value = '';
  document.getElementById('cashierPassword').value = '';
  document.getElementById('cashierPassword').placeholder = tAdmin('passwordMin6') || '至少6位';
  document.getElementById('cashierActive').checked = true;
  document.getElementById('cashierCanSettle').checked = true;
  document.getElementById('cashierCanCancel').checked = true;
  document.getElementById('cashierCanRefund').checked = false;
  document.getElementById('cashierCanViewReport').checked = true;
  populateStoreSelect(getCurrentStoreId());
  document.getElementById('cashierModal').classList.add('open');
}

async function editCashier(cashierId) {
  await ensureStores();
  const cashier = allCashiers.find(c => String(c.id) === String(cashierId));
  if (!cashier) return;
  editingCashierId = cashier.id;
  document.getElementById('cashierModalTitle').textContent = tAdmin('editCashier');
  document.getElementById('cashierUsername').value = cashier.username;
  document.getElementById('cashierUsername').disabled = true;
  document.getElementById('cashierName').value = cashier.display_name;
  document.getElementById('cashierPassword').value = '';
  document.getElementById('cashierPassword').placeholder = tAdmin('leaveBlankToKeep') || '留空则不修改密码';
  document.getElementById('cashierActive').checked = cashier.active !== false;
  document.getElementById('cashierCanSettle').checked = cashier.permissions?.can_settle !== false;
  document.getElementById('cashierCanCancel').checked = cashier.permissions?.can_cancel !== false;
  document.getElementById('cashierCanRefund').checked = cashier.permissions?.can_refund === true;
  document.getElementById('cashierCanViewReport').checked = cashier.permissions?.can_view_report !== false;
  populateStoreSelect(cashier.store_id);
  document.getElementById('cashierModal').classList.add('open');
}

function closeCashierModal() {
  document.getElementById('cashierModal').classList.remove('open');
  editingCashierId = null;
}

async function loadCashiers() {
  try {
    await ensureStores();
    const data = await api('/admin/cashiers');
    const cashiers = data.cashiers || [];
    allCashiers = cashiers;
    $('#cashierList').innerHTML = cashiers.length ?
      cashiers.map(c => {
        const perms = [];
        if (c.permissions?.can_settle) perms.push(tAdmin('canSettle'));
        if (c.permissions?.can_cancel) perms.push(tAdmin('canCancel'));
        if (c.permissions?.can_refund) perms.push(tAdmin('canRefund'));
        if (c.permissions?.can_view_report) perms.push(tAdmin('canViewReport'));
        const storeTag = c.store_name
          ? '<span style="display:inline-block;background:rgba(52,152,219,.15);color:#5dade2;padding:1px 8px;border-radius:8px;font-size:11px;margin-left:6px;">🏪 ' + esc(c.store_name) + '</span>'
          : '';
        return '<div class="admin-card">' +
        '<div class="info">' +
          '<div class="title">' + esc(c.display_name) + ' · ' + esc(c.username) + storeTag + '</div>' +
          '<div class="sub">' +
            (c.active?'<span style="color:#43e97b">' + tAdmin('cashierEnabled') + '</span>':'<span style="color:#f5576c">' + tAdmin('cashierDisabled') + '</span>') +
            ' · ' + (perms.join(' / ') || tAdmin('noPermission')) +
          '</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button class="edit-btn" onclick="editCashier(' + c.id + ')">✏️ ' + L('edit') + '</button>' +
          '<button class="danger" onclick="deleteCashier(' + c.id + ', \'' + esc(c.username) + '\')">' + L('delete') + '</button>' +
        '</div>' +
      '</div>';
      }).join('') :
      '<div class="empty-hint">' + tAdmin('noCashiers') + '</div>';
  } catch (e) {
    $('#cashierList').innerHTML = '<div class="empty-hint">' + tAdmin('loadFailed') + '</div>';
  }
}

function deleteCashier(id, username) {
  showConfirm(tAdmin('deleteCashierConfirm').replace('{username}', username), function() {
    api('/admin/cashiers/' + id, { method: 'DELETE' }).then(() => {
      SLF.ui.toast('✅ ' + tAdmin('cashierDeleted'));
      loadCashiers();
    }).catch(e => SLF.ui.toast('❌ ' + e.message));
  }, tAdmin('deleteCashier'));
}

document.addEventListener('DOMContentLoaded', function() {
  const cashierForm = document.getElementById('cashierForm');
  if (cashierForm) {
    cashierForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const username = document.getElementById('cashierUsername').value.trim();
      const display_name = document.getElementById('cashierName').value.trim();
      const password = document.getElementById('cashierPassword').value;
      const active = document.getElementById('cashierActive').checked;
      const store_id = parseInt(document.getElementById('cashierStoreSelect').value, 10) || 1;
      const permissions = {
        can_settle: document.getElementById('cashierCanSettle').checked,
        can_cancel: document.getElementById('cashierCanCancel').checked,
        can_refund: document.getElementById('cashierCanRefund').checked,
        can_view_report: document.getElementById('cashierCanViewReport').checked
      };
      if (!username || !display_name) { SLF.ui.toast('❌ ' + tAdmin('fillAllFields')); return; }
      if (!editingCashierId && !password) { SLF.ui.toast('❌ ' + tAdmin('passwordMin6')); return; }
      if (password && password.length < 6) { SLF.ui.toast('❌ ' + tAdmin('passwordMin6')); return; }
      try {
        if (editingCashierId) {
          const body = { display_name, active, permissions, store_id };
          if (password) body.password = password;
          await api('/admin/cashiers/' + editingCashierId, { method: 'PUT', body });
          SLF.ui.toast('✅ ' + tAdmin('cashierUpdated'));
        } else {
          await api('/admin/cashiers', { method: 'POST', body: { username, password, display_name, active, permissions, store_id } });
          SLF.ui.toast('✅ ' + tAdmin('cashierAdded'));
        }
        closeCashierModal();
        loadCashiers();
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    });
  }
});

window.openAddCashierModal = openAddCashierModal;
window.editCashier = editCashier;
window.closeCashierModal = closeCashierModal;
window.loadCashiers = loadCashiers;
window.deleteCashier = deleteCashier;

})();
