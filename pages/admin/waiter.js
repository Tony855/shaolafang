/*
 * pages/admin/waiter.js — 服务员管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, showConfirm } = ctx;

async function loadWaiters() {
  try {
    const rows = await api('/admin/waiters');
    const stores = await api('/admin/stores');
    const storeMap = {};
    stores.forEach(s => storeMap[s.id] = s.name);
    $('#waiterList').innerHTML = rows.length ?
      rows.map(w => `<div class="admin-card">
      <div class="info">
        <div class="title">${esc(w.display_name)} · ${esc(w.username)}</div>
        <div class="sub">${w.active?tAdmin('enabled'):tAdmin('disabled')} · ${tAdmin('storeLabel') || '店铺'}：${storeMap[w.store_id] || tAdmin('mainStore')}</div>
        <div class="perms">
          <label><input type="checkbox" ${w.can_order?'checked':''} onchange="updateWaiterPerm(${w.id},'can_order',this.checked)"> ${tAdmin('placeOrder')}</label>
          <label><input type="checkbox" ${w.can_mark_item?'checked':''} onchange="updateWaiterPerm(${w.id},'can_mark_item',this.checked)"> ${tAdmin('serveDish')}</label>
          <label><input type="checkbox" ${w.can_complete_order?'checked':''} onchange="updateWaiterPerm(${w.id},'can_complete_order',this.checked)"> ${tAdmin('completeOrder')}</label>
        </div>
      </div>
      <div class="actions">
        <button class="edit-btn" onclick="openWaiterEdit(${w.id})">✏️ ${ctx.L('edit')}</button>
        ${hasPermission('can_manage_waiter') ? '<button class="danger" onclick="deleteWaiter(' + w.id + ')">' + ctx.L('delete') + '</button>' : ''}
      </div>
    </div>`).join('') :
      `<div class="empty-hint">${tAdmin('noData')}</div>`;
  } catch (e) {
    console.error(tAdmin('loadWaiterFailed') + ':', e);
    $('#waiterList').innerHTML = `<div class="empty-hint">${tAdmin('noData')}</div>`;
  }
}

async function updateWaiterPerm(id, key, val) {
  try {
    await api('/admin/waiters/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { [key]: val } });
    SLF.ui.toast('✅ ' + tAdmin('updated'));
  } catch (e) { SLF.ui.toast('❌ ' + e.message); loadWaiters(); }
}

function deleteWaiter(id) {
  showConfirm(tAdmin('confirmDelete'), async function() {
    try {
      await api('/admin/waiters/' + id, { method: 'DELETE' });
      loadWaiters();
      SLF.ui.toast('✅ ' + tAdmin('deleted'));
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  });
}

async function openWaiterEdit(id) {
  try {
    const waiter = await api('/admin/waiters');
    const target = waiter.find(w => w.id === id);
    if (!target) { SLF.ui.toast(`❌ ${tAdmin('waiterNotFound')}`); return; }
    $('#editWaiterId').value = target.id;
    $('#editWaiterUsername').value = target.username;
    $('#editWaiterPassword').value = '';
    $('#editWaiterDisplayName').value = target.display_name;
    const stores = await api('/admin/stores');
    const select = $('#editWaiterStore');
    select.innerHTML = stores.map(s => `<option value="${s.id}" ${s.id === target.store_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    $('#editWaiterCanOrder').checked = !!target.can_order;
    $('#editWaiterCanMarkItem').checked = !!target.can_mark_item;
    $('#editWaiterCanCompleteOrder').checked = !!target.can_complete_order;
    $('#waiterEditTitle').textContent = '🧑‍🍳 ' + tAdmin('editWaiter') + ' #' + id;
    $('#waiterEditModal').classList.add('open');
  } catch (e) { SLF.ui.toast(`❌ ${tAdmin('loadWaiterFailed')}: ` + e.message); }
}

function closeWaiterEdit() { $('#waiterEditModal').classList.remove('open'); }

document.addEventListener('DOMContentLoaded', function() {
  const addWaiterBtn = document.getElementById('addWaiterBtn');
  if (addWaiterBtn) {
    addWaiterBtn.onclick = async function() {
      const username = $('#waiterUsernameInput').value.trim();
      const password = $('#waiterPasswordInput').value;
      const display_name = $('#waiterNameInput').value.trim();
      const store_id = parseInt($('#waiterStoreSelect').value) || 1;
      if (!username || !password || !display_name) { SLF.ui.toast(`❌ ${tAdmin('waiterInfoRequired')}`); return; }
      try {
        await api('/admin/waiters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username, password, display_name, can_order: 1, can_mark_item: 1, can_complete_order: 1, store_id } });
        $('#waiterUsernameInput').value = '';
        $('#waiterPasswordInput').value = '';
        $('#waiterNameInput').value = '';
        loadWaiters();
        SLF.ui.toast('✅ ' + tAdmin('added'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
});

// 挂到 window
window.loadWaiters = loadWaiters;
window.updateWaiterPerm = updateWaiterPerm;
window.deleteWaiter = deleteWaiter;
window.openWaiterEdit = openWaiterEdit;
window.closeWaiterEdit = closeWaiterEdit;

})();
