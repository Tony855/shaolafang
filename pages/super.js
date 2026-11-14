/*
 * FoodFlow · super 页面逻辑（由内联脚本抽出，onclick 函数挂 window）
 */
(function(){
'use strict';

// ===== 国家列表 + 显示辅助（2026-10-09 新增）=====
const COUNTRY_OPTIONS = [
  { code: '',      label: '— 未指定 —' },
  { code: 'KH',    label: '🇰🇭 柬埔寨' },
  { code: 'VN',    label: '🇻🇳 越南' },
  { code: 'TH',    label: '🇹🇭 泰国' },
  { code: 'CN',    label: '🇨🇳 中国' },
  { code: 'MY',    label: '🇲🇾 马来西亚' },
  { code: 'SG',    label: '🇸🇬 新加坡' },
  { code: 'LA',    label: '🇱🇦 老挝' },
  { code: 'MM',    label: '🇲🇲 缅甸' },
  { code: 'ID',    label: '🇮🇩 印尼' },
  { code: 'PH',    label: '🇵🇭 菲律宾' },
  { code: 'OTHER', label: '🌐 其他' }
];
function countryLabel(code) {
  if (!code) return '';
  const c = COUNTRY_OPTIONS.find(o => o.code === String(code).toUpperCase());
  return c ? c.label : String(code);
}
// ===== i18n =====
let currentLang = SLF.store.rawGet('superLang') || SLF.store.rawGet('lang') || 'zh';

SLF.i18n.init(currentLang);

async function changeSuperLang(lang) {
  currentLang = lang;
  // 走 core.js 统一逻辑：优先用内置 LANGUAGES(zh)，否则从 /api/i18n/:lang 加载
  await SLF.i18n.setLang(lang);
  SLF.store.rawSet('superLang', lang);
  SLF.store.rawSet('lang', lang);
  applyI18n();
  const authed = SLF.store.rawGet('superToken') || SLF.store.rawGet('superAdminToken');
  if (authed) {
    const cur = currentModule;
    if (cur) switchModule(cur);
  }
}

function applyI18n() {
  const adminSel = document.getElementById('adminLangSelect');
  if (adminSel) adminSel.value = currentLang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key, null, el.textContent);
    if (translated && translated !== key) el.textContent = translated;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const translated = t(key, null, el.placeholder);
    if (translated && translated !== key) el.placeholder = translated;
  });

  const navTexts = {
    dashboard: t('dashboard', null, t('dashboard')),
    merchants: t('merchantManage', null, t('merchantManage')),
    stores: t('storeOverview', null, t('storeOverview')),
    logs: t('logs', null, '日志'),
    settings: t('systemSettings', null, t('systemSettings')),
  };
  document.querySelectorAll('.nav-item').forEach(item => {
    const module = item.getAttribute('data-module');
    if (module && navTexts[module]) {
      const span = item.querySelector('span:last-child');
      if (span && span.id !== 'navLogsText') span.textContent = navTexts[module];
    }
  });
  const navLogsText = document.getElementById('navLogsText');
  if (navLogsText) navLogsText.textContent = t('logs', null, '日志');


  const adminName = document.getElementById('adminName');
  if (adminName) adminName.textContent = t('superAdmin', null, t('superAdmin'));
  document.querySelectorAll('.logout-btn').forEach(btn => btn.textContent = t('logout', null, t('logout')));

  const titleEl = document.getElementById('pageTitle');
  if (titleEl && currentModule) {
    const titles = {
      dashboard: t('dashboard', null, t('dashboard')),
      merchants: t('merchantManage', null, t('merchantManage')),
      stores: t('storeOverview', null, t('storeOverview')),
      logs: t('logs', null, '日志'),
      settings: t('systemSettings', null, t('systemSettings'))
    };
    if (titles[currentModule]) titleEl.textContent = titles[currentModule];
  }

}

// 移动端侧边栏
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}

let token = SLF.store.rawGet('superToken') || '';
let currentModule = 'dashboard';
let idleTimer = null;
let lastActivity = Date.now();

function resetIdleTimer() { lastActivity = Date.now(); }

async function startIdleCheck() {
  if (idleTimer) clearInterval(idleTimer);
  let timeoutMin = 30;
  try {
    const settings = await SLF.api.get('/super/settings');
    timeoutMin = settings.super_idle_timeout || 30;
  } catch (e) {}
  const timeoutMs = timeoutMin * 60 * 1000;
  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) {
      clearInterval(idleTimer);
      idleTimer = null;
      SLF.store.rawRemove('superToken');
      SLF.store.rawRemove('superAdmin');
      token = '';
      showLoginPage();
    }
  }, 10000);
}

function showApp() {
  let storedAdmin = {};
  try { storedAdmin = JSON.parse(SLF.store.rawGet('superAdmin') || '{}'); } catch (_) {}
  if (storedAdmin.must_change_password) { window.location.replace('/super/first-login'); return; }
  applyI18n();
  document.getElementById('app').style.display = 'block';
  const admin = JSON.parse(SLF.store.rawGet('superAdmin') || '{}');
  document.getElementById('adminName').textContent = admin.display_name || t('superAdmin', null, t('superAdmin'));
  lastActivity = Date.now();
  startIdleCheck();
  ['click', 'keydown', 'mousemove', 'scroll'].forEach(evt => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
  });
  loadDashboard();
}

async function logout() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
  try { await api('/super/logout', { method: 'POST' }); } catch (e) {}
  SLF.store.rawRemove('superToken');
  SLF.store.rawRemove('superAdmin');
  token = '';
  showLoginPage();
}

function switchModule(mod) {
  currentModule = mod;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.module === mod));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + mod));
  const titles = {
    dashboard: t('dashboard', null, t('dashboard')),
    merchants: t('merchantManage', null, t('merchantManage')),
    stores: t('storeOverview', null, t('storeOverview')),
    logs: t('logs', null, '日志'),
    settings: t('systemSettings', null, t('systemSettings'))
  };
  document.getElementById('pageTitle').textContent = titles[mod] || '';
  if (mod === 'dashboard') loadDashboard();
  if (mod === 'merchants') loadMerchants();
  if (mod === 'stores') loadStores();
  if (mod === 'logs') {
    if (currentLogTab === 'audit') loadAuditLogs();
    else loadLoginLogs();
  }
  if (mod === 'settings') {
    loadGlobalSettings();
    loadBackupSettings();
  }
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  try {
    if (method === 'GET') return await SLF.api.get(path, options);
    if (method === 'POST') return await SLF.api.post(path, options.body, options);
    if (method === 'PUT') return await SLF.api.put(path, options.body, options);
    if (method === 'DELETE') return await SLF.api.del(path, options);
    return await SLF.api._request(method, path, options);
  } catch (e) {
    // 401 on the super-admin app always returns to the dedicated login page.
    if (e && e.status === 403 && (e.code === 'PASSWORD_CHANGE_REQUIRED' || /首次登录必须先修改超级管理员密码/.test(e.message || ''))) window.location.replace('/super/first-login');
    if (e && (e.status === 401 || /登录已过期|未登录|无操作权限/.test(e.message || ''))) {
      SLF.store.rawRemove('superToken');
      SLF.store.rawRemove('superAdmin');
      token = '';
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
      showLoginPage();
    }
    throw e;
  }
}

