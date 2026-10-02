/*
 * pages/admin/khqr.js — KHQR 收款码配置（多码列表版，按店铺隔离）
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;
const { api } = ctx;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function getCurrentStoreName() {
  const sel = document.getElementById('adminStoreSelect');
  if (sel && sel.selectedIndex >= 0) return sel.options[sel.selectedIndex].text;
  return '当前店铺';
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
        '⚠️ 当前店铺尚未配置任何收款码' +
      '</div>';
    return;
  }

  el.innerHTML = providers.map(p => {
    const badgeDefault = p.isDefault
      ? '<span style="display:inline-block;background:#2ecc71;color:#fff;padding:1px 8px;border-radius:8px;font-size:11px;font-weight:700;margin-left:6px;">默认</span>'
      : '';
    const badgeDisabled = !p.enabled
      ? '<span style="display:inline-block;background:#777;color:#fff;padding:1px 8px;border-radius:8px;font-size:11px;font-weight:700;margin-left:6px;">已禁用</span>'
      : '';
    const bank = esc(p.bank || 'ABA');
    const cur = p.currency === 'USD' ? '🇺🇸 USD' : (p.currency === 'KHR' ? '🇰🇭 KHR' : esc(p.currency || ''));
    const bg = p.enabled ? 'rgba(46,204,113,.08)' : 'rgba(255,255,255,.03)';
    const border = p.enabled ? 'rgba(46,204,113,.25)' : 'rgba(255,255,255,.08)';

    return `<div style="padding:12px 14px;background:${bg};border:1px solid ${border};border-radius:10px;margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div style="flex:1;min-width:0;">
        <div style="color:#fff;font-weight:600;font-size:14px;">${esc(p.label)}${badgeDefault}${badgeDisabled}</div>
        <div style="color:#999;font-size:12px;margin-top:3px;">${bank} · ${cur} · ${esc(p.merchantName || '')}${p.bakongId ? ' · <code style="color:#ffd93d;">' + esc(p.bakongId) + '</code>' : ''}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;">
        ${!p.isDefault && p.enabled ? '<button data-action="default" data-id="' + p.id + '" style="padding:6px 12px;border:0;border-radius:8px;background:rgba(46,204,113,.15);color:#2ecc71;font-size:12px;font-weight:600;cursor:pointer;">设为默认</button>' : ''}
        <button data-action="toggle" data-id="${p.id}" style="padding:6px 12px;border:0;border-radius:8px;background:rgba(255,193,7,.15);color:#ffd93d;font-size:12px;font-weight:600;cursor:pointer;">${p.enabled ? '禁用' : '启用'}</button>
        <button data-action="delete" data-id="${p.id}" style="padding:6px 12px;border:0;border-radius:8px;background:rgba(231,76,60,.15);color:#e74c3c;font-size:12px;font-weight:600;cursor:pointer;">删除</button>
      </div>
    </div>`;
  }).join('');

  // 绑定按钮
  el.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'default') setDefaultProvider(id);
      else if (action === 'toggle') toggleProvider(id);
      else if (action === 'delete') deleteProvider(id);
    });
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
  const bank = (document.getElementById('khqrUploadBank') || {}).value || 'ABA';
  fd.append('label', label.trim());
  fd.append('bank', bank);

  const token = SLF.store.rawGetSession('adminToken') || '';
  const storeId = SLF.store.rawGetSession('adminStoreId') || SLF.store.rawGet('storeId') || '';
  if (!storeId) throw new Error('请先选择店铺');

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
  if (!confirm('确定删除这个收款码？')) return;
  try {
    await api('/admin/khqr/providers/' + id, { method: 'DELETE' });
    SLF.ui && SLF.ui.toast ? SLF.ui.toast('✅ 已删除') : 0;
    await loadKhqrInfo();
  } catch (e) {
    SLF.ui && SLF.ui.toast ? SLF.ui.toast('❌ ' + e.message) : alert(e.message);
  }
}

async function setDefaultProvider(id) {
  try {
    await api('/admin/khqr/providers/' + id + '/default', { method: 'POST' });
    SLF.ui && SLF.ui.toast ? SLF.ui.toast('✅ 已设为默认') : 0;
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
    btn.textContent = '⏳ 解析中...';
    try {
      const data = await uploadKhqrImage(file);
      SLF.ui && SLF.ui.toast ? SLF.ui.toast('✅ 已添加：' + (data.provider && data.provider.label || '')) : 0;
      // 清空输入
      const labelEl = document.getElementById('khqrUploadLabel');
      if (labelEl) labelEl.value = '';
      await loadKhqrInfo();
    } catch (e) {
      SLF.ui && SLF.ui.toast ? SLF.ui.toast('❌ ' + e.message) : alert(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📤 选择图片并上传';
      input.value = '';
      if (nameEl) nameEl.textContent = '未选择文件';
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
