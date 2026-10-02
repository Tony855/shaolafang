/*
 * pages/admin/settings.js — 显示设置模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;


const { $, esc, hasPermission, showConfirm } = ctx;

// tAdmin / L 动态取：admin.js 后加载，会覆盖 ctx.tAdmin，所以不能提前解构
function tAdmin(key, fb) {
  const fn = (window.SLF && window.SLF.admin && window.SLF.admin.tAdmin) || ctx.tAdmin;
  return fn ? fn(key, fb) : fb;
}
function L(key) {
  const fn = (window.SLF && window.SLF.admin && window.SLF.admin.L) || ctx.L;
  return fn ? fn(key) : key;
}

async function loadDisplaySettings() {
  try {
    const d = await SLF.api.get('/admin/display-settings');
    const admin = window.SLF.admin;
    if (d) {
      admin.setDualCurrency && admin.setDualCurrency(!!d.secondaryCurrencyCode);
      admin.setSecondaryCurrencyCode && admin.setSecondaryCurrencyCode(d.secondaryCurrencyCode || '');
    }
    // 填充两个下拉
    const list = admin.currenciesCache ? admin.currenciesCache() : [];
    const primarySel = document.getElementById('dispPrimaryCurrency');
    const secondarySel = document.getElementById('dispSecondaryCurrency');
    if (primarySel) {
      primarySel.innerHTML = list.map(c =>
        `<option value="${c.code}">${c.code} · ${c.symbol} · ${c.name}</option>`
      ).join('');
      primarySel.value = d.primaryCurrencyCode || 'USD';
    }
    if (secondarySel) {
      secondarySel.innerHTML = '<option value="">— 不显示副货币 —</option>' +
        list.map(c => `<option value="${c.code}">${c.code} · ${c.symbol} · ${c.name}</option>`).join('');
      secondarySel.value = d.secondaryCurrencyCode || '';
    }
    // 显示当前店铺名
    const sel = document.getElementById('adminStoreSelect');
    const el = document.getElementById('currencyCurrentStoreName');
    if (sel && el && sel.selectedIndex >= 0) el.textContent = sel.options[sel.selectedIndex].text;
    return;
    const config = await SLF.api.get('/public/config');
    if (config) {
      admin.setDefaultCurrencyObj && admin.setDefaultCurrencyObj(config.defaultCurrency || { symbol: '$', rate: 1, code: 'USD' });
    }
    // 从 display-settings 读主/副币
    try {
      const ds = await SLF.api.get('/admin/display-settings');
      const list = admin.currenciesCache ? admin.currenciesCache() : [];
      const prim = ds.primaryCurrencyCode ? (list.find(c => c.code === ds.primaryCurrencyCode) || admin.defaultCurrencyObj()) : admin.defaultCurrencyObj();
      const sec = ds.secondaryCurrencyCode ? (list.find(c => c.code === ds.secondaryCurrencyCode) || null) : null;
      SLF.money.configure({
        currencies: list,
        primaryCurrency: prim,
        secondaryCurrency: sec
      });
    } catch (e) { console.warn('货币配置失败', e); }
  } catch (e) { console.warn('加载货币配置失败', e); }
}

async function loadOrderPrefixes() {
  try {
    const d = await SLF.api.get('/admin/order-prefixes');
    $('#prefixNormal').value = d.order_prefix_normal || '11';
    $('#prefixRefund').value = d.order_prefix_refund || '01';
    $('#prefixDiscount').value = d.order_prefix_discount || '21';
    $('#prefixVip').value = d.order_prefix_vip || '61';
    $('#orderResetPeriod').value = d.order_no_reset_period || 'never';
  } catch (e) {}
}
async function saveOrderPrefixes() {
  try {
    await SLF.api.post('/admin/order-prefixes', {
      normal: $('#prefixNormal').value,
      refund: $('#prefixRefund').value,
      discount: $('#prefixDiscount').value,
      vip: $('#prefixVip').value,
      daily_reset: $('#orderResetPeriod').value
    });
    SLF.ui.toast(L('saveSuccess') || '保存成功');
  } catch (e) {
    SLF.ui.toast(L('operationFailed') || '保存失败');
  }
}
async function loadNotificationSettings() {
  try {
    const d = await SLF.api.get('/admin/notification-settings');
    if (d) $('#newOrderSoundEnabled').checked = !!d.enabled;
  } catch (e) { console.warn('加载提示音设置失败', e); }
}

document.addEventListener('DOMContentLoaded', function() {
  const saveDisplaySettingsBtn = document.getElementById('saveDisplaySettingsBtn');
  if (saveDisplaySettingsBtn) {
    saveDisplaySettingsBtn.onclick = async function() {
      try {
        const applyAll = await SLF.ui.confirm(
          tAdmin('applyToAllStoresMsg') || '是否应用到本商户的所有店铺？\n确定 = 应用到所有店铺，取消 = 仅当前店铺',
          tAdmin('applyAll') || '应用到全部',
          tAdmin('onlyCurrent') || '仅当前店铺'
        );
        await SLF.api.post('/admin/display-settings', {
          primaryCurrencyCode: $('#dispPrimaryCurrency').value,
          secondaryCurrencyCode: $('#dispSecondaryCurrency').value,
          applyAll: applyAll
        });
        await loadDisplaySettings();
        await loadOrderPrefixes();
        if (window.loadMenus) await window.loadMenus();
        SLF.ui.toast('✅ ' + tAdmin('displaySettingsSaved') + (applyAll ? ' (' + (tAdmin('allStores') || '所有店铺') + ')' : ''));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
  const saveNotifySettingsBtn = document.getElementById('saveNotifySettingsBtn');
  if (saveNotifySettingsBtn) {
    saveNotifySettingsBtn.onclick = async function() {
      try {
        await SLF.api.post('/admin/notification-settings', { enabled: document.getElementById('newOrderSoundEnabled').checked });
        SLF.ui.toast('✅ ' + tAdmin('notifySettingsSaved'));
        await loadNotificationSettings();
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
});

// 挂到 window
window.loadDisplaySettings = loadDisplaySettings;
window.loadOrderPrefixes = loadOrderPrefixes;
window.saveOrderPrefixes = saveOrderPrefixes;
window.loadNotificationSettings = loadNotificationSettings;

})();

/* ===== 展示页设置（追加） ===== */
(function() {

  /* 本 IIFE 内 tAdmin 兜底 */
  const tAdmin = function(key, fb) {
    try {
      const a = window.SLF && window.SLF.admin;
      if (a && typeof a.tAdmin === 'function') {
        const v = a.tAdmin(key);
        if (v && v !== key) return v;
      }
      const v2 = window.SLF && window.SLF.i18n && window.SLF.i18n.t(key);
      if (v2 && v2 !== key) return v2;
    } catch (e) {}
    return fb !== undefined ? fb : key;
  };
  const L = function(key) { return tAdmin(key); };

  const D = window.SLF && window.SLF.admin;
  if (!D) return;
  const api = D.api;

  async function loadDisplayPageSettings() {
    try {
      // 显示当前店铺名
      try {
        const sel = document.getElementById('adminStoreSelect');
        const el = document.getElementById('dispCurrentStoreName');
        if (sel && el && sel.selectedIndex >= 0) {
          el.textContent = sel.options[sel.selectedIndex].text;
        }
      } catch (e) {}

      const s = await api('/admin/display-page-settings');
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = (v === 1 || v === '1' || v === true); };
      setVal('dispMode', s.mode || 'grid');
      setVal('dispOrder', s.order || 'default');
      setVal('dispImageDuration', (s.image_duration !== undefined && s.image_duration !== null) ? s.image_duration : 8);
      setVal('dispVideoMode', s.video_mode || 'full');
      setVal('dispVideoDuration', (s.video_duration !== undefined && s.video_duration !== null) ? s.video_duration : 15);
      setChk('dispOnlyActive', s.only_active);
      setChk('dispShowPrice', s.show_price);
      setChk('dispShowDesc', s.show_desc);
      try {
        const langs = JSON.parse(s.languages || '["zh"]');
        document.querySelectorAll('#dispLanguages input[type="checkbox"]').forEach(cb => {
          cb.checked = langs.includes(cb.value);
        });
      } catch (e) {}

    } catch (e) { console.warn('load display-page-settings failed', e); }
  }

  async function saveDisplayPageSettings() {
    const g = id => document.getElementById(id);
    try {
      await api('/admin/display-page-settings', { method: 'POST', body: {
        mode: g('dispMode').value,
        order: g('dispOrder').value,
        image_duration: parseInt(g('dispImageDuration').value, 10) || 8,
        video_mode: g('dispVideoMode').value,
        video_duration: parseInt(g('dispVideoDuration').value, 10) || 15,
        only_active: g('dispOnlyActive').checked ? 1 : 0,
        show_price: g('dispShowPrice').checked ? 1 : 0,
        show_desc: g('dispShowDesc').checked ? 1 : 0,
        languages: JSON.stringify(
          Array.from(document.querySelectorAll('#dispLanguages input[type="checkbox"]'))
            .filter(cb => cb.checked).map(cb => cb.value)
        )
      }});
      if (SLF.ui && SLF.ui.toast) SLF.ui.toast('✅ ' + (tAdmin('displaySettingsSaved') || '展示页设置已保存'));
    } catch (e) {
      if (SLF.ui && SLF.ui.toast) SLF.ui.toast('❌ ' + (tAdmin('saveFailed') || '保存失败') + ': ' + e.message);
    }
  }

  window.loadDisplayPageSettings = loadDisplayPageSettings;
  window.saveDisplayPageSettings = saveDisplayPageSettings;

  async function applyDisplayPageToAll() {
    // 1) 先保存当前店铺
    try {
      await saveDisplayPageSettings();
    } catch (e) { /* 忽略 save 里已经 toast */ }

    // 2) 二次确认
    const ok = await SLF.ui.confirm(
      '确定把当前店铺的展示页设置应用到本商户所有其它店铺？\n\n⚠️ 会覆盖其它店铺已有的展示页配置',
      '确定应用', '取消'
    );
    if (!ok) return;

    // 3) 调用接口
    try {
      const r = await api('/admin/display-page-settings/apply-all', { method: 'POST' });
      SLF.ui.toast('✅ 已应用到 ' + (r.appliedTo || 0) + ' 个店铺');
    } catch (e) {
      SLF.ui.toast('❌ 应用失败: ' + e.message);
    }
  }
  window.applyDisplayPageToAll = applyDisplayPageToAll;

  // 事件委托：不依赖 DOMContentLoaded，也不怕 DOM 被重建
  document.addEventListener('click', function(e) {
    const t = e.target;
    const btn = t && t.closest && t.closest('#saveDisplayPageBtn');
    if (!btn) return;
    e.preventDefault();
    saveDisplayPageSettings();
  }, true);

  // 监听"系统设置"模块变可见时，自动加载配置
  // 页面加载后直接调一次（不管是否切到系统设置）
  function bootLoadDisplayPageSettings() {
    try { loadDisplayPageSettings(); } catch (e) { console.warn('boot load:', e); }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootLoadDisplayPageSettings);
  } else {
    setTimeout(bootLoadDisplayPageSettings, 300);
  }

  // 切到"系统设置"模块时再刷一次（覆盖多店铺场景）
  document.addEventListener('click', function(e) {
    const nav = e.target && e.target.closest && e.target.closest('.nav-item');
    if (nav && nav.dataset && nav.dataset.module === 'password') {
      setTimeout(function() { try { loadDisplayPageSettings(); } catch (er) {} }, 100);
    }
  }, true);
})();
