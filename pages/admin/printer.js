/*
 * pages/admin/printer.js — 打印机管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, showConfirm, L } = ctx;

async function loadPrinters() {
  try {
    const data = await api('/admin/printers');
    window._adminPrinters = data;
    const container = $('#printersList');
    if (!data || data.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:40px;color:#c8c8d0;">${tAdmin('noPrinterHint')}</div>`;
      return;
    }
    const typeMap = { network: tAdmin('networkPrinter'), usb: 'USB', bluetooth: tAdmin('bluetoothPrinter') };
    container.innerHTML = data.map(p => `
        <div class="admin-card">
            <div class="info">
                <div class="title">🖨️ ${esc(p.name)} ${p.is_default ? `<span style="background:#ffd93d;color:#333;padding:2px 10px;border-radius:10px;font-size:12px;margin-left:8px;font-weight:600;">${tAdmin('defaultPrinter')}</span>` : ''} ${p.store_name ? `<span style="background:rgba(52,152,219,.15);color:#5dade2;padding:2px 10px;border-radius:10px;font-size:12px;margin-left:8px;font-weight:600;">🏪 ${esc(p.store_name)}</span>` : ''}</div>
                <div class="sub">${typeMap[p.type] || esc(p.type)} · ${esc(p.brand)} · ${esc(p.paper_width)}mm${p.ip_address ? ' · ' + esc(p.ip_address) + ':' + esc(p.port) : ''}</div>
            </div>
            <div class="printer-controls">
                <label class="printer-switch-label">
                    <span class="printer-switch-text ${p.active ? 'on' : 'off'}">${p.active ? tAdmin('enabled') : tAdmin('disabled')}</span>
                    <label class="store-switch">
                        <input type="checkbox" ${p.active ? 'checked' : ''} onchange="togglePrinter(${p.id}, this.checked ? 1 : 0)">
                        <span class="store-switch-slider"></span>
                    </label>
                </label>
                <div class="actions">
                    ${hasPermission('can_manage_printer') ? '<button class="copy" onclick="testPrinter(' + p.id + ')">' + tAdmin('testPrint') + '</button>' : ''}
                    <button class="edit-btn" onclick="openPrinterEdit(${p.id})">${L('edit')}</button>
                    ${!p.is_default ? `<button onclick="setDefaultPrinter(${p.id})">${tAdmin('setDefaultPrinter')}</button>` : ''}
                    ${hasPermission('can_manage_printer') ? '<button class="danger" onclick="deletePrinter(' + p.id + ')">' + L('delete') + '</button>' : ''}
                </div>
            </div>
        </div>
    `).join('');
  } catch (err) { SLF.ui.toast(`${tAdmin('loadPrinterFailed')}: ` + err.message); }
}

async function addPrinter() {
  const name = $('#printerName').value.trim();
  if (!name) { SLF.ui.toast(tAdmin('printerNameRequired')); return; }
  try {
    await api('/admin/printers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {
      name, type: $('#printerType').value, ip_address: $('#printerIp').value.trim(),
      port: parseInt($('#printerPort').value) || 9100, paper_width: parseInt($('#printerWidth').value) || 58,
      brand: $('#printerBrand').value, is_default: $('#printerDefault').checked
    }});
    SLF.ui.toast(tAdmin('printerAdded'));
    $('#printerName').value = '';
    $('#printerIp').value = '';
    $('#printerDefault').checked = false;
    loadPrinters();
  } catch (err) { SLF.ui.toast(tAdmin('addFailed') + ': ' + err.message); }
}

async function testPrinter(id) {
  try {
    await api('/admin/printers/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { printer_id: id } });
    SLF.ui.toast(tAdmin('testPrintSent'));
  } catch (err) { SLF.ui.toast(tAdmin('printFailed') + ': ' + err.message); }
}

function openPrinterEdit(id) {
  const printers = window._adminPrinters || [];
  const p = printers.find(x => String(x.id) === String(id));
  if (!p) return;
  $('#editPrinterId').value = p.id;
  $('#editPrinterName').value = p.name || '';
  $('#editPrinterType').value = p.type || 'network';
  $('#editPrinterIp').value = p.ip_address || '';
  $('#editPrinterPort').value = p.port || 9100;
  $('#editPrinterWidth').value = p.paper_width || 58;
  $('#editPrinterBrand').value = p.brand || 'generic';
  $('#editPrinterDefault').checked = !!p.is_default;
  $('#printerEditModal').classList.add('open');
}

function closePrinterEdit() { $('#printerEditModal').classList.remove('open'); }

async function savePrinterEdit() {
  const id = parseInt($('#editPrinterId').value);
  const name = $('#editPrinterName').value.trim();
  if (!name) { SLF.ui.toast(tAdmin('printerNameRequired')); return; }
  try {
    await api('/admin/printers/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: {
      name, type: $('#editPrinterType').value, ip_address: $('#editPrinterIp').value.trim(),
      port: parseInt($('#editPrinterPort').value) || 9100, paper_width: parseInt($('#editPrinterWidth').value) || 58,
      brand: $('#editPrinterBrand').value, is_default: $('#editPrinterDefault').checked
    }});
    SLF.ui.toast(tAdmin('saveSuccess') || '保存成功');
    closePrinterEdit();
    loadPrinters();
  } catch (err) { SLF.ui.toast(tAdmin('saveFailed') + ': ' + err.message); }
}

async function togglePrinter(id, active) {
  try {
    await api('/admin/printers/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { active } });
    loadPrinters();
  } catch (err) { SLF.ui.toast(tAdmin('operationFailed') + ': ' + err.message); }
}

async function setDefaultPrinter(id) {
  try {
    await api('/admin/printers/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { is_default: true } });
    SLF.ui.toast(tAdmin('setAsDefaultPrinter'));
    loadPrinters();
  } catch (err) { SLF.ui.toast(tAdmin('operationFailed') + ': ' + err.message); }
}

function deletePrinter(id) {
  showConfirm(tAdmin('confirmDeletePrinter'), async function() {
    try {
      await api('/admin/printers/' + id, { method: 'DELETE' });
      SLF.ui.toast(tAdmin('printerDeleted'));
      loadPrinters();
    } catch (err) { SLF.ui.toast(`${tAdmin('deleteFailed')}: ` + err.message); }
  });
}

async function printOrder(orderId) {
  try {
    const data = await api('/orders/' + orderId + '/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {} });
    if (data.printed) SLF.ui.toast(tAdmin('orderPrinted'));
    else if (data.printData) {
      // 从缓存找订单，用于展示订单号
      const list = ctx.ordersCache ? ctx.ordersCache() : [];
      const ord = list.find(o => String(o.id) === String(orderId)) || {};
      ord._store = data.store || null;
      SLF.ui.toast(tAdmin('openingBrowserPrint'));
      printViaBrowser(data.printData, ord);
    }
  } catch (err) { SLF.ui.toast(tAdmin('printFailed') + ': ' + err.message); }
}

function printViaBrowser(base64Data, orderOrId) {
  const order = (typeof orderOrId === 'object' && orderOrId) ? orderOrId : {};
  const orderNo = order.order_no || (order.id ? ('#' + order.id) : '#?');
  const tableNo = order.table_name || order.table || '-';
  const items = Array.isArray(order.items) ? order.items : [];
  const note = order.note || '';
  const total = Number(order.total) || 0;

  // 时间格式化
  let timeStr = '';
  try {
    const d = order.createdAt ? new Date(order.createdAt) : new Date();
    const pad = n => String(n).padStart(2, '0');
    timeStr = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch (e) {}

  // 货币格式化（主币）
  const fmt = v => {
    try { return SLF.money.primary(v); } catch (e) { return '$' + Number(v || 0).toFixed(2); }
  };
  const baseOf = (item) => {
    try { return SLF.money.toBase(item.price, item.currency_code); } catch (e) { return Number(item.price) || 0; }
  };

  // 菜品行
  let itemsHtml = '';
  items.forEach(item => {
    const qty = Number(item.quantity) || 0;
    const ret = Number(item.returnedQty) || 0;
    const realQty = qty - ret;
    const unitBase = baseOf(item);
    const lineBase = unitBase * realQty;
    const name = (item.name || '').slice(0, 20);
    const retTag = ret > 0 ? ' <span style="color:#e74c3c;">(退' + ret + ')</span>' : '';
    itemsHtml +=
      '<div class="row">' +
        '<span class="item-name">' + esc(name) + ' ×' + qty + retTag + '</span>' +
        '<span class="item-amt">' + fmt(lineBase) + '</span>' +
      '</div>';
  });

  // 备注
  const noteHtml = note ? '<div class="separator"></div><div class="note">' + esc(tAdmin('orderNoteDisplay')) + ': ' + esc(note) + '</div>' : '';

  // 支付方式（可选）
  const payLabel = {
    cash: 'Cash', wechat: 'WeChat', alipay: 'Alipay',
    card: 'Card', aba: 'ABA',
  }[order.pay_method] || '';
  const payHtml = payLabel ? '<div class="row"><span>' + tAdmin('cashier') + '</span><span>' + payLabel + '</span></div>' : '';

  // 店铺名（优先），无则用品牌名
  const storeName = (order._store && order._store.name) ? order._store.name : (tAdmin('brandName') || 'FoodFlow');
  const storeAddr = (order._store && order._store.address) ? order._store.address : '';
  const storePhone = (order._store && order._store.phone) ? order._store.phone : '';

  const html =
    '<html><head><meta charset="UTF-8"><title>' + esc(orderNo) + '</title>' +
    '<style>' +
    '*{box-sizing:border-box}' +
    'body{font-family:"Courier New",monospace;font-size:13px;padding:10px;width:300px;margin:0 auto;color:#000;}' +
    '.center{text-align:center;}' +
    '.big{font-size:18px;font-weight:bold;}' +
    '.sub{font-size:12px;color:#555;}' +
    '.separator{border-top:1px dashed #000;margin:8px 0;}' +
    '.row{display:flex;justify-content:space-between;padding:2px 0;align-items:baseline;}' +
    '.item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;}' +
    '.item-amt{white-space:nowrap;font-weight:bold;}' +
    '.total{font-size:16px;font-weight:bold;padding-top:6px;}' +
    '.note{font-size:12px;padding:4px 0;line-height:1.4;}' +
    '.footer{text-align:center;font-size:12px;color:#555;padding-top:8px;}' +
    '</style></head><body onload="window.print();setTimeout(function(){window.close()},800);">' +
      '<div class="center big">' + esc(storeName) + '</div>' +
      (storeAddr ? '<div class="center sub">' + esc(storeAddr) + '</div>' : '') +
      (storePhone ? '<div class="center sub">' + esc(storePhone) + '</div>' : '') +
      '<div class="center sub">' + esc(tAdmin('table') || 'Table') + ': ' + esc(tableNo) + '</div>' +
      '<div class="center sub">' + esc(tAdmin('order') || 'Order') + ': ' + esc(orderNo) + '</div>' +
      (timeStr ? '<div class="center sub">' + timeStr + '</div>' : '') +
      '<div class="separator"></div>' +
      itemsHtml +
      noteHtml +
      '<div class="separator"></div>' +
      '<div class="row total"><span>' + (tAdmin('total') || 'Total') + '</span><span>' + fmt(total) + '</span></div>' +
      (payHtml ? '<div class="separator"></div>' + payHtml : '') +
      '<div class="footer">' + esc(tAdmin('printerConnectHint') || '') + '</div>' +
    '</body></html>';

  const printWindow = window.open('', '_blank', 'width=320,height=600');
  if (!printWindow) { SLF.ui.toast(tAdmin('allowPopupToPrint')); return; }
  printWindow.document.write(html);
  printWindow.document.close();
}

document.addEventListener('DOMContentLoaded', async function() {
  // ===== 后厨单开关 =====
  const toggle = document.getElementById('autoPrintToggle');
  if (toggle) {
    try {
      const data = await SLF.api.get('/admin/settings/auto-print?type=kitchen');
      toggle.checked = !!(data && data.enabled);
    } catch (e) {
      console.warn('读取后厨自动打印开关失败', e);
      toggle.checked = false;
    }
  }

  // ===== 收银小票开关 =====
  const toggleReceipt = document.getElementById('autoPrintReceiptToggle');
  if (toggleReceipt) {
    try {
      const data = await SLF.api.get('/admin/settings/auto-print?type=receipt');
      toggleReceipt.checked = !!(data && data.enabled);
    } catch (e) {
      console.warn('读取收银自动打印开关失败', e);
      toggleReceipt.checked = false;
    }
  }
});

// 挂到 window
window.printOrder = printOrder;
window.printViaBrowser = printViaBrowser;
window.loadPrinters = loadPrinters;
window.addPrinter = addPrinter;
window.testPrinter = testPrinter;
window.openPrinterEdit = openPrinterEdit;
window.closePrinterEdit = closePrinterEdit;
window.savePrinterEdit = savePrinterEdit;
window.togglePrinter = togglePrinter;
window.setDefaultPrinter = setDefaultPrinter;
window.deletePrinter = deletePrinter;

})();
