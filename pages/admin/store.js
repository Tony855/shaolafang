/*
 * pages/admin/store.js — 店铺管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, showConfirm } = ctx;

function updateSidebarStore() {
  const select = document.getElementById('adminStoreSelect');
  const nameEl = document.getElementById('sidebarStoreName');
  const codeEl = document.getElementById('sidebarStoreCode');
  if (!select || !nameEl) return;
  const opt = select.options[select.selectedIndex];
  if (opt && opt.value) {
    nameEl.textContent = opt.text;
    const storeId = opt.value;
    if (window._adminStores && window._adminStores.length) {
      const s = window._adminStores.find(x => String(x.id) === String(storeId));
      if (s && s.code) codeEl.textContent = s.code;
      else codeEl.textContent = '';
    } else {
      codeEl.textContent = '';
    }
  } else {
    nameEl.textContent = '未选择店铺';
    codeEl.textContent = '';
  }
}

async function loadStores() {
  try {
    const rows = await api('/admin/stores');
    $('#storeList').innerHTML = rows.length ?
      rows.map(s => `<div class="admin-card">
      <div class="info"><div class="title">${esc(s.name)}</div><div class="sub">${esc(s.code||'')} ${esc(s.address||'')}</div></div>
      <div class="actions">
        <button class="edit-btn" onclick="openStoreEdit(${s.id})">✏️ ${ctx.L('edit')}</button>
        <button class="copy" onclick="copyStoreMenu(${s.id})">📋 ${tAdmin('copyMainStoreMenu')}</button>
        ${hasPermission('can_manage_store') ? '<button class="danger" onclick="deleteStore(' + s.id + ')">' + ctx.L('delete') + '</button>' : ''}
      </div>
    </div>`).join('') :
      `<div class="empty-hint">${tAdmin('noData')}</div>`;

    const adminSelect = $('#adminStoreSelect');
    const waiterSelect = $('#waiterStoreSelect');
    const editWaiterStore = $('#editWaiterStore');
    if (rows.length) {
      const optionsHtml = rows.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      adminSelect.innerHTML = optionsHtml;
      waiterSelect.innerHTML = optionsHtml;
      editWaiterStore.innerHTML = optionsHtml;
      window._adminStores = rows;
      const savedId = SLF.store.rawGetSession('adminStoreId') || '1';
      if (rows.some(r => String(r.id) === savedId)) adminSelect.value = savedId;
      else {
        adminSelect.value = rows[0].id;
        SLF.store.rawSetSession('adminStoreId', String(rows[0].id));
      }
      waiterSelect.value = rows[0].id;
      updateSidebarStore();
    } else {
      adminSelect.innerHTML = `<option value="">${tAdmin('noStoreCheckDb')}</option>`;
      waiterSelect.innerHTML = `<option value="">${tAdmin('noStore')}</option>`;
      editWaiterStore.innerHTML = `<option value="">${tAdmin('noStore')}</option>`;
    }
  } catch (e) {
    console.error(tAdmin('loadStoreFailed') + ':', e);
    SLF.ui.toast(`❌ ${tAdmin('loadStoreFailed')}: ` + e.message);
    $('#storeList').innerHTML = `<div class="empty-hint">${tAdmin('noData')}</div>`;
    $('#adminStoreSelect').innerHTML = `<option value="">${tAdmin('loadFailedRefresh')}</option>`;
    $('#waiterStoreSelect').innerHTML = `<option value="">${tAdmin('loadFailed')}</option>`;
    $('#editWaiterStore').innerHTML = `<option value="">${tAdmin('loadFailed')}</option>`;
  }
}

function deleteStore(id) {
  showConfirm(tAdmin('confirmDelete'), async function() {
    try {
      await api('/admin/stores/' + id, { method: 'DELETE' });
      loadStores();
      SLF.ui.toast('✅ ' + tAdmin('deleted'));
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  });
}

function copyStoreMenu(storeId) {
  showConfirm(tAdmin('confirmCopyMenu'), async function() {
    try {
      const res = await api('/admin/stores/' + storeId + '/copy-menu', { method: 'POST' });
      SLF.ui.toast('✅ ' + res.message);
      loadStores();
      if (document.getElementById('module-menu').classList.contains('active')) window.loadMenus && window.loadMenus();
    } catch (e) { SLF.ui.toast(`❌ ${tAdmin('copyFailed')}: ` + e.message); }
  });
}

async function openStoreEdit(id) {
  try {
    const stores = await api('/admin/stores');
    const target = stores.find(s => s.id === id);
    if (!target) { SLF.ui.toast(`❌ ${tAdmin('storeNotFound')}`); return; }
    $('#editStoreId').value = target.id;
    $('#editStoreName').value = target.name;
    $('#editStoreCode').value = target.code || '';
    $('#editStoreAddress').value = target.address || '';
    $('#editStoreActive').checked = !!target.active;
    const qrLangs = (target.qr_languages || '').split(',').map(s => s.trim()).filter(Boolean);
    document.querySelectorAll('#qrLangSelector input[type="checkbox"]').forEach(cb => { cb.checked = qrLangs.includes(cb.value); });
    $('#storeEditTitle').textContent = '🏪 ' + tAdmin('editStore') + ' #' + id;
    $('#storeEditModal').classList.add('open');
  } catch (e) { SLF.ui.toast(`❌ ${tAdmin('loadStoreFailed')}: ` + e.message); }
}

function closeStoreEdit() { $('#storeEditModal').classList.remove('open'); }

// 挂到 window
window.loadStores = loadStores;
window.updateSidebarStore = updateSidebarStore;
window.deleteStore = deleteStore;
window.copyStoreMenu = copyStoreMenu;
window.openStoreEdit = openStoreEdit;
window.closeStoreEdit = closeStoreEdit;

})();
