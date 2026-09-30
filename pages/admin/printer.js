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
                <div class="title">🖨️ ${esc(p.name)} ${p.is_default ? `<span style="background:#ffd93d;color:#333;padding:2px 10px;border-radius:10px;font-size:12px;margin-left:8px;font-weight:600;">${tAdmin('defaultPrinter')}</span>` : ''}</div>
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
    else if (data.printData) { SLF.ui.toast(tAdmin('openingBrowserPrint')); printViaBrowser(data.printData, orderId); }
  } catch (err) { SLF.ui.toast(tAdmin('printFailed') + ': ' + err.message); }
}

function printViaBrowser(base64Data, orderId) {
  const printWindow = window.open('', '_blank', 'width=300,height=600');
  if (!printWindow) { SLF.ui.toast(tAdmin('allowPopupToPrint')); return; }
  printWindow.document.write(
    '<html><head><title>' + tAdmin('order') + ' #' + orderId + ' ' + tAdmin('print') + '</title>' +
    '<style>body { font-family: monospace; font-size: 12px; padding: 10px; width: 280px; } .center { text-align: center; } .bold { font-weight: bold; } .big { font-size: 16px; font-weight: bold; } .separator { border-top: 1px dashed #000; margin: 8px 0; } .row { display: flex; justify-content: space-between; }</style>' +
    '</head>' +
    '<body onload="window.print();setTimeout(()=>window.close(),500);">' +
    '<div class="center big">' + tAdmin('brandName') + '</div>' +
    '<div class="center">' + tAdmin('order') + ' #' + orderId + '</div>' +
    '<div class="separator"></div>' +
    '<p>' + tAdmin('printerConnectHint') + '</p>' +
    '</body></html>'
  );
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
