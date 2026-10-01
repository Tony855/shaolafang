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
        <button onclick="openStoreDisplay(${s.id})" style="background:rgba(105,192,255,.15);border-color:rgba(105,192,255,.3);color:#69c0ff;">📺 ${tAdmin('displayPage') || '展示页'}</button>
        <button onclick="copyStoreDisplayUrl(${s.id})" style="background:rgba(105,192,255,.15);border-color:rgba(105,192,255,.3);color:#69c0ff;">🔗 ${tAdmin('copyDisplayLink') || '复制链接'}</button>
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
    const target = stores.find(s => String(s.id) === String(id));
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

document.addEventListener('DOMContentLoaded', function() {
  const addStoreBtn = document.getElementById('addStoreBtn');
  if (addStoreBtn) {
    addStoreBtn.onclick = async function() {
      const name = $('#storeNameInput').value.trim();
      const code = $('#storeCodeInput').value.trim();
      const address = $('#storeAddressInput').value.trim();
      if (!name) { SLF.ui.toast(`❌ ${tAdmin('enterStoreName')}`); return; }
      try {
        await api('/admin/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { name, code, address } });
        $('#storeNameInput').value = '';
        $('#storeCodeInput').value = '';
        $('#storeAddressInput').value = '';
        loadStores();
        SLF.ui.toast('✅ ' + tAdmin('added'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
  const editStoreActive = document.getElementById('editStoreActive');
  if (editStoreActive) {
    editStoreActive.addEventListener('change', function() {
      const statusText = this.checked ? tAdmin('storeActive') : tAdmin('storeDisabled');
      document.getElementById('storeEditStatusText').textContent = statusText;
    });
  }
  const saveStoreEditBtn = document.getElementById('saveStoreEditBtn');
  if (saveStoreEditBtn) {
    saveStoreEditBtn.onclick = async function() {
      const id = parseInt($('#editStoreId').value);
      const name = $('#editStoreName').value.trim();
      const code = $('#editStoreCode').value.trim();
      const address = $('#editStoreAddress').value.trim();
      const active = $('#editStoreActive').checked ? 1 : 0;
      if (!name) { SLF.ui.toast(`❌ ${tAdmin('enterStoreName')}`); return; }
      try {
        await api('/admin/stores/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { name, code, address, active } });
        closeStoreEdit();
        loadStores();
        SLF.ui.toast('✅ ' + tAdmin('updated'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
});

// 挂到 window
window.loadStores = loadStores;
window.updateSidebarStore = updateSidebarStore;
window.deleteStore = deleteStore;
window.copyStoreMenu = copyStoreMenu;
window.openStoreEdit = openStoreEdit;
window.closeStoreEdit = closeStoreEdit;

})();

window.openStoreDisplay = function(storeId) {
  window.open(location.origin + '/display?store=' + storeId, '_blank');
};
window.copyStoreDisplayUrl = function(storeId) {
  const url = location.origin + '/display?store=' + storeId;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => SLF.ui.toast('✅ ' + (tAdmin('copied') || '已复制') + '：' + url)).catch(() => prompt('手动复制', url));
  } else {
    prompt('手动复制', url);
  }
};
