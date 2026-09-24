/*
 * pages/admin/table.js — 桌台管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, L, ordersCache, buildSessionLabels } = ctx;

async function loadTables() {
  const list = await api('/tables');
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
  ctx.setTables(list);
  // 同时获取未结算订单，计算桌号状态
  const orders = await api('/orders?status=pending');
  const statusText = { available: L('available'), occupied: L('occupied'), reserved: L('reserved') };
  $('#tables').innerHTML = list.map(t => {
    const hasPending = orders.some(o => o.table === t.name && o.status === 'pending');
    const dynamic = hasPending ? 'occupied' : (t.status === 'reserved' ? 'reserved' : 'available');
    return `<div class="row">
      <div><b>${esc(t.name)}</b><small><span class="table-status ${dynamic}">${statusText[dynamic] || dynamic}</span></small></div>
      <div class="actions">
        ${hasPermission('can_manage_table') ? '<button onclick="editTable(' + t.id + ')">' + L('edit') + '</button>' : ''}
        <button onclick="showQr(${t.id})">${tAdmin('qr')}</button>
        ${hasPermission('can_manage_table') ? '<button class="danger" onclick="removeTable(' + t.id + ')">' + L('delete') + '</button>' : ''}
      </div>
    </div>`;
  }).join('') || `<div class="empty-hint">${tAdmin('noData')}</div>`;
  $('#orderTable').innerHTML = list.map(t => `<option>${esc(t.name)}</option>`).join('');
}

function removeTable(id) {
  ctx.showConfirm(tAdmin('confirmDelete'), async function() {
    try {
      await api('/tables/' + id, { method: 'DELETE' });
      loadTables();
      SLF.ui.toast('✅ ' + tAdmin('deleted'));
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  });
}

function editTable(id) { openTableForm(id); }

function openTableForm(id) {
  const tables = ctx.tablesCache();
  const t = tables.find(x => String(x.id) === String(id));
  editingTableId = t ? t.id : null;
  $('#editTableName').value = t ? t.name : '';
  $('#editTableStatus').value = t ? t.status : 'available';
  $('#tableModal').classList.add('open');
}

function closeTableForm() { $('#tableModal').classList.remove('open'); }

async function showQr(id) {
  const tables = ctx.tablesCache();
  const t = tables.find(x => String(x.id) === String(id));
  if (!t) return;
  window.open('/qr-print?tableId=' + id, '_blank');
}

let editingTableId = null;

document.addEventListener('DOMContentLoaded', function() {
  const tableSaveBtn = document.getElementById('tableSaveBtn');
  if (tableSaveBtn) {
    tableSaveBtn.onclick = async function() {
      const name = $('#editTableName').value.trim();
      const status = $('#editTableStatus').value;
      if (!name) { SLF.ui.toast('❌ ' + tAdmin('tableNameRequired')); return; }
      try {
        await api('/tables/' + editingTableId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { name, status } });
        closeTableForm();
        await loadTables();
        SLF.ui.toast('✅ ' + tAdmin('tableNameLabel') + ' ' + tAdmin('updated'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
  const tableForm = document.getElementById('tableForm');
  if (tableForm) {
    tableForm.onsubmit = async function(e) {
      e.preventDefault();
      try {
        await api('/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { name: $('#tableName').value.trim() } });
        e.target.reset();
        await loadTables();
        SLF.ui.toast('✅ ' + tAdmin('tableNameLabel') + ' ' + tAdmin('added'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
});

// 挂到 window
window.loadTables = loadTables;
window.removeTable = removeTable;
window.editTable = editTable;
window.openTableForm = openTableForm;
window.closeTableForm = closeTableForm;
window.showQr = showQr;

})();
