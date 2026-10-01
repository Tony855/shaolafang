/*
 * pages/admin/settings.js — 显示设置模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, tAdmin, L } = ctx;

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
  const D = window.SLF && window.SLF.admin;
  if (!D) return;
  const api = D.api;

  async function loadDisplayPageSettings() {
    try {
      const s = await api('/admin/display-page-settings');
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      setVal('dispMode', s.mode || 'grid');
      setVal('dispOrder', s.order || 'default');
      setVal('dispImageDuration', s.image_duration || 8);
      setVal('dispVideoMode', s.video_mode || 'full');
      setVal('dispVideoDuration', s.video_duration || 15);
      setChk('dispOnlyActive', s.only_active);
      setChk('dispShowPrice', s.show_price);
      setChk('dispShowDesc', s.show_desc);
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
        show_desc: g('dispShowDesc').checked ? 1 : 0
      }});
      if (SLF.ui && SLF.ui.toast) SLF.ui.toast('✅ 展示页设置已保存');
    } catch (e) {
      if (SLF.ui && SLF.ui.toast) SLF.ui.toast('❌ 保存失败: ' + e.message);
    }
  }

  window.loadDisplayPageSettings = loadDisplayPageSettings;
  window.saveDisplayPageSettings = saveDisplayPageSettings;

  document.addEventListener('DOMContentLoaded', function() {
    const btn = document.getElementById('saveDisplayPageBtn');
    if (btn) btn.onclick = saveDisplayPageSettings;
    const origSwitch = window.switchAdminModule;
    if (typeof origSwitch === 'function' && !window._dispPageHooked) {
      window._dispPageHooked = true;
      window.switchAdminModule = function(m) {
        const r = origSwitch.apply(this, arguments);
        if (m === 'password' || m === 'currencies') {
          try { loadDisplayPageSettings(); } catch (e) {}
        }
        return r;
      };
    }
  });
})();
