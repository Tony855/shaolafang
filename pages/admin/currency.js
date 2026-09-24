/*
 * pages/admin/currency.js — 货币管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, showConfirm } = ctx;

let editingCurrencyId = null;

function currencyNameText(name, code) {
  const map = {
    en: { USD: 'US Dollar', CNY: 'Chinese Yuan', VND: 'Vietnamese Dong', THB: 'Thai Baht', KHR: 'Cambodian Riel' },
    vi: { USD: 'Đô la Mỹ', CNY: 'Nhân dân tệ', VND: 'Đồng', THB: 'Bạt Thái', KHR: 'Riel' },
    th: { USD: 'ดอลลาร์สหรัฐ', CNY: 'หยวนจีน', VND: 'ดองเวียดนาม', THB: 'บาทไทย', KHR: 'เรียลกัมพูชา' },
    km: { USD: 'ដុល្លារអាមេរិក', CNY: 'យ័នចិន', VND: 'ដុងវៀតណាម', THB: 'បាតថៃ', KHR: 'រៀលខ្មែរ' },
    zh: { USD: '美元', CNY: '人民币', VND: '越南盾', THB: '泰铢', KHR: '柬埔寨瑞尔' }
  };
  return (map[SLF.store.rawGet('adminLang') || 'zh'] && map[SLF.store.rawGet('adminLang') || 'zh'][code]) || name;
}

async function loadCurrencies() {
  const list = await api('/currencies');
  if (window.SLF.admin.setCurrencies) window.SLF.admin.setCurrencies(list);
  const defaultCurrency = list.find(c => c.is_default) || list[0] || null;
  // 配置 SLF.money
  if (typeof SLF !== 'undefined' && SLF.money) {
    SLF.money.configure({
      currencies: list,
      defaultCurrency: defaultCurrency,
      dualCurrency: {
        enabled: (window.SLF.admin.dualCurrencyEnabled ? window.SLF.admin.dualCurrencyEnabled() : false),
        currency: (window.SLF.admin.secondaryCurrencyCode ? window.SLF.admin.secondaryCurrencyCode() : '') ? { code: (window.SLF.admin.secondaryCurrencyCode ? window.SLF.admin.secondaryCurrencyCode() : '') } : null
      }
    });
  }
  const defaultCode = defaultCurrency?.code || 'USD';
  $('#menuCurrency').innerHTML = list.map(c => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.symbol)} · ${esc(currencyNameText(c.name,c.code))}</option>`).join('');
  $('#dualCurrencySelect').innerHTML = list.map(c => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.symbol)}</option>`).join('');
  $('#menuSecondaryCurrency').innerHTML = list.map(c => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.symbol)}</option>`).join('');
  $('#currencies').innerHTML = list.map(c => `
      <div class="row">
        <div><b>${esc(c.code)} ${esc(c.symbol)}</b><small>${esc(currencyNameText(c.name,c.code))} · ${tAdmin('currencyRateLabel')} ${esc(c.rate)}${c.is_default ? ` · ${tAdmin('default')}` : ''}</small></div>
        <div class="actions">
          ${c.is_default ? '' : `<button onclick="setDefaultCurrency(${c.id})">${tAdmin('setDefault')}</button>`}
          ${hasPermission('can_manage_currency') ? '<button onclick="editCurrency(' + c.id + ')">' + ctx.L('edit') + '</button>' : ''}
          ${hasPermission('can_manage_currency') ? '<button class="danger" onclick="removeCurrency(' + c.id + ')">' + ctx.L('delete') + '</button>' : ''}
        </div>
      </div>
    `).join('') || `<div class="empty-hint">${tAdmin('noData')}</div>`;
  return list;
}

async function editCurrency(id) {
  const data = await api('/currencies');
  const c = data.find(x => String(x.id) === String(id));
  if (!c) return;
  editingCurrencyId = id;
  $('#editCurrencyId').value = id;
  $('#editCurrencyCode').value = c.code || '';
  $('#editCurrencyName').value = c.name || '';
  $('#editCurrencySymbol').value = c.symbol || '';
  $('#editCurrencyRate').value = c.rate || 1;
  $('#currencyEditTitle').textContent = tAdmin('editCurrency') + ' - ' + (c.code || '');
  $('#currencyEditModal').classList.add('open');
}

function closeCurrencyEdit() { $('#currencyEditModal').classList.remove('open'); editingCurrencyId = null; }

async function saveCurrencyEdit() {
  const id = editingCurrencyId;
  if (!id) return;
  const name = $('#editCurrencyName').value.trim();
  const symbol = $('#editCurrencySymbol').value.trim();
  const rate = parseFloat($('#editCurrencyRate').value) || 1;
  try {
    await api('/currencies/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { name, symbol, rate } });
    closeCurrencyEdit();
    await loadCurrencies();
    SLF.ui.toast('✅ ' + tAdmin('currencyManageTitle') + ' ' + tAdmin('updated'));
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

async function setDefaultCurrency(id) {
  const data = await api('/currencies');
  const c = data.find(x => String(x.id) === String(id));
  try {
    await api('/currencies/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { ...c, is_default: true } });
    await loadCurrencies();
    SLF.ui.toast('✅ ' + tAdmin('currencyManageTitle') + ' ' + tAdmin('updated'));
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

function removeCurrency(id) {
  showConfirm(tAdmin('confirmDelete'), async function() {
    try {
      await api('/currencies/' + id, { method: 'DELETE' });
      await loadCurrencies();
      SLF.ui.toast('✅ ' + tAdmin('deleted'));
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  });
}

document.addEventListener('DOMContentLoaded', function() {
  const currencyForm = document.getElementById('currencyForm');
  if (currencyForm) {
    currencyForm.onsubmit = async function(e) {
      e.preventDefault();
      try {
        await api('/currencies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {
          code: $('#currencyCode').value,
          symbol: $('#currencySymbol').value,
          name: $('#currencyName').value,
          rate: +$('#currencyRate').value
        }});
        e.target.reset();
        await loadCurrencies();
        SLF.ui.toast('✅ ' + tAdmin('currencyManageTitle') + ' ' + tAdmin('added'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
});

// 挂到 window
window.loadCurrencies = loadCurrencies;
window.currencyNameText = currencyNameText;
window.editCurrency = editCurrency;
window.closeCurrencyEdit = closeCurrencyEdit;
window.saveCurrencyEdit = saveCurrencyEdit;
window.setDefaultCurrency = setDefaultCurrency;
window.removeCurrency = removeCurrency;

})();