function showLoginPage() {
  window.location.replace('/super/login');
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

async function loadStoreCompare() {
  try {
    const d = await api('/super/store-breakdown');
    const stores = (d && d.stores) || [];
    const tbody = document.getElementById('storeCompareBody');
    if (!tbody) return;
    if (!stores.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">' + t('noStores') + '</td></tr>';
      return;
    }
    tbody.innerHTML = stores.map(s => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td data-label="门店" style="font-weight:600;color:#fff;">${esc(s.store_name)}</td>
        <td data-label="商户" style="color:#888;font-size:13px;">${esc(s.merchant_name)}</td>
        <td data-label="总订单" style="text-align:right;color:#fff;">${s.total_orders || 0}</td>
        <td data-label=t('todayOrders') style="text-align:right;color:#ffd93d;">${s.today_orders || 0}</td>
        <td data-label=t('todayRevenueCol') style="text-align:right;color:#2ecc71;font-weight:700;">$${Number(s.today_revenue || 0).toFixed(2)}</td>
        <td data-label=t('totalScan') style="text-align:right;color:#888;">${s.total_sessions || 0}</td>
        <td data-label=t('currentOnline') style="text-align:right;color:#27ae60;font-weight:600;">${s.online_count || 0}</td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('loadStoreCompare:', e);
  }
}

async function loadDashboard() {
  try {
    const stats = await api('/super/stats');
    document.getElementById('statMerchants').textContent = stats.merchantCount;
    document.getElementById('statStores').textContent = stats.storeCount;
    document.getElementById('statOrders').textContent = stats.orderCount;
    document.getElementById('statTodayOrders').textContent = stats.todayOrders;
    const mrEl = document.getElementById('statMonthRevenue');
    if (mrEl) mrEl.textContent = '$' + Number(stats.monthRevenue || 0).toFixed(2);
    const yrEl = document.getElementById('statYearRevenue');
    if (yrEl) yrEl.textContent = '$' + Number(stats.yearRevenue || 0).toFixed(2);
    document.getElementById('statOnlineClients').textContent = stats.onlineClients || 0;
    document.getElementById('statScanSessions').textContent = stats.totalScanSessions || 0;
    loadServerStats();
    loadStoreCompare();
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function loadServerStats() {
  try {
    const data = await api('/super/server-stats');
    document.getElementById('cpuValue').textContent = data.cpu.usage + '%';
    document.getElementById('cpuGauge').style.setProperty('--pct', data.cpu.usage);
    document.getElementById('cpuCores').textContent = data.cpu.cores + ' ' + t('coresLabel');
    document.getElementById('memValue').textContent = data.memory.usage + '%';
    document.getElementById('memGauge').style.setProperty('--pct', data.memory.usage);
    document.getElementById('memDetail').textContent = formatBytes(data.memory.used) + ' / ' + formatBytes(data.memory.total);
    document.getElementById('diskValue').textContent = data.disk.usage + '%';
    document.getElementById('diskGauge').style.setProperty('--pct', data.disk.usage);
    document.getElementById('diskDetail').textContent = formatBytes(data.disk.used) + ' / ' + formatBytes(data.disk.total);
    document.getElementById('serverHostname').textContent = data.system.hostname;
    document.getElementById('serverUptime').textContent = data.system.uptimeFormatted;
    document.getElementById('serverLoadAvg').textContent = data.system.loadAvg.join(' / ');
    document.getElementById('serverNodeVersion').textContent = data.system.nodeVersion;
    document.getElementById('serverProcessMem').textContent = formatBytes(data.memory.processRss);
  } catch (e) {}
}


// ===== 确保表头有"国家"列 =====
function ensureMerchantCountryHeader() {
  const tbody = document.getElementById('merchantList');
  if (!tbody) return;
  const table = tbody.closest('table');
  if (!table) return;
  const headRow = table.querySelector('thead tr');
  if (!headRow) return;
  if (headRow.querySelector('[data-col="country"]')) return;

  const th = document.createElement('th');
  th.setAttribute('data-col', 'country');
  th.setAttribute('data-i18n', 'countryCol');
  th.textContent = (typeof t === 'function' ? (t('countryCol', null, '国家') || '国家') : '国家');

  let targetTh = null;
  Array.from(headRow.children).forEach(c => {
    if (targetTh) return;
    const txt = (c.textContent || '').trim();
    if (/门店数|门店数量|Store/i.test(txt)) targetTh = c;
  });
  if (targetTh) headRow.insertBefore(th, targetTh);
  else headRow.appendChild(th);
}

// ===== 确保商户表单里有"国家"下拉 =====
function ensureMerchantCountryField() {
  if (document.getElementById('merchantCountry')) return;
  const statusEl = document.getElementById('merchantStatus');
  if (!statusEl) { console.warn('[country] merchantStatus 不存在'); return; }
  const statusGroup = statusEl.closest('.form-group') || statusEl.parentElement;
  if (!statusGroup || !statusGroup.parentNode) return;

  const wrap = document.createElement('div');
  wrap.className = 'form-group';
  wrap.setAttribute('data-country-field', '1');

  const label = document.createElement('label');
  label.setAttribute('for', 'merchantCountry');
  label.setAttribute('data-i18n', 'countryCol');
  label.textContent = (typeof t === 'function' ? (t('countryCol', null, '国家归属地') || '国家归属地') : '国家归属地');

  const sel = document.createElement('select');
  sel.id = 'merchantCountry';
  sel.style.cssText = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#22223a;color:#fff;font-size:14px;';
  COUNTRY_OPTIONS.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.code;
    opt.textContent = o.label;
    sel.appendChild(opt);
  });

  wrap.appendChild(label);
  wrap.appendChild(sel);
  statusGroup.parentNode.insertBefore(wrap, statusGroup.nextSibling);
}

async function loadMerchants() {
  try {
    ensureMerchantCountryHeader();
    const list = await api('/super/merchants');
    document.getElementById('merchantList').innerHTML = list.map(m => `
      <tr>
        <td data-label=t('merchantName') style="font-weight:700;color:#fff;font-size:15px;">${esc(m.name)}</td>
        <td data-label=t('merchantCode')><span style="display:inline-block;background:rgba(255,217,61,.12);color:#ffd93d;padding:3px 10px;border-radius:6px;font-family:monospace;font-size:13px;font-weight:600;">${esc(m.code)}</span></td>
        <td data-label=t('merchantAccount')><span style="display:inline-block;background:rgba(102,204,255,.1);color:#66ccff;padding:3px 10px;border-radius:6px;font-family:monospace;font-size:13px;">${esc(m.admin_username) || '-'}</span></td>
        <td data-label=t('contactPerson') style="color:#ccc;">${esc(m.contact_name) || '-'}</td>
        <td data-label=t('contactPhone') style="color:#999;font-family:monospace;font-size:13px;">${esc(m.contact_phone) || '-'}</td>
        <td data-label=t('countryCol') style="color:#ccc;">${m.country ? countryLabel(m.country) : '<span style="color:#555;">—</span>'}</td>
        <td data-label=t('storeCountCol')><span style="color:#aaa;">${m.store_count}</span><span style="color:#666;"> / </span><span style="color:#ffd93d;font-weight:600;">${m.max_stores}</span></td>
        <td data-label="状态"><span class="status-badge ${m.status === 1 ? 'status-active' : 'status-disabled'}">${m.status === 1 ? t('enabled', null, '启用') : t('disabled', null, '禁用')}</span></td>
        <td>
          <div class="merchant-actions">
            <button class="action-btn primary" onclick="editMerchant(${m.id})">编辑</button>
            <button class="action-btn" onclick="openPaymentMethods(${m.id}, this.dataset.name)" data-name="${esc(m.name)}" style="background:linear-gradient(135deg,#43e97b,#38f9d7);color:#0a3d1a;">💳 支付</button>
            <button class="action-btn warning" onclick="resetPassword(${m.id})">重置密码</button>
            ${m.id != 1 ? `<button class="action-btn danger" onclick="deleteMerchant(${m.id})">删除</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function translateLoginMessage(msg) {
  if (!msg) return '';
  if (msg.includes('商户管理员登录成功')) { const username = msg.split(':')[1] || ''; return t('merchantAdminLogin', null, t('merchantAdminLogin')) + ': ' + username.trim(); }
  if (msg.includes('超级管理员登录成功')) { const username = msg.split(':')[1] || ''; return t('superAdminLogin', null, t('superAdminLogin')) + ': ' + username.trim(); }
  if (msg.includes('服务员登录成功')) return t('loginSuccess', null, t('loginSuccess'));
  if (msg.includes('收银员登录成功')) return t('loginSuccess', null, t('loginSuccess'));
  if (msg.includes('用户名不存在') || msg.includes('账号不存在')) return t('usernameNotExist', null, t('usernameNotExist'));
  if (msg.includes('密码错误')) return t('passwordError', null, t('passwordError'));
  if (msg.includes('请输入用户名和密码')) return t('pleaseEnterCredentials', null, t('pleaseEnterCredentials'));
  if (msg.includes('IP不在白名单内')) return t('noPermission', null, t('noPermission'));
  return msg;
}

async function loadLoginLogs() {
  try {
    const logs = await api('/super/login-logs?limit=200');
    const filterTypeEl = document.getElementById('logFilterType');
    const filterStatusEl = document.getElementById('logFilterStatus');
    const filterType = filterTypeEl ? filterTypeEl.value : 'all';
    const filterStatus = filterStatusEl ? filterStatusEl.value : 'all';
    let filtered = logs;
    if (filterType !== 'all') filtered = filtered.filter(l => l.login_type === filterType);
    if (filterStatus === 'success') filtered = filtered.filter(l => l.success === 1);
    if (filterStatus === 'fail') filtered = filtered.filter(l => l.success === 0);
    const tbody = document.getElementById('loginLogList');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#888;padding:40px;">' + t('noLoginLogs') + '</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map(l => {
      const time = l.createdAt ? formatDateTime(l.createdAt) : '-';
      const statusBadge = l.success === 1 ? '<span style="color:#2ecc71;font-weight:600;">' + t('loginSuccessIcon') + '</span>' : '<span style="color:#e74c3c;font-weight:600;">' + t('loginFailIcon') + '</span>';
      const typeBadge = l.login_type === 'super_admin'
        ? '<span style="background:rgba(102,126,234,.2);color:#667eea;padding:2px 8px;border-radius:4px;font-size:11px;">' + t('superAdmin') + '</span>'
        : '<span style="background:rgba(232,93,58,.2);color:#e85d3a;padding:2px 8px;border-radius:4px;font-size:11px;">' + t('merchantAdminBadge') + '</span>';
      return `<tr>
        <td data-label="ID"><span style="color:#ffd93d;font-family:monospace;font-weight:600;">#${l.id}</span></td>
        <td data-label=t('loginTime') style="white-space:nowrap;color:#ccc;font-size:13px;">${time}</td>
        <td data-label=t('loginName') style="font-weight:600;color:#fff;">${esc(l.username) || '-'}</td>
        <td data-label=t('belongMerchant') style="color:#ccc;">${esc(l.merchant_name) || '-'}</td>
        <td data-label=t('loginIp') style="font-family:monospace;color:#999;font-size:13px;">${esc(l.ip) || '-'}</td>
        <td data-label=t('loginLocation') style="color:#999;font-size:13px;">${esc(l.location) || '-'}</td>
        <td data-label=t('loginType')>${typeBadge}</td>
        <td data-label="状态">${statusBadge}</td>
        <td data-label="备注" style="color:#888;font-size:12px;">${esc(translateLoginMessage(l.message))}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('loginLogList').innerHTML = '<tr><td colspan="9" style="text-align:center;color:#e74c3c;padding:40px;">' + t('loadFailedColon') + esc(e.message) + '</td></tr>';
  }
}

async function loadStores() {
  try {
    const stores = await api('/super/stores');
    const list = Array.isArray(stores) ? stores : [];
    document.getElementById('storeList').innerHTML = list.map(s => `
      <tr>
        <td data-label=t('storeId')><span style="display:inline-block;background:rgba(255,217,61,.12);color:#ffd93d;padding:3px 10px;border-radius:6px;font-family:monospace;font-size:13px;font-weight:600;">#${s.id}</span></td>
        <td data-label=t('storeName') style="font-weight:600;color:#fff;">${esc(s.name)}</td>
        <td data-label=t('belongMerchant') style="color:#ccc;">${esc(s.merchant_name) || t('unknown', null, '未知')}</td>
        <td data-label="编码"><code style="color:#66ccff;font-family:monospace;font-size:13px;">${esc(s.code) || '-'}</code></td>
        <td data-label="地址" style="color:#999;font-size:13px;">${esc(s.address) || '-'}</td>
        <td data-label="状态"><span class="status-badge ${s.active ? 'status-active' : 'status-disabled'}">${s.active ? t('enabled', null, '启用') : t('disabled', null, '禁用')}</span></td>
      </tr>
    `).join('');
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function showAddMerchant() {
  document.getElementById('merchantModalTitle').innerHTML = t('addMerchant') + '<span class="modal-close" onclick="closeMerchantModal()">✕</span>';
  document.getElementById('editMerchantId').value = '';
  document.getElementById('merchantName').value = '';
  document.getElementById('merchantCode').value = '';
  document.getElementById('merchantCode').disabled = false;
  document.getElementById('merchantCode').style.background = '';
  document.getElementById('merchantCode').style.color = '';
  document.getElementById('merchantCode').style.cursor = '';
  document.getElementById('merchantUsername').value = '';
  document.getElementById('merchantPassword').value = '';
  document.getElementById('merchantContact').value = '';
  document.getElementById('merchantPhone').value = '';
  document.getElementById('merchantMaxStores').value = 1;
  document.getElementById('merchantStatus').value = '1';
  ensureMerchantCountryField();
  const _cSel = document.getElementById('merchantCountry');
  if (_cSel) _cSel.value = '';
  document.getElementById('merchantUsername').disabled = false;
  document.getElementById('merchantModal').classList.add('open');
}

async function editMerchant(id) {
  try {
    const list = await api('/super/merchants');
    const m = list.find(x => x.id === id);
    if (!m) return;
    document.getElementById('merchantModalTitle').innerHTML = t('editMerchant') + '<span class="modal-close" onclick="closeMerchantModal()">✕</span>';
    document.getElementById('editMerchantId').value = m.id;
    document.getElementById('merchantName').value = m.name;
    document.getElementById('merchantCode').value = m.code;
    document.getElementById('merchantCode').disabled = true;
    document.getElementById('merchantCode').style.background = 'rgba(255,255,255,.04)';
    document.getElementById('merchantCode').style.color = '#888';
    document.getElementById('merchantCode').style.cursor = 'not-allowed';
    document.getElementById('merchantUsername').value = m.admin_username || '';
    document.getElementById('merchantPassword').value = '';
    document.getElementById('merchantContact').value = m.contact_name || '';
    document.getElementById('merchantPhone').value = m.contact_phone || '';
    document.getElementById('merchantMaxStores').value = m.max_stores;
    document.getElementById('merchantStatus').value = m.status;
    ensureMerchantCountryField();
    const _cSel = document.getElementById('merchantCountry');
    if (_cSel) _cSel.value = m.country || '';
    document.getElementById('merchantUsername').disabled = false;
    document.getElementById('merchantModal').classList.add('open');
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function closeMerchantModal() { document.getElementById('merchantModal').classList.remove('open'); }
window.closeMerchantModal = closeMerchantModal;

async function saveMerchant() {
  const id = document.getElementById('editMerchantId').value;
  ensureMerchantCountryField();
  const _countryEl = document.getElementById('merchantCountry');
  const data = {
    name: document.getElementById('merchantName').value.trim(),
    code: document.getElementById('merchantCode').value.trim(),
    username: document.getElementById('merchantUsername').value.trim(),
    password: document.getElementById('merchantPassword').value.trim(),
    contact_name: document.getElementById('merchantContact').value.trim(),
    contact_phone: document.getElementById('merchantPhone').value.trim(),
    max_stores: parseInt(document.getElementById('merchantMaxStores').value) || 1,
    status: parseInt(document.getElementById('merchantStatus').value),
    country: _countryEl ? _countryEl.value : ''
  };
  if (!data.name) { SLF.ui.toast(t('merchantNameRequired', null, t('merchantNameRequired')), 'error'); return; }
  if (!data.username) { SLF.ui.toast(t('accountRequired', null, t('accountRequired')), 'error'); return; }
  try {
    if (id) {
      await api('/super/merchants/' + id, { method: 'PUT', body: JSON.stringify(data) });
      SLF.ui.toast(t('merchantUpdated', null, t('merchantUpdated')), 'success');
    } else {
      const result = await api('/super/merchants', { method: 'POST', body: JSON.stringify(data) });
      SLF.ui.toast(t('merchantCreated', { username: result.adminUsername, password: result.defaultPassword }, '商户已创建'), 'success');
    }
    closeMerchantModal();
    loadMerchants();
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function deleteMerchant(id) {
  showConfirm(t('confirmDeleteMerchant', null, t('confirmDeleteMerchant')), async function() {
    try {
      await api('/super/merchants/' + id, { method: 'DELETE' });
      SLF.ui.toast(t('merchantDeleted', null, t('merchantDeleted')), 'success');
      loadMerchants();
    } catch (e) { SLF.ui.toast(e.message, 'error'); }
  });
}

function resetPassword(id) {
  showConfirm(t('confirmResetPassword', null, t('confirmResetPassword')), async function() {
    try {
      const result = await api('/super/merchants/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({}) });
      if (!result || typeof result.newPassword !== 'string' || !result.newPassword) {
        throw new Error('密码已重置，但未能读取新密码，请联系管理员处理');
      }
      // Display the generated password once so the operator can securely copy it.
      window.prompt('商户新密码（请立即复制并安全保存；关闭后无法再次查看）：', result.newPassword);
      SLF.ui.toast(t('passwordReset', null, t('passwordReset')), 'success');
    } catch (e) { SLF.ui.toast(e.message, 'error'); }
  });
}

function changeSuperPassword() {
  const newPwd = document.getElementById('newSuperPassword').value;
  if (!newPwd) { SLF.ui.toast(t('pleaseEnterNewPassword', null, t('pleaseEnterNewPassword')), 'error'); return; }
  if (newPwd.length < 6) { SLF.ui.toast('❌ ' + t('passwordTooShort', null, t('passwordMin6')), 'error'); return; }
  showPasswordModal(t('enterOldPassword', null, t('enterOldPassword')), async function(oldPwd) {
    try {
      const data = await SLF.api.post('/super/change-password', { oldPassword: oldPwd, newPassword: newPwd });
      if (!data || !data.success) throw new Error((data && data.error) || t('saveFailed', null, t('saveFailed')));
      SLF.ui.toast('✅ ' + t('passwordChanged', null, t('passwordChanged')), 'success');
      document.getElementById('newSuperPassword').value = '';
    } catch (e) { SLF.ui.toast('❌ ' + e.message, 'error'); }
  });
}

async function loadGlobalSettings() {
  try {
    const settings = await api('/super/settings');
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    setVal('superIdleTimeout', settings.super_idle_timeout || 60);
    setVal('adminIdleTimeout', settings.admin_idle_timeout || 30);
    setVal('cashierIdleTimeout', settings.cashier_idle_timeout || 30);
    setVal('kitchenIdleTimeout', settings.kitchen_idle_timeout || 120);
    setVal('qrSessionTimeout', (settings.qr_session_timeout !== undefined && settings.qr_session_timeout !== null) ? settings.qr_session_timeout : 45);
    setVal('waiterSessionTimeout', settings.waiter_session_timeout || 12);
    setVal('cashierSessionTimeout', settings.cashier_session_timeout || 12);
    setVal('orderIntervalSeconds', settings.order_interval_seconds || 30);
    setVal('waiterRefreshInterval', settings.waiter_refresh_interval || 8);
    setVal('kitchenAutoHideMinutes', settings.kitchen_auto_hide_minutes || 10);
    setVal('maxOrderItems', settings.max_order_items || 50);
    setVal('maxItemQuantity', settings.max_item_quantity || 100);
    setVal('maxOrderNoteLength', settings.max_order_note_length || 200);
    setVal('loginMaxAttempts', settings.login_max_attempts || 5);
    setVal('loginLockMinutes', settings.login_lock_minutes || 15);
    setVal('superIpWhitelist', settings.super_ip_whitelist || '');
    setVal('callLimitEnabled', settings.call_limit_enabled ? '1' : '0');
    setVal('callLimitMax', settings.call_limit_max || 3);
    setVal('callLimitWindowMinutes', settings.call_limit_window_minutes || 5);
    setVal('callLimitCooldownMinutes', settings.call_limit_cooldown_minutes || 10);
    setVal('autoCleanLogEnabled', settings.auto_clean_log_enabled ? '1' : '0');
    setVal('logRetentionDays', settings.log_retention_days || 30);
    await loadTelegramBotSettings();
    setVal('cleanLoginLog', settings.clean_login_log ? '1' : '0');
    setVal('cleanAuditLog', settings.clean_audit_log ? '1' : '0');
  } catch (e) { SLF.ui.toast(t('loadFailed', null, t('loadFailed')) + ': ' + e.message, 'error'); }
}


async function loadTelegramBotSettings() {
  try {
    const config = await api('/super/telegram/config');
    for (const scope of ['client', 'admin']) {
      const item = config[scope] || {};
      const prefix = scope === 'client' ? 'telegramClient' : 'telegramAdmin';
      const enabled = document.getElementById(prefix + 'Enabled');
      const token = document.getElementById(prefix + 'Token');
      const chat = document.getElementById(prefix + 'ChatId');
      const clear = document.getElementById(prefix + 'ClearToken');
      const status = document.getElementById(prefix + 'TokenStatus');
      if (enabled) enabled.value = item.enabled ? '1' : '0';
      if (token) token.value = '';
      if (chat) chat.value = item.chat_id || '';
      if (clear) clear.checked = false;
      if (status) status.textContent = item.configured
        ? (t('telegramTokenConfigured') || '已保存 Token') + '：' + (item.token_masked || '')
        : (t('telegramTokenMissing') || '尚未配置 Token');
    }
  } catch (error) {
    SLF.ui.toast((t('loadFailed') || '加载失败') + ': ' + error.message, 'error');
  }
}

async function saveTelegramBotSettings() {
  const read = scope => {
    const prefix = scope === 'client' ? 'telegramClient' : 'telegramAdmin';
    return {
      enabled: document.getElementById(prefix + 'Enabled').value === '1',
      token: document.getElementById(prefix + 'Token').value.trim(),
      clear_token: document.getElementById(prefix + 'ClearToken').checked,
      chat_id: document.getElementById(prefix + 'ChatId').value.trim()
    };
  };
  try {
    await api('/super/telegram/config', {
      method: 'PUT',
      body: JSON.stringify({ client: read('client'), admin: read('admin') })
    });
    await loadTelegramBotSettings();
    SLF.ui.toast(t('telegramSaved') || 'Telegram Bot 配置已保存', 'success');
  } catch (error) {
    SLF.ui.toast((t('saveFailed') || '保存失败') + ': ' + error.message, 'error');
  }
}

async function testTelegramBot(scope) {
  if (!['client', 'admin'].includes(scope)) return;
  try {
    if (scope === 'client') {
      await api('/super/telegram/client/test', { method: 'POST', body: JSON.stringify({}) });
    } else {
      await api('/super/telegram/admin/test', { method: 'POST', body: JSON.stringify({}) });
    }
    SLF.ui.toast(t('telegramTestSent') || '测试消息已发送，请检查 Telegram', 'success');
  } catch (error) {
    SLF.ui.toast((t('telegramTestFailed') || '测试消息发送失败') + ': ' + error.message, 'error');
  }
}
window.loadTelegramBotSettings = loadTelegramBotSettings;
window.saveTelegramBotSettings = saveTelegramBotSettings;
window.testTelegramBot = testTelegramBot;

function switchSettingsTab(tab) {
  const tabs = { timeout: 'tabTimeout', order: 'tabOrder', security: 'tabSecurity', callLimit: 'tabCallLimit', log: 'tabLog', telegram: 'tabTelegram' };
  const panels = { timeout: 'timeoutSettings', order: 'orderSettings', security: 'securitySettings', callLimit: 'callLimitSettings', log: 'logSettings', telegram: 'telegramSettings' };
  Object.keys(tabs).forEach(t_ => {
    const tabEl = document.getElementById(tabs[t_]);
    const panelEl = document.getElementById(panels[t_]);
    if (!tabEl || !panelEl) return;
    if (t_ === tab) {
      tabEl.style.background = 'rgba(232,93,58,.15)';
      tabEl.style.color = '#e85d3a';
      tabEl.style.borderColor = 'rgba(232,93,58,.4)';
      panelEl.style.display = 'block';
    } else {
      tabEl.style.background = 'rgba(255,255,255,.04)';
      tabEl.style.color = '#aaa';
      tabEl.style.borderColor = 'rgba(255,255,255,.1)';
      panelEl.style.display = 'none';
    }
  });
}

async function saveGlobalSettings() {
  const getInt = (id) => parseInt(document.getElementById(id).value, 10);
  // 前置校验
  const superIdleTimeout = getInt('superIdleTimeout');
  if (!superIdleTimeout || superIdleTimeout < 1 || superIdleTimeout > 1440) { SLF.ui.toast(t('inputRangeError', { field: t('superIdleTimeout'), min: 1, max: 1440 }), 'error'); return; }
  const adminIdleTimeout = getInt('adminIdleTimeout');
  if (!adminIdleTimeout || adminIdleTimeout < 1 || adminIdleTimeout > 1440) { SLF.ui.toast(t('inputRangeError', { field: t('adminIdleTimeout'), min: 1, max: 1440 }), 'error'); return; }
  const qrTimeout = getInt('qrSessionTimeout');
  if (isNaN(qrTimeout) || qrTimeout < 0 || qrTimeout > 1440) { SLF.ui.toast(t('inputRangeError', { field: t('qrSessionTimeout'), min: 0, max: 1440 }), 'error'); return; }
  const orderInterval = getInt('orderIntervalSeconds');
  if (isNaN(orderInterval) || orderInterval < 0 || orderInterval > 3600) { SLF.ui.toast(t('inputRangeError', { field: t('orderInterval'), min: 0, max: 3600 }), 'error'); return; }
  const waiterRefresh = getInt('waiterRefreshInterval');
  if (!waiterRefresh || waiterRefresh < 3 || waiterRefresh > 300) { SLF.ui.toast(t('inputRangeError', { field: t('waiterRefreshInterval'), min: 3, max: 300 }), 'error'); return; }
  const maxOrderItems = getInt('maxOrderItems');
  if (!maxOrderItems || maxOrderItems < 1 || maxOrderItems > 200) { SLF.ui.toast(t('inputRangeError', { field: t('maxOrderItems'), min: 1, max: 200 }), 'error'); return; }
  const maxItemQuantity = getInt('maxItemQuantity');
  if (!maxItemQuantity || maxItemQuantity < 1 || maxItemQuantity > 999) { SLF.ui.toast(t('inputRangeError', { field: t('maxItemQuantity'), min: 1, max: 999 }), 'error'); return; }
  const maxOrderNoteLength = getInt('maxOrderNoteLength');
  if (!maxOrderNoteLength || maxOrderNoteLength < 10 || maxOrderNoteLength > 1000) { SLF.ui.toast(t('inputRangeError', { field: t('maxOrderNoteLength'), min: 10, max: 1000 }), 'error'); return; }
  const waiterSessionTimeout = getInt('waiterSessionTimeout') || 12;
  const loginMaxAttempts = getInt('loginMaxAttempts');
  if (!loginMaxAttempts || loginMaxAttempts < 1 || loginMaxAttempts > 20) { SLF.ui.toast(t('inputRangeError', { field: t('loginMaxAttempts'), min: 1, max: 20 }), 'error'); return; }
  const loginLockMinutes = getInt('loginLockMinutes');
  if (!loginLockMinutes || loginLockMinutes < 1 || loginLockMinutes > 1440) { SLF.ui.toast(t('inputRangeError', { field: t('loginLockMinutes'), min: 1, max: 1440 }), 'error'); return; }
  const superIpWhitelist = document.getElementById('superIpWhitelist').value.trim();
  const callLimitEnabled = document.getElementById('callLimitEnabled').value === '1';
  const callLimitMax = getInt('callLimitMax');
  if (!callLimitMax || callLimitMax < 1 || callLimitMax > 20) { SLF.ui.toast(t('inputRangeError', { field: t('callLimitMax'), min: 1, max: 20 }), 'error'); return; }
  const callLimitWindow = getInt('callLimitWindowMinutes');
  if (!callLimitWindow || callLimitWindow < 1 || callLimitWindow > 60) { SLF.ui.toast(t('inputRangeError', { field: t('callLimitWindowMinutes'), min: 1, max: 60 }), 'error'); return; }
  const callLimitCooldown = getInt('callLimitCooldownMinutes');
  if (!callLimitCooldown || callLimitCooldown < 1 || callLimitCooldown > 120) { SLF.ui.toast(t('inputRangeError', { field: t('callLimitCooldownMinutes'), min: 1, max: 120 }), 'error'); return; }

  try {
    await api('/super/settings', { method: 'PUT', body: JSON.stringify({
      super_idle_timeout: superIdleTimeout,
      admin_idle_timeout: adminIdleTimeout,
      cashier_idle_timeout: getInt('cashierIdleTimeout') || 30,
      kitchen_idle_timeout: getInt('kitchenIdleTimeout') || 120,
      qr_session_timeout: qrTimeout,
      waiter_session_timeout: waiterSessionTimeout,
      cashier_session_timeout: getInt('cashierSessionTimeout') || 12,
      order_interval_seconds: orderInterval,
      waiter_refresh_interval: waiterRefresh,
      max_order_items: maxOrderItems,
      max_item_quantity: maxItemQuantity,
      max_order_note_length: maxOrderNoteLength,
      login_max_attempts: loginMaxAttempts,
      login_lock_minutes: loginLockMinutes,
      super_ip_whitelist: superIpWhitelist,
      call_limit_enabled: callLimitEnabled,
      call_limit_max: callLimitMax,
      call_limit_window_minutes: callLimitWindow,
      call_limit_cooldown_minutes: callLimitCooldown,
      auto_clean_log_enabled: document.getElementById('autoCleanLogEnabled').value === '1',
      log_retention_days: getInt('logRetentionDays') || 30,
      clean_login_log: document.getElementById('cleanLoginLog').value === '1',
      clean_audit_log: document.getElementById('cleanAuditLog').value === '1',
      kitchen_auto_hide_minutes: getInt('kitchenAutoHideMinutes') || 0
    })});
    SLF.ui.toast(t('settingsSaved', null, t('settingsSaved')), 'success');
  } catch (e) { SLF.ui.toast(t('saveFailed', null, t('saveFailed')) + ': ' + e.message, 'error'); }
}

let currentLogTab = 'login';
function switchSuperLogTab(tab) {
  currentLogTab = tab;
  document.getElementById('logTabLogin').style.background = tab === 'login' ? 'rgba(232,93,58,.15)' : 'rgba(255,255,255,.04)';
  document.getElementById('logTabLogin').style.color = tab === 'login' ? '#e85d3a' : '#aaa';
  document.getElementById('logTabLogin').style.borderColor = tab === 'login' ? 'rgba(232,93,58,.4)' : 'rgba(255,255,255,.1)';
  document.getElementById('logTabAudit').style.background = tab === 'audit' ? 'rgba(232,93,58,.15)' : 'rgba(255,255,255,.04)';
  document.getElementById('logTabAudit').style.color = tab === 'audit' ? '#e85d3a' : '#aaa';
  document.getElementById('logTabAudit').style.borderColor = tab === 'audit' ? 'rgba(232,93,58,.4)' : 'rgba(255,255,255,.1)';
  document.getElementById('superLoginLogsPanel').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('superAuditLogsPanel').style.display = tab === 'audit' ? 'block' : 'none';
  if (tab === 'audit') loadAuditLogs();
  else loadLoginLogs();
}
function refreshCurrentLog() {
  if (currentLogTab === 'audit') loadAuditLogs();
  else loadLoginLogs();
}

async function loadAuditLogs() {
  try {
    const logs = await api('/super/audit-logs');
    const tbody = document.getElementById('auditLogsBody');
    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#666;">' + t('noAuditRecords') + '</td></tr>';
      return;
    }
    const actionNames = {
      'create_merchant': t('actionCreateMerchant'), 'update_merchant': t('actionUpdateMerchant'), 'delete_merchant': t('actionDeleteMerchant'),
      'reset_merchant_password': t('actionResetMerchantPassword'), 'create_store': t('actionCreateStore'), 'update_store': t('editStore'),
      'delete_store': t('actionDeleteStore'), 'settle_order': t('settleOrder'), 'cancel_order': t('cancelOrder'),
      'reset_data': t('actionResetData'), 'change_password': t('changePassword'), 'update_settings': t('actionUpdateSettings'),
      'reset_all_data': t('actionResetAllData'), 'login': '登录', 'logout': '登出',
      'backup': t('dataBackup'), 'import_backup': t('actionImportBackup')
    };
    const targetTypeNames = {
      'merchant': '商户', 'merchant_admin': t('admin'), 'store': '店铺', 'menu': '菜品',
      'category': '分类', 'waiter': t('waiter'), 'table': '桌号', 'currency': '货币',
      'order': '订单', 'settings': '设置', 'system': '系统', 'super_admin': t('superAdmin')
    };
    tbody.innerHTML = logs.map(log => {
      const action = actionNames[log.action] || log.action;
      const targetTypeName = targetTypeNames[log.target_type] || log.target_type;
      const target = log.target_type ? `${targetTypeName}${log.target_id ? ' #' + log.target_id : ''}` : '-';
      let details = log.details || '-';
      try {
        if (typeof details === 'string' && (details.startsWith('{') || details.startsWith('['))) {
          const obj = JSON.parse(details);
          details = Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ');
        }
      } catch (e) {}
      const displayDetails = details.length > 60 ? details.substring(0, 60) + '...' : details;
      return `<tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td style="padding:10px;color:#666;">${log.id}</td>
        <td style="padding:10px;color:#aaa;">${formatDateTime(log.created_at)}</td>
        <td style="padding:10px;color:#fff;">${esc(log.actor_username) || '-'}</td>
        <td style="padding:10px;"><span style="background:rgba(232,93,58,.15);color:#e85d3a;padding:3px 8px;border-radius:4px;font-size:12px;">${esc(action)}</span></td>
        <td style="padding:10px;color:#aaa;">${esc(target)}</td>
        <td style="padding:10px;color:#888;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(log.details || '')}">${esc(displayDetails)}</td>
        <td style="padding:10px;color:#888;">${esc(log.ip) || '-'}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('auditLogsBody').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#e74c3c;">' + t('loadFailedColon') + esc(e.message) + '</td></tr>';
  }
}


// 通用确认弹窗
let confirmCallback = null;
function showConfirm(message, callback, title) {
  document.getElementById('confirmModalTitle').textContent = title || t('confirmOperation', null, t('confirmTitle'));
  document.getElementById('confirmModalMessage').textContent = message;
  confirmCallback = callback;
  document.getElementById('confirmModal').classList.add('open');
}
function hideConfirm() {
  document.getElementById('confirmModal').classList.remove('open');
  confirmCallback = null;
}
window.hideConfirm = hideConfirm;
document.getElementById('confirmModalBtn').onclick = function() {
  if (confirmCallback) confirmCallback();
  hideConfirm();
};
document.getElementById('confirmModal').addEventListener('click', function(e) {
  if (e.target === this) hideConfirm();
});

// 密码输入弹窗
let passwordCallback = null;
function showPasswordModal(message, callback, title) {
  document.getElementById('passwordModalTitle').textContent = title || t('verifyPassword', null, t('verifyPassword'));
  document.getElementById('passwordModalMessage').textContent = message || t('enterPasswordVerify', null, t('enterPasswordVerify'));
  document.getElementById('passwordModalInput').value = '';
  passwordCallback = callback;
  document.getElementById('passwordModal').classList.add('open');
  setTimeout(() => document.getElementById('passwordModalInput').focus(), 100);
}
function hidePasswordModal() {
  document.getElementById('passwordModal').classList.remove('open');
  passwordCallback = null;
}
window.hidePasswordModal = hidePasswordModal;
function executePasswordModal() {
  const password = document.getElementById('passwordModalInput').value;
  if (!password) { SLF.ui.toast(t('enterPassword', null, t('enterPassword')), 'error'); return; }
  if (passwordCallback) passwordCallback(password);
  hidePasswordModal();
}
document.getElementById('passwordModalInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') executePasswordModal();
});
document.getElementById('passwordModal').addEventListener('click', function(e) {
  if (e.target === this) hidePasswordModal();
});

function resetData() {
  showPasswordModal(t('enterPasswordVerify', null, '请再次输入密码'), function(password) {
    showConfirm(t('confirmResetData', null, t('confirmResetData')), async function() {
      try {
        const data = await SLF.api.post('/super/reset-data', { password });
        if (!data || !data.success) throw new Error((data && data.error) || t('resetFailed', null, t('resetFailed')));
        SLF.ui.toast('✅ ' + t('orderDataReset', null, t('orderDataReset')), 'success');
      } catch (e) {
        SLF.ui.toast('❌ ' + t('resetFailed', null, t('resetFailed')) + ': ' + e.message, 'error');
      }
    }, t('confirmResetDataTitle', null, t('confirmResetDataTitle')));
  }, t('verifySuperPassword', null, t('verifySuperPassword')));
}

// ===== 数据备份 =====
let selectedBackupFile = null;

async function loadBackupSettings() {
  try {
    const data = await api('/super/backup/settings');
    const sel = document.getElementById('backupIntervalSelect');
    if (sel) sel.value = String(data.intervalHours || 24);
    const rd = document.getElementById('backupRetentionDays');
    if (rd) rd.value = String(data.retentionDays || 30);
    if (data.lastBackupAt) {
      const info = document.getElementById('lastBackupInfo');
      if (info) info.textContent = t('lastBackupTime', null, '上次备份时间') + ': ' + formatDateTime(data.lastBackupAt);
    }
  } catch (e) { console.error('加载备份设置失败', e); }
}

async function exportBackup() {
  try {
    const res = await fetch('/api/super/backup/export', {
      headers: { 'X-Super-Token': token, 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error(t('exportFailed', null, t('exportFailed')));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'foodflow-backup-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    SLF.ui.toast('✅ ' + t('backupExported', null, t('backupExported')), 'success');
  } catch (e) {
    SLF.ui.toast('❌ ' + t('exportFailed', null, t('exportFailed')) + ': ' + e.message, 'error');
  }
}
window.exportBackup = exportBackup;

function onBackupFileSelected(input) {
  if (input.files && input.files[0]) {
    selectedBackupFile = input.files[0];
    document.getElementById('backupFileName').textContent = selectedBackupFile.name;
  }
}
window.onBackupFileSelected = onBackupFileSelected;

async function importBackup() {
  if (!selectedBackupFile) {
    SLF.ui.toast('⚠️ ' + t('pleaseSelectBackupFile', null, t('pleaseSelectBackupFile')), 'error');
    return;
  }
  showConfirm(t('confirmImportBackup', null, t('confirmImportBackup')), async function() {
    try {
      const text = await selectedBackupFile.text();
      const data = JSON.parse(text);
      const result = await SLF.api.post('/super/backup/import', data);
      if (!result || !result.success) throw new Error((result && result.error) || t('importFailed', null, t('importFailed')));
      SLF.ui.toast('✅ ' + t('backupImported', null, t('backupImported')), 'success');
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      SLF.ui.toast('❌ ' + t('importFailed', null, t('importFailed')) + ': ' + e.message, 'error');
    }
  });
}
window.importBackup = importBackup;

async function saveBackupSettings() {
  try {
    const intervalHours = document.getElementById('backupIntervalSelect').value;
    const retentionDays = (document.getElementById('backupRetentionDays') || {}).value || 30;
    await api('/super/backup/settings', { method: 'PUT', body: JSON.stringify({ intervalHours, retentionDays }) });
    SLF.ui.toast('✅ ' + t('backupSettingsSaved', null, t('backupSettingsSaved')), 'success');
  } catch (e) {
    SLF.ui.toast('❌ ' + t('saveFailed', null, t('saveFailed')), 'error');
  }
}
window.saveBackupSettings = saveBackupSettings;

async function backupNow() {
  try {
    await api('/super/backup/now', { method: 'POST' });
    SLF.ui.toast('✅ ' + t('backupGenerated', null, t('backupGenerated')), 'success');
    loadBackupSettings();
  } catch (e) {
    SLF.ui.toast('❌ ' + t('backupFailed', null, t('backupFailed')), 'error');
  }
}
window.backupNow = backupNow;

// 登录回车
// 初始化
applyI18n();
if (token) showApp();
else window.location.replace('/super/login');

// 汉堡按钮拖动+磁吸
(function() {
  const btn = document.getElementById('mobileMenuBtn');
  if (!btn) return;
  let isDragging = false, startX, startY, origX, origY, moved = false;
  function getPos(e) { return e.touches ? e.touches[0] : e; }
  function onStart(e) {
    isDragging = true; moved = false;
    const p = getPos(e);
    startX = p.clientX; startY = p.clientY;
    const rect = btn.getBoundingClientRect();
    origX = rect.left; origY = rect.top;
    btn.style.transition = 'none';
  }
  function onMove(e) {
    if (!isDragging) return;
    const p = getPos(e);
    const dx = p.clientX - startX, dy = p.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { moved = true; e.preventDefault(); }
    btn.style.left = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, origX + dx)) + 'px';
    btn.style.top = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, origY + dy)) + 'px';
  }
  function onEnd() {
    if (!isDragging) return;
    isDragging = false;
    btn.style.transition = 'left .3s, top .3s';
    const rect = btn.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    if (centerX < window.innerWidth / 2) btn.style.left = '6px';
    else btn.style.left = (window.innerWidth - btn.offsetWidth - 6) + 'px';
    if (rect.top < 60) btn.style.top = '6px';
  }
  btn.addEventListener('mousedown', onStart);
  btn.addEventListener('touchstart', onStart, {passive: false});
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, {passive: false});
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchend', onEnd);
  btn.addEventListener('click', function(e) {
    if (moved) { e.stopPropagation(); e.preventDefault(); }
  }, true);
    try { window.backupNow = backupNow; } catch(err) {}
    try { window.changeSuperPassword = changeSuperPassword; } catch(err) {}
    try { window.closeMerchantModal = closeMerchantModal; } catch(err) {}
    try { window.closeOnlineSessions = closeOnlineSessions; } catch(err) {}
    try { window.closeSidebar = closeSidebar; } catch(err) {}
    try { window.deleteMerchant = deleteMerchant; } catch(err) {}
    try { window.editMerchant = editMerchant; } catch(err) {}
    try { window.executePasswordModal = executePasswordModal; } catch(err) {}
    try { window.exportBackup = exportBackup; } catch(err) {}
    try { window.hideConfirm = hideConfirm; } catch(err) {}
    try { window.hidePasswordModal = hidePasswordModal; } catch(err) {}
    try { window.importBackup = importBackup; } catch(err) {}
    try { window.logout = logout; } catch(err) {}
    try { window.refreshCurrentLog = refreshCurrentLog; } catch(err) {}
    try { window.resetData = resetData; } catch(err) {}
    try { window.resetPassword = resetPassword; } catch(err) {}
    try { window.saveBackupSettings = saveBackupSettings; } catch(err) {}
    try { window.saveGlobalSettings = saveGlobalSettings; } catch(err) {}
    try { window.saveMerchant = saveMerchant; } catch(err) {}
    try { window.showAddMerchant = showAddMerchant; } catch(err) {}
try { window.ensureMerchantCountryField = ensureMerchantCountryField; window.countryLabel = countryLabel; window.COUNTRY_OPTIONS = COUNTRY_OPTIONS; } catch(err) {}
    try { window.showOnlineSessions = showOnlineSessions; } catch(err) {}
    try { window.showStoreBreakdown = showStoreBreakdown; } catch(err) {}
    try { window.showStoreSessions = showStoreSessions; } catch(err) {}
    try { window.switchModule = switchModule; } catch(err) {}
    try { window.switchSettingsTab = switchSettingsTab; } catch(err) {}
    try { window.switchSuperLogTab = switchSuperLogTab; } catch(err) {}
    try { window.toggleSidebar = toggleSidebar; } catch(err) {}
    try { window.changeSuperLang = changeSuperLang; } catch(err) {}
    try { window.loadLoginLogs = loadLoginLogs; } catch(err) {}
})();
;
// ===== 在线会话/门店统计弹窗 =====
async function showStoreBreakdown(type, period) {
  period = period || 'today';
  const periodLabel = { today: t('quickToday'), month: t('quickMonth'), year: t('yearLabel') }[period];

  const titles = {
    orders: t('totalOrdersByStore'),
    revenue: periodLabel + t('revenueByStoreModal'),
    sessions: t('scanSessionsByStore')
  };
  document.getElementById('osModalTitle').textContent = titles[type] || t('storeStatistics');
  document.getElementById('osModalBody').innerHTML = '<p style="color:#888;">' + t('loading') + '</p>';
  document.getElementById('onlineSessionsModal').style.display = 'flex';
  try {
    const d = await SLF.api.get('/super/store-breakdown');
    const stores = (d && d.stores) || [];
    if (!stores.length) {
      document.getElementById('osModalBody').innerHTML = '<p style="color:#888;text-align:center;padding:20px;">' + t('noStores') + '</p>';
      return;
    }
    const cols = {
      orders: ['门店', '商户', '总订单', t('todayOrders')],
      revenue: ['门店', '商户', periodLabel + t('revenueCol'), periodLabel + '订单'],
      sessions: ['门店', '商户', t('totalScan'), t('currentOnline')]
    };
    let html = '<table style="width:100%;border-collapse:collapse;font-size:14px;color:#ddd;">';
    html += '<tr style="background:rgba(255,255,255,0.08);color:#888;">';
    cols[type].forEach(h => html += '<th style="padding:10px 12px;text-align:left;font-weight:600;">' + h + '</th>');
    html += '</tr>';
    stores.forEach(s => {
      html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.08);">';
      if (type === 'orders') {
        html += '<td style="padding:12px;font-weight:600;">' + esc(s.store_name||'-') + '</td>'
          + '<td style="padding:12px;color:#888;">' + esc(s.merchant_name||'-') + '</td>'
          + '<td style="padding:12px;text-align:center;">' + (s.total_orders||0) + '</td>'
          + '<td style="padding:12px;text-align:center;">' + (s.today_orders||0) + '</td>';
      } else if (type === 'revenue') {
        const revKey = period === 'month' ? 'month_revenue' : (period === 'year' ? 'year_revenue' : 'today_revenue');
        const ordKey = period === 'month' ? 'month_orders' : (period === 'year' ? 'year_orders' : 'today_orders');
        html += '<td style="padding:12px;font-weight:600;">' + esc(s.store_name||'-') + '</td>'
          + '<td style="padding:12px;color:#888;">' + esc(s.merchant_name||'-') + '</td>'
          + '<td style="padding:12px;text-align:center;color:#27ae60;font-weight:600;">$' + Number(s[revKey]||0).toFixed(2) + '</td>'
          + '<td style="padding:12px;text-align:center;">' + (s[ordKey]||0) + '</td>';
      } else {
        html += '<td style="padding:12px;font-weight:600;">' + esc(s.store_name||'-') + '</td>'
          + '<td style="padding:12px;color:#888;">' + esc(s.merchant_name||'-') + '</td>'
          + '<td style="padding:12px;text-align:center;">' + (s.total_sessions||0) + '</td>'
          + '<td style="padding:12px;text-align:center;color:#27ae60;">' + (s.online_count||0) + '</td>';
      }
      html += '</tr>';
    });
    html += '</table>';
    document.getElementById('osModalBody').innerHTML = html;
  } catch (e) {
    document.getElementById('osModalBody').innerHTML = '<p style="color:#e74c3c;">' + esc(e.message) + '</p>';
  }
}
window.showStoreBreakdown = showStoreBreakdown;

