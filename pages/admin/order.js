/*
 * pages/admin/order.js — 订单核心模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, L, buildSessionLabels } = ctx;

let orderTableFilter = '';

function setOrderFilter(q) {
  orderTableFilter = q;
  loadOrders();
}

async function loadOrders() {
  const orders = await api('/orders');
  ctx.setOrders(orders);
  let filtered = orders;
  if (orderTableFilter) {
    const q = orderTableFilter.toLowerCase();
    filtered = orders.filter(o => (o.table_name||o.table||'').toLowerCase().includes(q) || String(o.id).includes(q) || String(o.order_no||'').includes(q));
  }
  const statusText = { pending: L('orderPending'), done: L('orderDone'), canceled: L('canceled') };
  const sessionLabels = buildSessionLabels(filtered);
  $('#orders').innerHTML = filtered.map(o => `
      <div class="order-item-admin">
        <div class="top"><span class="table-info"><strong>${esc(o.order_no||'#'+o.id)}</strong> · ${tAdmin('table')||L('table')} ${esc(o.table)}${sessionLabels.get(o.id) ? ` · <span class="session-badge">${esc(sessionLabels.get(o.id))}</span>` : ''}</span><span class="status ${o.status==='done'?'status-done':o.status==='canceled'?'status-canceled':'status-pending'}">${statusText[o.status]||esc(o.status)}</span></div>
        ${o.note ? `<div class="order-note" style="margin:8px 0;padding:8px 12px;border-radius:10px;background:rgba(255,193,7,.12);border:1px solid rgba(255,193,7,.2);font-size:13px;color:#f0c040;line-height:1.5;"><strong style="color:#ffd93d;">${esc(L('orderNoteDisplay')||tAdmin('note'))}：</strong>${esc(o.note)}</div>` : ''}
        <div class="items">${o.items.map((item,index) => `
          <div class="dish-line" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span class="dish-name">${esc(item.name)} ×${item.quantity} <span style="color:#e67e22;font-size:12px;">@${SLF.money.primary(SLF.money.toBase(item.price, (item.currency_code||'USD')))}</span>${item.returnedQty > 0 ? ` <small style="color:#e74c3c;">${tAdmin('returned') || '已退回'} ${item.returnedQty}</small>` : ''}</span>
            <span style="font-weight:600;white-space:nowrap;">${SLF.money.primary(SLF.money.toBase(item.price, (item.currency_code||'USD')) * (item.quantity - (item.returnedQty || 0)))}${window.dualAmountSuffix ? window.dualAmountSuffix(SLF.money.toBase(item.price, (item.currency_code||'USD')) * (item.quantity - (item.returnedQty || 0))) : ''}</span>
            ${item.itemStatus==='done' ? `<span class="item-status done">${L('itemDone')}</span>` : (o.status==='pending' ? `<button class="item-toggle" onclick="toggleItemStatus(${o.id},${index})">${L('pending')}</button>` : '')}
          </div>
        `).join('')}</div>
        <div class="bottom">
          <span class="time">${SLF.utils.formatDateTime(o.createdAt)}</span>
          <span class="total">${SLF.money.primary(o.total)}${window.dualAmountSuffix ? window.dualAmountSuffix(o.total) : ''}</span>
          <div class="actions">
            ${o.status==='done' || o.status==='canceled' ? '' : (hasPermission('can_edit_order') ? `<button class="edit" onclick="editOrder(${o.id})">${L('edit')}</button>` : '')}
            <button onclick="printOrder(${o.id})" style="background:#3498db;">🖨️ ${tAdmin('print')}</button>
            ${o.status==='pending' ? `<button class="settle-order-btn" onclick="confirmSettleOrder(${o.id})">💰 ${tAdmin('settleOrder')}</button><button onclick="showTransferModal(${o.id},'${o.table_name}')" style="background:#9b59b6;">↔ ${tAdmin('transferOrder')}</button>${hasPermission('can_delete_order') ? `<button class="cancel-order-btn" onclick="confirmCancelOrder(${o.id})">🗑️ ${tAdmin('cancelOrder')}</button>` : ''}` : ''}
            ${hasPermission('can_delete_order') ? `<button class="danger" onclick="removeOrder(${o.id})">${L('delete')}</button>` : ''}
          </div>
        </div>
      </div>
    `).join('') || `<div class="empty-hint">${tAdmin('noOrders')}</div>`;
  if (typeof updateOrderSummary === 'function') updateOrderSummary();
  if (ctx.tablesCache().length && window.loadTables) window.loadTables();
}

let transferOrderId = null;
let transferFromTable = '';
let settleOrderId = null;

async function toggleItemStatus(id, index) {
  try {
    const orders = ctx.ordersCache();
    const order = orders.find(o => String(o.id) === String(id));
    if (!order || !order.items[index]) return;
    if (order.items[index].itemStatus === 'done') { SLF.ui.toast(`❌ ${tAdmin('cannotRevertDone')}`); return; }
    await api('/orders/' + id + '/items/' + index, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { itemStatus: 'done' } });
    await loadOrders();
    SLF.ui.toast(`✅ ${tAdmin('dishStatusUpdated')}`);
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

async function showTransferModal(orderId, fromTable) {
  transferFromTable = fromTable;
  transferOrderId = orderId;
  document.getElementById('transferTitle').textContent = '↔ ' + tAdmin('transferOrder');
  document.getElementById('transferToLabel').textContent = tAdmin('transferTo');
  document.getElementById('transferCancelBtn').textContent = tAdmin('cancel');
  document.getElementById('transferConfirmBtn').textContent = tAdmin('confirm');
  document.getElementById('transferFromLabel').textContent = tAdmin('transferFrom') + ': ' + fromTable;
  const select = document.getElementById('transferTargetSelect');
  try {
    const res = await SLF.api.get('/tables');
    const others = (res.tables || res || []).filter(x => x.name !== fromTable);
    select.innerHTML = others.map(x => '<option value="' + esc(x.name) + '">' + esc(x.name) + '</option>').join('');
    document.getElementById('transferModal').classList.add('open');
  } catch (e) { SLF.ui.toast("❌ " + e.message); }
}
function closeTransferModal() {
  document.getElementById('transferModal').classList.remove('open');
  transferOrderId = null;
}
async function confirmTransfer() {
  if (!transferOrderId) return;
  const target = document.getElementById('transferTargetSelect').value;
  ctx.showConfirm(tAdmin('transferConfirmMsg') + ' ' + transferFromTable + ' → ' + target, async function() {
    try {
      const res = await SLF.api.post('/orders/' + transferOrderId + '/transfer', { target_table: target });
      if (res && res.targetHasOrders) SLF.ui.toast('⚠️ ' + tAdmin('targetHasOrders'));
      SLF.ui.toast('✅ ' + tAdmin('transferSuccess'));
      closeTransferModal();
      loadOrders();
    } catch (e) { SLF.ui.toast("❌ " + e.message); }
  });
}

async function confirmSettleOrder(id) {
  settleOrderId = id;
  try {
    const res = await SLF.api.get('/orders/' + id);
    const o = res.order || res;
    const items = (o.items || []).map(i => {
      const qty = Number(i.quantity||0) - Number(i.returnedQty||0);
      return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);">'
        + '<span>' + esc(i.name) + ' ×' + i.quantity + ' <span style="color:#e67e22;font-size:12px;">@' + SLF.money.primary(SLF.money.toBase(i.price, (i.currency_code||'USD'))) + '</span></span>'
        + '<span style="font-weight:600;">' + SLF.money.primary(SLF.money.toBase(i.price, (i.currency_code||'USD')) * qty) + '</span></div>';
    }).join('');
    document.getElementById('settleDetailBody').innerHTML =
      '<div style="margin-bottom:12px;color:#888;font-size:13px;">' + (o.order_no||('#'+id)) + ' · ' + esc(o.table_name||'-') + '</div>'
      + items
      + '<div style="margin-top:12px;text-align:right;font-size:16px;font-weight:700;">' + tAdmin('total') + ': ' + SLF.money.primary(o.total) + '</div>';
    document.getElementById('settleDetailModal').classList.add('open');
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}
function closeSettleDetail() {
  document.getElementById('settleDetailModal').classList.remove('open');
  settleOrderId = null;
}
async function doSettleOrder() {
  if (!settleOrderId) return;
  const id = settleOrderId;
  closeSettleDetail();
  try { await statusOrder(id, 'done'); SLF.ui.toast('✅ ' + tAdmin('settleOrder')); } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}
function confirmCancelOrder(id) {
  ctx.showConfirm(tAdmin('cancelOrderConfirm'), () => statusOrder(id, 'canceled'), tAdmin('cancelOrder'));
}
async function statusOrder(id, status) {
  try {
    await api('/orders/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { status } });
    await loadOrders();
    SLF.ui.toast('✅ ' + tAdmin('orderManage') + ' ' + tAdmin('updated'));
  } catch (e) {
    const msg = e.message.includes('未完成菜品') ? (L('incompleteItemsError') || e.message) : e.message;
    SLF.ui.toast('❌ ' + msg);
    throw e;
  }
}
function removeOrder(id) {
  ctx.showPasswordModal(tAdmin('passwordTitle'), async function(password) {
    try {
      await api('/orders/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: { password } });
      await loadOrders();
      SLF.ui.toast('✅ ' + tAdmin('deleted'));
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  });
}

let editingOrderId = null;
let editingOrderStatus = 'pending';

function openOrderForm() {
  editingOrderId = null;
  editingOrderStatus = 'pending';
  $('#orderModalTitle').textContent = tAdmin('addOrder');
  $('#orderTable').disabled = false;
  const tables = ctx.tablesCache();
  if (tables.length) $('#orderTable').value = tables[0].name;
  $('#orderItems').innerHTML = '';
  $('#orderNoteField').value = '';
  addOrderItem();
  updateOrderTotal();
  $('#orderModal').classList.add('open');
}
function closeOrderForm() { $('#orderModal').classList.remove('open'); }
function removeOrderItem(btn) { btn.closest('.order-item-line').remove(); updateOrderTotal(); }
function updateOrderTotal() {
  let total = 0;
  document.querySelectorAll('#orderItems .order-item-line').forEach(row => {
    const id = +row.querySelector('select').value;
    const qty = +row.querySelector('input').value || 0;
    const menus = ctx.menusCache();
    const menu = menus.find(m => String(m.id) === String(id));
    if (menu && qty > 0) total += SLF.money.toBase(menu.price, (menu.currency_code||'USD')) * qty;
  });
  $('#orderFormTotal').textContent = SLF.money.primary(total);
}
function addOrderItem(selectedId, quantity) {
  const menus = ctx.menusCache();
  const line = document.createElement('div');
  line.className = 'order-item-line';
  line.innerHTML = `
    <select>${menus.map(m => `<option value="${m.id}">${esc(m.emoji||'🍽️')} ${esc(m.name)} · ${SLF.money.primary(SLF.money.toBase(m.price, (m.currency_code||'USD')))}</option>`).join('')}</select>
    <input type="number" min="1" step="1" value="${quantity||1}">
    <button onclick="removeOrderItem(this)">✕</button>
  `;
  if (selectedId) line.querySelector('select').value = selectedId;
  line.querySelectorAll('select,input').forEach(el => {
    el.addEventListener('input', updateOrderTotal);
    el.addEventListener('change', updateOrderTotal);
  });
  $('#orderItems').appendChild(line);
  updateOrderTotal();
}
function addLockedOrderItem(item) {
  const line = document.createElement('div');
  line.className = 'order-item-line locked';
  line.dataset.status = 'done';
  line.innerHTML = `
    <select disabled><option value="${item.id}" selected>${esc(item.name)}</option></select>
    <input type="number" value="${item.quantity}" disabled>
    <span class="item-status done">${L('itemDone')}</span>
  `;
  $('#orderItems').appendChild(line);
  updateOrderTotal();
}

async function editOrder(id) {
  try {
    let orders = ctx.ordersCache();
    let o = orders.find(x => String(x.id) === String(id));
    if (!o) o = await api('/orders/' + id);
    if (!o) return;
    editingOrderId = id;
    editingOrderStatus = o.status || 'pending';
    $('#orderModalTitle').textContent = tAdmin('orderManage') + ' ' + (o.order_no || ('#'+id));
    $('#orderTable').value = o.table;
    $('#orderTable').disabled = true;
    $('#orderItems').innerHTML = '';
    o.items.forEach(item => {
      if (item.itemStatus === 'done') addLockedOrderItem(item);
      else addOrderItem(item.id, item.quantity);
    });
    $('#orderNoteField').value = o.note || '';
    updateOrderTotal();
    $('#orderModal').classList.add('open');
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

document.addEventListener('DOMContentLoaded', function() {
  const orderSaveBtn = document.getElementById('orderSaveBtn');
  if (orderSaveBtn) {
    orderSaveBtn.onclick = async function() {
      const rows = [...document.querySelectorAll('#orderItems .order-item-line')];
      const items = [];
      rows.forEach(row => {
        const id = +row.querySelector('select').value;
        const qty = +row.querySelector('input').value || 0;
        if (id && qty > 0) items.push({ id: id, quantity: qty });
      });
      if (!items.length) { SLF.ui.toast('❌ ' + tAdmin('noItems')); return; }
      try {
        await api(editingOrderId ? '/orders/' + editingOrderId : '/orders', { method: editingOrderId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: {
          table: $('#orderTable').value,
          note: $('#orderNoteField').value.trim(),
          items
        }});
        closeOrderForm();
        await loadOrders();
        SLF.ui.toast('✅ ' + tAdmin('orderManage') + ' ' + (editingOrderId ? tAdmin('updated') : tAdmin('added')));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
  const addOrderItemBtn = document.getElementById('addOrderItemBtn');
  if (addOrderItemBtn) addOrderItemBtn.onclick = function() { addOrderItem(); };
});

// 挂到 window
window.loadOrders = loadOrders;
window.setOrderFilter = setOrderFilter;
window.toggleItemStatus = toggleItemStatus;
window.showTransferModal = showTransferModal;
window.closeTransferModal = closeTransferModal;
window.confirmTransfer = confirmTransfer;
window.confirmSettleOrder = confirmSettleOrder;
window.closeSettleDetail = closeSettleDetail;
window.doSettleOrder = doSettleOrder;
window.confirmCancelOrder = confirmCancelOrder;
window.statusOrder = statusOrder;
window.removeOrder = removeOrder;
window.openOrderForm = openOrderForm;
window.closeOrderForm = closeOrderForm;
window.removeOrderItem = removeOrderItem;
window.updateOrderTotal = updateOrderTotal;
window.addOrderItem = addOrderItem;
window.addLockedOrderItem = addLockedOrderItem;
window.editOrder = editOrder;

})();
