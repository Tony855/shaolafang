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
      admin.setDualCurrency && admin.setDualCurrency(!!d.enabled);
      admin.setSecondaryCurrencyCode && admin.setSecondaryCurrencyCode(d.secondaryCurrencyCode || 'USD');
      $('#dualCurrencyEnabled').checked = admin.dualCurrencyEnabled();
      $('#dualCurrencySelect').value = admin.secondaryCurrencyCode();
    }
    const config = await SLF.api.get('/public/config');
    if (config) {
      admin.setDefaultCurrencyObj && admin.setDefaultCurrencyObj(config.defaultCurrency || { symbol: '$', rate: 1, code: 'USD' });
    }
    SLF.money.configure({
      currencies: admin.currenciesCache(),
      defaultCurrency: admin.defaultCurrencyObj(),
      dualCurrency: { enabled: admin.dualCurrencyEnabled(), currency: admin.secondaryCurrencyCode() ? { code: admin.secondaryCurrencyCode() } : null }
    });
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
        await SLF.api.post('/admin/display-settings', {
          enabled: $('#dualCurrencyEnabled').checked,
          secondaryCurrencyCode: $('#dualCurrencySelect').value
        });
        await loadDisplaySettings();
        await loadOrderPrefixes();
        if (window.loadMenus) await window.loadMenus();
        SLF.ui.toast('✅ ' + tAdmin('displaySettingsSaved'));
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