async function showOnlineSessions() {
  document.getElementById('osModalTitle').textContent = t('onlineClientsByStore');
  document.getElementById('osModalBody').innerHTML = '<p style="color:#888;">' + t('loading') + '</p>';
  document.getElementById('onlineSessionsModal').style.display = 'flex';
  try {
    const d = await SLF.api.get('/super/online-sessions');
    const sessions = (d && d.sessions) || [];
    if (!sessions.length) {
      document.getElementById('osModalBody').innerHTML = '<p style="color:#888;text-align:center;padding:20px;">' + t('noOnlineClients') + '</p>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:14px;color:#ddd;">';
    html += '<tr style="background:rgba(255,255,255,0.08);color:#888;"><th style="padding:10px 12px;text-align:left;font-weight:600;">' + t('storeNameCol') + '</th><th style="padding:10px 12px;text-align:left;font-weight:600;">' + t('merchant') + '</th><th style="padding:10px 12px;text-align:center;font-weight:600;">' + t('currentOnline') + '</th><th style="padding:10px 12px;text-align:center;font-weight:600;">' + t('pendingOrders') + '</th><th style="padding:10px 12px;"></th></tr>';
    sessions.forEach(s => {
      html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.08);">'
        + '<td style="padding:12px;">' + esc(s.store_name||'-') + '</td>'
        + '<td style="padding:12px;color:#888;">' + esc(s.merchant_name||'-') + '</td>'
        + '<td style="padding:12px;text-align:center;font-weight:600;color:#27ae60;">' + (s.online_count||0) + '</td>'
        + '<td style="padding:12px;text-align:center;">' + (s.pending_orders||0) + '</td>'
        + '<td style="padding:12px;text-align:right;"><button type="button" class="show-store-sessions-btn" data-store-id="' + Number(s.store_id || 0) + '" data-store-name="' + esc(s.store_name || '') + '" style="padding:6px 14px;border:none;border-radius:8px;background:#667eea;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">' + t('details') + '</button></td>'
        + '</tr>';
    });
    html += '</table>';
    document.getElementById('osModalBody').innerHTML = html;
    document.querySelectorAll('#osModalBody .show-store-sessions-btn').forEach(button => {
      button.addEventListener('click', function() {
        const storeId = Number(this.dataset.storeId);
        if (!Number.isSafeInteger(storeId) || storeId <= 0) return;
        showStoreSessions(storeId, this.dataset.storeName || '');
      });
    });
  } catch (e) {
    document.getElementById('osModalBody').innerHTML = '<p style="color:#e74c3c;">' + esc(e.message) + '</p>';
  }
}
window.showOnlineSessions = showOnlineSessions;

