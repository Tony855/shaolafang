/*
 * pages/admin/order.js — 订单核心模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, L, setOrders, buildSessionLabels } = ctx;

let orderTableFilter = '';

function setOrderFilter(q) {
  orderTableFilter = q;
  loadOrders();
}

async function loadOrders() {
  const orders = await api('/orders');
  setOrders(orders);
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

// 挂到 window
window.loadOrders = loadOrders;
window.setOrderFilter = setOrderFilter;

})();
