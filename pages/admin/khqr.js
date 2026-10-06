/*
 * pages/admin/khqr.js — KHQR 收款码配置（多码列表版，按店铺隔离）
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;
const { api } = ctx;

const esc = SLF.utils.esc;
const tAdmin = (window.SLF && window.SLF.t) ? window.SLF.t : function(k){ return k; };

function getCurrentStoreName() {
  const sel = document.getElementById('adminStoreSelect');
  if (sel && sel.selectedIndex >= 0) return sel.options[sel.selectedIndex].text;
  return tAdmin('currentStoreFallback');
}

function updateCurrentStoreName() {
  const el = document.getElementById('khqrCurrentStoreName');
  if (el) el.textContent = getCurrentStoreName();
}

/* ---------- 渲染 provider 列表 ---------- */
function renderProviderList(providers) {
  const el = document.getElementById('khqrProviderList');
  if (!el) return;

  if (!providers || providers.length === 0) {
    el.innerHTML =
      '<div style="padding:14px 16px;background:rgba(255,193,7,.08);border:1px solid rgba(255,193,7,.25);border-radius:10px;color:#ffd93d;font-size:13px;">' +
        tAdmin('noKhqrConfigured') +
      '</div>';
    return;
  }

  el.innerHTML = providers.map(p => {
    const badgeDisabled = !p.enabled
      ? '<span style="display:inline-block;background:#777;color:#fff;padding:1px 6px;border-radius:6px;font-size:10px;font-weight:700;margin-left:6px;">' + tAdmin('disabledBadge') + '</span>'
      : '';
    const bg = p.enabled ? 'rgba(46,204,113,.06)' : 'rgba(255,255,255,.03)';
    const border = p.enabled ? 'rgba(46,204,113,.2)' : 'rgba(255,255,255,.08)';

    return `<div style="padding:8px 12px;background:${bg};border:1px solid ${border};border-radius:8px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
      <div class="khqr-icon-wrap" data-bank="${esc(p.bank || '')}" style="width:36px;height:36px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;font-size:18px;overflow:hidden;">📱</div>
      <div style="flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <span style="color:#fff;font-weight:600;font-size:13px;">${esc(p.label)}</span>
        ${badgeDisabled}
        <span style="color:#888;font-size:11px;">${esc(p.bank || '')} · ${esc(p.currency || '')} · ${esc(p.merchantName || '')}</span>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button data-action="toggle" data-id="${p.id}" style="padding:4px 10px;border:0;border-radius:6px;background:rgba(255,193,7,.15);color:#ffd93d;font-size:11px;font-weight:600;cursor:pointer;">${p.enabled ? tAdmin('disabled') : tAdmin('enabled')}</button>
        <button data-action="delete" data-id="${p.id}" style="padding:4px 10px;border:0;border-radius:6px;background:rgba(231,76,60,.15);color:#e74c3c;font-size:11px;font-weight:600;cursor:pointer;">删除</button>
      </div>
    </div>`;
  }).join('');

  // 绑定按钮
  el.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'toggle') toggleProvider(id);
      else if (action === 'delete') deleteProvider(id);
    });
  });

  // 加载银行图标
  const _BANK_ICON_MAP = { 'ABA': 'aba', 'ACLEDA': 'acleda', 'Bakong': 'KHQR', 'Wing': 'Wing' };
  const _ICON_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
  el.querySelectorAll('.khqr-icon-wrap').forEach(wrap => {
    const bank = wrap.dataset.bank || '';
    const key = _BANK_ICON_MAP[bank] || bank.toLowerCase().replace(/[^a-z0-9]/g, '');
    let _i = 0;
    function tryNext() {
      if (_i >= _ICON_EXTS.length) return;
      const url = '/assets/vendor/payment-icons/' + key + '.' + _ICON_EXTS[_i++];
      const img = new Image();
      img.onload = function() { wrap.innerHTML = '<img src="' + url + '" style="max-width:100%;max-height:100%;object-fit:contain;" alt="">'; };
      img.onerror = tryNext;
      img.src = url;
    }
    tryNext();
  });
}