async function showStoreSessions(storeId, storeName) {
  document.getElementById('osModalTitle').textContent = t('onlineSessionsPrefix') + storeName;
  document.getElementById('osModalBody').innerHTML = '<p style="color:#888;">' + t('loading') + '</p>';
  try {
    const d = await SLF.api.get('/super/online-sessions/' + storeId);
    const sessions = (d && d.sessions) || [];
    if (!sessions.length) {
      document.getElementById('osModalBody').innerHTML = '<p style="color:#888;text-align:center;padding:20px;">' + t('noStoreSessions') + '</p>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;color:#ddd;">';
    html += '<tr style="background:rgba(255,255,255,0.08);color:#888;">' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;">' + t('table') + '</th>' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;">' + t('enterTime') + '</th>' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;">' + t('expireTime') + '</th>' +
      '<th style="padding:10px 12px;text-align:left;font-weight:600;">' + t('currentOrder') + '</th>' +
      '<th style="padding:10px 12px;text-align:right;font-weight:600;">' + t('amountCol') + '</th>' +
      '</tr>';
    sessions.forEach(s => {
      html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.08);">'
        + '<td style="padding:10px;font-weight:600;">' + esc(s.table_name||'-') + '</td>'
        + '<td style="padding:10px;">' + (s.created_at ? new Date(s.created_at).toLocaleString() : '-') + '</td>'
        + '<td style="padding:10px;color:#999;">' + (s.expires_at ? new Date(s.expires_at).toLocaleString() : '-') + '</td>'
        + '<td style="padding:10px;">' + esc(s.active_order_no || '—') + '</td>'
        + '<td style="padding:10px;text-align:right;">' + (s.active_order_total ? '$' + Number(s.active_order_total).toFixed(2) : '-') + '</td>'
        + '</tr>';
    });
    html += '</table>';
    document.getElementById('osModalBody').innerHTML = html;
  } catch (e) {
    document.getElementById('osModalBody').innerHTML = '<p style="color:#e74c3c;">' + esc(e.message) + '</p>';
  }
}
window.showStoreSessions = showStoreSessions;

