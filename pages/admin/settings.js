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
  } catch (e) {}
}
async function saveOrderPrefixes() {
  try {
    await SLF.api.post('/admin/order-prefixes', {
      normal: $('#prefixNormal').value,
      refund: $('#prefixRefund').value,
      discount: $('#prefixDiscount').value,
      vip: $('#prefixVip').value,
      daily_reset: 'daily'
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