/* ---------- 加载 provider 列表 ---------- */
async function loadKhqrInfo() {
  const card = document.getElementById('khqrSettingsCard');
  if (!card) return;
  updateCurrentStoreName();

  const sel = document.getElementById('adminStoreSelect');
  if (!sel || !sel.value) {
    renderProviderList([]);
    return;
  }

  try {
    const res = await api('/admin/khqr/providers');
    renderProviderList(res.providers || []);
  } catch (e) {
    console.warn('[khqr] 加载失败:', e.message);
    const el = document.getElementById('khqrProviderList');
    if (el) el.innerHTML =
      '<div style="padding:12px 16px;background:rgba(231,76,60,.1);border:1px solid rgba(231,76,60,.3);border-radius:10px;color:#e74c3c;font-size:14px;">⚠️ ' + esc(e.message) + '</div>';
  }
}

/* ---------- 上传新码 ---------- */
async function uploadKhqrImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  const label = (document.getElementById('khqrUploadLabel') || {}).value || '';
  fd.append('label', label.trim());

  const token = SLF.store.rawGetSession('adminToken') || '';
  const storeId = SLF.store.rawGetSession('adminStoreId') || SLF.store.rawGet('storeId') || '';
  if (!storeId) throw new Error(tAdmin('selectStoreFirst'));

  const res = await fetch('/api/admin/khqr/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'X-Store-Id': String(storeId) },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

/* ---------- 删除 / 设默认 / 切换 ---------- */
async function deleteProvider(id) {
  if (!confirm(tAdmin('confirmDeleteKhqr'))) return;
  try {
    await api('/admin/khqr/providers/' + id, { method: 'DELETE' });
    SLF.ui && SLF.ui.toast ? SLF.ui.toast('✅ ' + tAdmin('deleted')) : 0;
    await loadKhqrInfo();
  } catch (e) {
    SLF.ui && SLF.ui.toast ? SLF.ui.toast('❌ ' + e.message) : alert(e.message);
  }
}

async function setDefaultProvider(id) {
  try {
    await api('/admin/khqr/providers/' + id + '/default', { method: 'POST' });
    SLF.ui && SLF.ui.toast ? SLF.ui.toast(tAdmin('setAsDefaultDone')) : 0;
    await loadKhqrInfo();
  } catch (e) {
    SLF.ui && SLF.ui.toast ? SLF.ui.toast('❌ ' + e.message) : alert(e.message);
  }
}

async function toggleProvider(id) {
  try {
    await api('/admin/khqr/providers/' + id + '/toggle', { method: 'POST' });
    await loadKhqrInfo();
  } catch (e) {
    SLF.ui && SLF.ui.toast ? SLF.ui.toast('❌ ' + e.message) : alert(e.message);
  }
}

/* ---------- 绑定事件 ---------- */
function bindEvents() {
  const btn = document.getElementById('khqrUploadBtn');
  const input = document.getElementById('khqrImageFile');
  const nameEl = document.getElementById('khqrUploadName');
  if (!btn || !input || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', async function() {
    const file = input.files && input.files[0];
    if (!file) return;
    if (nameEl) nameEl.textContent = file.name;
    btn.disabled = true;
    btn.textContent = tAdmin('parsing');
    try {
      const data = await uploadKhqrImage(file);
      SLF.ui && SLF.ui.toast ? SLF.ui.toast(tAdmin('addedColon') + (data.provider && data.provider.label || '')) : 0;
      // 清空输入
      const labelEl = document.getElementById('khqrUploadLabel');
      if (labelEl) labelEl.value = '';
      await loadKhqrInfo();
    } catch (e) {
      SLF.ui && SLF.ui.toast ? SLF.ui.toast('❌ ' + e.message) : alert(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = tAdmin('chooseImageUpload');
      input.value = '';
      if (nameEl) nameEl.textContent = tAdmin('noFileSelected');
    }
  });
}

function init() {
  if (!document.getElementById('khqrSettingsCard')) return;
  bindEvents();
  loadKhqrInfo();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

document.addEventListener('change', function(e) {
  if (e.target && e.target.id === 'adminStoreSelect') {
    setTimeout(() => { updateCurrentStoreName(); loadKhqrInfo(); }, 200);
  }
});

document.addEventListener('click', function(e) {
  const nav = e.target && e.target.closest && e.target.closest('.nav-item');
  if (nav && nav.dataset && nav.dataset.module === 'password') {
    setTimeout(() => { updateCurrentStoreName(); loadKhqrInfo(); }, 100);
  }
}, true);

window.loadKhqrInfo = loadKhqrInfo;

})();