function closeOnlineSessions() {
  document.getElementById('onlineSessionsModal').style.display = 'none';
}
window.closeOnlineSessions = closeOnlineSessions;
    try { window.backupNow = backupNow; } catch(err) {}
    try { window.changeSuperPassword = changeSuperPassword; } catch(err) {}
    try { window.closeMerchantModal = closeMerchantModal; } catch(err) {}
    try { window.closeOnlineSessions = closeOnlineSessions; } catch(err) {}
    try { window.closeSidebar = closeSidebar; } catch(err) {}
    try { window.deleteMerchant = deleteMerchant; } catch(err) {}
    try { window.editMerchant = editMerchant; } catch(err) {}
    try { window.executePasswordModal = executePasswordModal; } catch(err) {}
    try { window.exportBackup = exportBackup; } catch(err) {}
    try { window.hideConfirm = hideConfirm; } catch(err) {}
    try { window.hidePasswordModal = hidePasswordModal; } catch(err) {}
    try { window.importBackup = importBackup; } catch(err) {}
    try { window.logout = logout; } catch(err) {}
    try { window.refreshCurrentLog = refreshCurrentLog; } catch(err) {}
    try { window.resetData = resetData; } catch(err) {}
    try { window.resetPassword = resetPassword; } catch(err) {}
    try { window.saveBackupSettings = saveBackupSettings; } catch(err) {}
    try { window.saveGlobalSettings = saveGlobalSettings; } catch(err) {}
    try { window.saveMerchant = saveMerchant; } catch(err) {}
    try { window.showAddMerchant = showAddMerchant; } catch(err) {}
    try { window.showOnlineSessions = showOnlineSessions; } catch(err) {}
    try { window.showStoreBreakdown = showStoreBreakdown; } catch(err) {}
    try { window.showStoreSessions = showStoreSessions; } catch(err) {}
    try { window.switchModule = switchModule; } catch(err) {}
    try { window.switchSettingsTab = switchSettingsTab; } catch(err) {}
    try { window.switchSuperLogTab = switchSuperLogTab; } catch(err) {}
    try { window.toggleSidebar = toggleSidebar; } catch(err) {}

