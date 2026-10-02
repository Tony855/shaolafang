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
    // 从后端读取当前店铺的货币配置
    let prim = defaultCurrency;
    let sec = null;
    try {
      const ds = await api('/admin/display-settings');
      if (ds.primaryCurrencyCode) {
        prim = list.find(c => c.code === ds.primaryCurrencyCode) || defaultCurrency;
      }
      if (ds.secondaryCurrencyCode) {
        sec = list.find(c => c.code === ds.secondaryCurrencyCode) || null;
      }
    } catch (e) { console.warn('读 display-settings 失败', e); }
    SLF.money.configure({
      currencies: list,
      primaryCurrency: prim,
      secondaryCurrency: sec
    });
  }
  const defaultCode = defaultCurrency?.code || 'USD';
  $('#menuCurrency').innerHTML = list.map(c => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.symbol)} · ${esc(currencyNameText(c.name,c.code))}</option>`).join('');
  // 旧货币列表渲染已下线（统一走"系统设置 → 货币设置"卡片）
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

// 挂到 window
window.loadCurrencies = loadCurrencies;
window.currencyNameText = currencyNameText;
window.editCurrency = editCurrency;
window.closeCurrencyEdit = closeCurrencyEdit;
window.saveCurrencyEdit = saveCurrencyEdit;
window.setDefaultCurrency = setDefaultCurrency;
window.removeCurrency = removeCurrency;

})();