// ===== 支付方式配置 =====
let _pmMerchantId = null;

async function openPaymentMethods(merchantId, merchantName) {
  _pmMerchantId = merchantId;
  const nameEl = document.getElementById('pmMerchantName');
  if (nameEl) nameEl.textContent = t('merchantPrefix') + (merchantName || ('#' + merchantId));
  try {
    // 并行拉取：可用支付方式列表 + 当前配置
    const [avail, cfg] = await Promise.all([
      api('/super/merchants/' + merchantId + '/available-methods'),
      api('/super/merchants/' + merchantId + '/payment-methods'),
    ]);
    const methods = cfg.methods || {};
    const listEl = document.getElementById('pmMethodsList');
    const emptyHint = document.getElementById('pmEmptyHint');
    if (!listEl) { SLF.ui.toast('❌ 找不到 pmMethodsList 容器', 'error'); return; }

    // 构建所有选项：内置 + 动态 bank
    const allItems = [
      ...(avail.builtin || []),
      ...(avail.banks || []),
    ];

    if (allItems.length === 0) {
      listEl.innerHTML = '';
      if (emptyHint) emptyHint.style.display = 'block';
      document.getElementById('paymentMethodsModal').classList.add('open');
      return;
    }
    if (emptyHint) emptyHint.style.display = 'none';

    // 动态渲染每个复选框
    listEl.innerHTML = allItems.map(item => {
      const key = item.key;
      const label = item.label || key;
      const icon = item.icon || '';
      const checked = methods[key] !== false ? 'checked' : '';
      // 银行类图标：尝试用 img 加载（可选）
      const iconHtml = item.isBank
        ? '<img src="/assets/vendor/payment-icons/' + key + '.png" alt="" style="width:18px;height:18px;vertical-align:middle;margin-right:4px;" onerror="this.style.display=\'none\'">'
        : icon + ' ';
      return (
        '<label class="super-pay-method">' +
          '<span class="super-strong">' + iconHtml + label + '</span>' +
          '<input class="super-checkbox-lg pm-item-checkbox" type="checkbox" data-key="' + key + '" ' + checked + '>' +
        '</label>'
      );
    }).join('');

    document.getElementById('paymentMethodsModal').classList.add('open');
  } catch (e) {
    SLF.ui.toast('加载失败: ' + e.message, 'error');
  }
}

function closePaymentMethods() {
  const m = document.getElementById('paymentMethodsModal');
  if (m) m.classList.remove('open');
  _pmMerchantId = null;
}

async function savePaymentMethods() {
  if (!_pmMerchantId) return;
  const methods = {};
  document.querySelectorAll('#pmMethodsList .pm-item-checkbox').forEach(cb => {
    methods[cb.dataset.key] = cb.checked;
  });
  try {
    await api('/super/merchants/' + _pmMerchantId + '/payment-methods', {
      method: 'PUT',
      body: JSON.stringify({ methods: methods }),
    });
    SLF.ui.toast('✅ ' + (SLF.t('saved') || '已保存'), 'success');
    closePaymentMethods();
  } catch (e) {
    SLF.ui.toast('❌ ' + (SLF.t('saveFailed') || '保存失败') + ': ' + e.message, 'error');
  }
}

// 挂到 window
try { window.openPaymentMethods = openPaymentMethods; } catch(e) {}
try { window.closePaymentMethods = closePaymentMethods; } catch(e) {}
try { window.savePaymentMethods = savePaymentMethods; } catch(e) {}

})();
