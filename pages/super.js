/*
 * FoodFlow · super 页面逻辑（由内联脚本抽出，onclick 函数挂 window）
 */
(function(){
'use strict';
// ===== i18n =====
let currentLang = SLF.store.rawGet('superLang') || SLF.store.rawGet('lang') || 'zh';

SLF.i18n.init(currentLang);

function changeSuperLang(lang) {
  currentLang = lang;
  SLF.i18n.lang = lang;
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
  const loginSel = document.getElementById('loginLangSelect');
  if (loginSel) loginSel.value = currentLang;
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
    dashboard: t('dashboard', null, '仪表盘'),
    merchants: t('merchantManage', null, '商户管理'),
    stores: t('storeOverview', null, '门店总览'),
    logs: t('logs', null, '日志'),
    settings: t('systemSettings', null, '系统设置'),
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

  const loginTitle = document.querySelector('.login-card h1');
  if (loginTitle) loginTitle.textContent = '🔐 ' + t('superAdmin', null, '超级管理员');
  const loginLabels = document.querySelectorAll('.login-card .form-group label');
  if (loginLabels && loginLabels[0]) loginLabels[0].textContent = t('username', null, '用户名');
  if (loginLabels && loginLabels[1]) loginLabels[1].textContent = t('password', null, '密码');
  const loginUsername = document.getElementById('loginUsername');
  if (loginUsername) loginUsername.placeholder = t('username', null, '请输入用户名');
  const loginPassword = document.getElementById('loginPassword');
  if (loginPassword) loginPassword.placeholder = t('password', null, '请输入密码');
  const loginBtn = document.querySelector('.login-btn');
  if (loginBtn) loginBtn.textContent = t('login', null, '登录');

  const adminName = document.getElementById('adminName');
  if (adminName) adminName.textContent = t('superAdmin', null, '超级管理员');
  document.querySelectorAll('.logout-btn').forEach(btn => btn.textContent = t('logout', null, '退出登录'));

  const titleEl = document.getElementById('pageTitle');
  if (titleEl && currentModule) {
    const titles = {
      dashboard: t('dashboard', null, '仪表盘'),
      merchants: t('merchantManage', null, '商户管理'),
      stores: t('storeOverview', null, '门店总览'),
      logs: t('logs', null, '日志'),
      settings: t('systemSettings', null, '系统设置')
    };
    if (titles[currentModule]) titleEl.textContent = titles[currentModule];
  }

  const errorModalTitle = document.getElementById('errorModalTitle');
  if (errorModalTitle) errorModalTitle.textContent = t('loginFailed', null, '登录失败');
  const errorModalMessage = document.getElementById('errorModalMessage');
  if (errorModalMessage) errorModalMessage.textContent = t('loginError', null, '登录失败，请重试');
  const errorModalBtn = document.querySelector('.error-modal-btn');
  if (errorModalBtn) errorModalBtn.textContent = t('confirm', null, '确定');
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

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!username || !password) {
    showError(t('pleaseEnterCredentials', null, '请输入用户名和密码'));
    return;
  }
  try {
    const data = await SLF.api.post('/super/login', { username, password });
    if (!data || !data.token) {
      throw new Error((data && data.error) || t('loginFailed', null, '登录失败'));
    }
    token = data.token;
    SLF.store.rawSet('superToken', token);
    SLF.store.rawSet('superAdmin', JSON.stringify(data.admin || {}));
    showApp();
  } catch (e) {
    showError(e.message || t('loginError', null, '登录失败，请重试'));
  }
}

function showError(msg, title) {
  document.getElementById('errorModalTitle').textContent = title || t('loginFailed', null, '登录失败');
  document.getElementById('errorModalMessage').textContent = msg || t('loginError', null, '登录失败，请重试');
  document.getElementById('errorModal').classList.add('open');
}
function hideErrorModal() {
  document.getElementById('errorModal').classList.remove('open');
}
window.hideErrorModal = hideErrorModal;
document.getElementById('errorModal').addEventListener('click', function(e) {
  if (e.target === this) hideErrorModal();
});

function showApp() {
  applyI18n();
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  const admin = JSON.parse(SLF.store.rawGet('superAdmin') || '{}');
  document.getElementById('adminName').textContent = admin.display_name || t('superAdmin', null, '超级管理员');
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
    dashboard: t('dashboard', null, '仪表盘'),
    merchants: t('merchantManage', null, '商户管理'),
    stores: t('storeOverview', null, '门店总览'),
    logs: t('logs', null, '日志'),
    settings: t('systemSettings', null, '系统设置')
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
    // super 页面 401 → 回本页登录卡片，不跳 /login
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
  const lp = document.getElementById('loginPage');
  const ap = document.getElementById('app');
  if (lp) lp.style.display = 'flex';
  if (ap) ap.style.display = 'none';
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
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888;padding:20px;">暂无门店</td></tr>';
      return;
    }
    tbody.innerHTML = stores.map(s => `
      <tr style="border-bottom:1px solid rgba(255,255,255,.05);">
        <td data-label="门店" style="font-weight:600;color:#fff;">${esc(s.store_name)}</td>
        <td data-label="商户" style="color:#888;font-size:13px;">${esc(s.merchant_name)}</td>
        <td data-label="总订单" style="text-align:right;color:#fff;">${s.total_orders || 0}</td>
        <td data-label="今日订单" style="text-align:right;color:#ffd93d;">${s.today_orders || 0}</td>
        <td data-label="今日营收" style="text-align:right;color:#2ecc71;font-weight:700;">$${Number(s.today_revenue || 0).toFixed(2)}</td>
        <td data-label="累计扫码" style="text-align:right;color:#888;">${s.total_sessions || 0}</td>
        <td data-label="当前在线" style="text-align:right;color:#27ae60;font-weight:600;">${s.online_count || 0}</td>
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
    // 向后兼容：旧 id statRevenue
    const srEl = document.getElementById('statRevenue');
    if (srEl) srEl.textContent = '$' + Number(stats.todayRevenue).toFixed(2);
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
    document.getElementById('cpuCores').textContent = data.cpu.cores + ' 核心';
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

async function loadMerchants() {
  try {
    const list = await api('/super/merchants');
    document.getElementById('merchantList').innerHTML = list.map(m => `
      <tr>
        <td data-label="商户名称" style="font-weight:700;color:#fff;font-size:15px;">${esc(m.name)}</td>
        <td data-label="商户编码"><span style="display:inline-block;background:rgba(255,217,61,.12);color:#ffd93d;padding:3px 10px;border-radius:6px;font-family:monospace;font-size:13px;font-weight:600;">${esc(m.code)}</span></td>
        <td data-label="商户账号"><span style="display:inline-block;background:rgba(102,204,255,.1);color:#66ccff;padding:3px 10px;border-radius:6px;font-family:monospace;font-size:13px;">${esc(m.admin_username) || '-'}</span></td>
        <td data-label="联系人" style="color:#ccc;">${esc(m.contact_name) || '-'}</td>
        <td data-label="联系电话" style="color:#999;font-family:monospace;font-size:13px;">${esc(m.contact_phone) || '-'}</td>
        <td data-label="门店数"><span style="color:#aaa;">${m.store_count}</span><span style="color:#666;"> / </span><span style="color:#ffd93d;font-weight:600;">${m.max_stores}</span></td>
        <td data-label="状态"><span class="status-badge ${m.status === 1 ? 'status-active' : 'status-disabled'}">${m.status === 1 ? t('enabled', null, '启用') : t('disabled', null, '禁用')}</span></td>
        <td>
          <button class="action-btn primary" onclick="editMerchant(${m.id})">编辑</button>
          <button class="action-btn warning" onclick="resetPassword(${m.id})">重置密码</button>
          ${m.id != 1 ? `<button class="action-btn danger" onclick="deleteMerchant(${m.id})">删除</button>` : ''}
        </td>
      </tr>
    `).join('');
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function translateLoginMessage(msg) {
  if (!msg) return '';
  if (msg.includes('商户管理员登录成功')) { const username = msg.split(':')[1] || ''; return t('merchantAdminLogin', null, '商户管理员登录') + ': ' + username.trim(); }
  if (msg.includes('超级管理员登录成功')) { const username = msg.split(':')[1] || ''; return t('superAdminLogin', null, '超级管理员登录') + ': ' + username.trim(); }
  if (msg.includes('服务员登录成功')) return t('loginSuccess', null, '登录成功');
  if (msg.includes('收银员登录成功')) return t('loginSuccess', null, '登录成功');
  if (msg.includes('用户名不存在') || msg.includes('账号不存在')) return t('usernameNotExist', null, '用户名不存在');
  if (msg.includes('密码错误')) return t('passwordError', null, '密码错误');
  if (msg.includes('请输入用户名和密码')) return t('pleaseEnterCredentials', null, '请输入用户名和密码');
  if (msg.includes('IP不在白名单内')) return t('noPermission', null, '无权限');
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
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#888;padding:40px;">暂无登录日志</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map(l => {
      const time = l.createdAt ? formatDateTime(l.createdAt) : '-';
      const statusBadge = l.success === 1 ? '<span style="color:#2ecc71;font-weight:600;">✅ 成功</span>' : '<span style="color:#e74c3c;font-weight:600;">❌ 失败</span>';
      const typeBadge = l.login_type === 'super_admin'
        ? '<span style="background:rgba(102,126,234,.2);color:#667eea;padding:2px 8px;border-radius:4px;font-size:11px;">超级管理员</span>'
        : '<span style="background:rgba(232,93,58,.2);color:#e85d3a;padding:2px 8px;border-radius:4px;font-size:11px;">商户管理员</span>';
      return `<tr>
        <td data-label="ID"><span style="color:#ffd93d;font-family:monospace;font-weight:600;">#${l.id}</span></td>
        <td data-label="登录时间" style="white-space:nowrap;color:#ccc;font-size:13px;">${time}</td>
        <td data-label="登录名" style="font-weight:600;color:#fff;">${esc(l.username) || '-'}</td>
        <td data-label="所属商户" style="color:#ccc;">${esc(l.merchant_name) || '-'}</td>
        <td data-label="登录IP" style="font-family:monospace;color:#999;font-size:13px;">${esc(l.ip) || '-'}</td>
        <td data-label="登录地点" style="color:#999;font-size:13px;">${esc(l.location) || '-'}</td>
        <td data-label="登录类型">${typeBadge}</td>
        <td data-label="状态">${statusBadge}</td>
        <td data-label="备注" style="color:#888;font-size:12px;">${esc(translateLoginMessage(l.message))}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    document.getElementById('loginLogList').innerHTML = '<tr><td colspan="9" style="text-align:center;color:#e74c3c;padding:40px;">加载失败: ' + esc(e.message) + '</td></tr>';
  }
}

async function loadStores() {
  try {
    const stores = await api('/super/stores');
    const list = Array.isArray(stores) ? stores : [];
    document.getElementById('storeList').innerHTML = list.map(s => `
      <tr>
        <td data-label="门店ID"><span style="display:inline-block;background:rgba(255,217,61,.12);color:#ffd93d;padding:3px 10px;border-radius:6px;font-family:monospace;font-size:13px;font-weight:600;">#${s.id}</span></td>
        <td data-label="门店名称" style="font-weight:600;color:#fff;">${esc(s.name)}</td>
        <td data-label="所属商户" style="color:#ccc;">${esc(s.merchant_name) || t('unknown', null, '未知')}</td>
        <td data-label="编码"><code style="color:#66ccff;font-family:monospace;font-size:13px;">${esc(s.code) || '-'}</code></td>
        <td data-label="地址" style="color:#999;font-size:13px;">${esc(s.address) || '-'}</td>
        <td data-label="状态"><span class="status-badge ${s.active ? 'status-active' : 'status-disabled'}">${s.active ? t('enabled', null, '启用') : t('disabled', null, '禁用')}</span></td>
      </tr>
    `).join('');
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function showAddMerchant() {
  document.getElementById('merchantModalTitle').innerHTML = '新增商户<span class="modal-close" onclick="closeMerchantModal()">✕</span>';
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
  document.getElementById('merchantUsername').disabled = false;
  document.getElementById('merchantModal').classList.add('open');
}

async function editMerchant(id) {
  try {
    const list = await api('/super/merchants');
    const m = list.find(x => x.id === id);
    if (!m) return;
    document.getElementById('merchantModalTitle').innerHTML = '编辑商户<span class="modal-close" onclick="closeMerchantModal()">✕</span>';
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
    document.getElementById('merchantUsername').disabled = false;
    document.getElementById('merchantModal').classList.add('open');
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function closeMerchantModal() { document.getElementById('merchantModal').classList.remove('open'); }
window.closeMerchantModal = closeMerchantModal;

async function saveMerchant() {
  const id = document.getElementById('editMerchantId').value;
  const data = {
    name: document.getElementById('merchantName').value.trim(),
    code: document.getElementById('merchantCode').value.trim(),
    username: document.getElementById('merchantUsername').value.trim(),
    password: document.getElementById('merchantPassword').value.trim(),
    contact_name: document.getElementById('merchantContact').value.trim(),
    contact_phone: document.getElementById('merchantPhone').value.trim(),
    max_stores: parseInt(document.getElementById('merchantMaxStores').value) || 1,
    status: parseInt(document.getElementById('merchantStatus').value)
  };
  if (!data.name) { SLF.ui.toast(t('merchantNameRequired', null, '商户名称必填'), 'error'); return; }
  if (!data.username) { SLF.ui.toast(t('accountRequired', null, '请输入账号'), 'error'); return; }
  try {
    if (id) {
      await api('/super/merchants/' + id, { method: 'PUT', body: JSON.stringify(data) });
      SLF.ui.toast(t('merchantUpdated', null, '商户已更新'), 'success');
    } else {
      const result = await api('/super/merchants', { method: 'POST', body: JSON.stringify(data) });
      SLF.ui.toast(t('merchantCreated', { username: result.adminUsername, password: result.defaultPassword }, '商户已创建'), 'success');
    }
    closeMerchantModal();
    loadMerchants();
  } catch (e) { SLF.ui.toast(e.message, 'error'); }
}

function deleteMerchant(id) {
  showConfirm(t('confirmDeleteMerchant', null, '确认删除该商户？'), async function() {
    try {
      await api('/super/merchants/' + id, { method: 'DELETE' });
      SLF.ui.toast(t('merchantDeleted', null, '商户已删除'), 'success');
      loadMerchants();
    } catch (e) { SLF.ui.toast(e.message, 'error'); }
  });
}

function resetPassword(id) {
  showConfirm(t('confirmResetPassword', null, '确认重置该商户管理员密码为 admin123？'), async function() {
    try {
      await api('/super/merchants/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({}) });
      SLF.ui.toast(t('passwordReset', null, '密码已重置'), 'success');
    } catch (e) { SLF.ui.toast(e.message, 'error'); }
  });
}

function changeSuperPassword() {
  const newPwd = document.getElementById('newSuperPassword').value;
  if (!newPwd) { SLF.ui.toast(t('pleaseEnterNewPassword', null, '请输入新密码（至少6位）'), 'error'); return; }
  if (newPwd.length < 6) { SLF.ui.toast('❌ ' + t('passwordTooShort', null, '密码至少6位'), 'error'); return; }
  showPasswordModal(t('enterOldPassword', null, '请输入旧密码'), async function(oldPwd) {
    try {
      const data = await SLF.api.post('/super/change-password', { oldPassword: oldPwd, newPassword: newPwd });
      if (!data || !data.success) throw new Error((data && data.error) || t('saveFailed', null, '保存失败'));
      SLF.ui.toast('✅ ' + t('passwordChanged', null, '密码已更新'), 'success');
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
    setVal('cleanLoginLog', settings.clean_login_log ? '1' : '0');
    setVal('cleanAuditLog', settings.clean_audit_log ? '1' : '0');
  } catch (e) { SLF.ui.toast(t('loadFailed', null, '加载失败') + ': ' + e.message, 'error'); }
}

function switchSettingsTab(tab) {
  const tabs = { timeout: 'tabTimeout', order: 'tabOrder', security: 'tabSecurity', callLimit: 'tabCallLimit', log: 'tabLog' };
  const panels = { timeout: 'timeoutSettings', order: 'orderSettings', security: 'securitySettings', callLimit: 'callLimitSettings', log: 'logSettings' };
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
    SLF.ui.toast(t('settingsSaved', null, '设置已保存'), 'success');
  } catch (e) { SLF.ui.toast(t('saveFailed', null, '保存失败') + ': ' + e.message, 'error'); }
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
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#666;">暂无操作记录</td></tr>';
      return;
    }
    const actionNames = {
      'create_merchant': '创建商户', 'update_merchant': '编辑商户', 'delete_merchant': '删除商户',
      'reset_merchant_password': '重置商户密码', 'create_store': '创建店铺', 'update_store': '编辑店铺',
      'delete_store': '删除店铺', 'settle_order': '结算订单', 'cancel_order': '取消订单',
      'reset_data': '重置数据', 'change_password': '修改密码', 'update_settings': '更新设置',
      'reset_all_data': '重置所有数据', 'login': '登录', 'logout': '登出',
      'backup': '数据备份', 'import_backup': '导入备份'
    };
    const targetTypeNames = {
      'merchant': '商户', 'merchant_admin': '管理员', 'store': '店铺', 'menu': '菜品',
      'category': '分类', 'waiter': '服务员', 'table': '桌号', 'currency': '货币',
      'order': '订单', 'settings': '设置', 'system': '系统', 'super_admin': '超级管理员'
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
    document.getElementById('auditLogsBody').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#e74c3c;">加载失败: ' + esc(e.message) + '</td></tr>';
  }
}


// 通用确认弹窗
let confirmCallback = null;
function showConfirm(message, callback, title) {
  document.getElementById('confirmModalTitle').textContent = title || t('confirmOperation', null, '确认操作');
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
  document.getElementById('passwordModalTitle').textContent = title || t('verifyPassword', null, '验证密码');
  document.getElementById('passwordModalMessage').textContent = message || t('enterPasswordVerify', null, '请输入密码以验证身份');
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
  if (!password) { SLF.ui.toast(t('enterPassword', null, '请输入密码'), 'error'); return; }
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
    showConfirm(t('confirmResetData', null, '确认重置所有订单数据？此操作不可恢复'), async function() {
      try {
        const data = await SLF.api.post('/super/reset-data', { password });
        if (!data || !data.success) throw new Error((data && data.error) || t('resetFailed', null, '重置失败'));
        SLF.ui.toast('✅ ' + t('orderDataReset', null, '订单数据已重置'), 'success');
      } catch (e) {
        SLF.ui.toast('❌ ' + t('resetFailed', null, '重置失败') + ': ' + e.message, 'error');
      }
    }, t('confirmResetDataTitle', null, '重置数据确认'));
  }, t('verifySuperPassword', null, '请输入超级管理员密码验证'));
}

// ===== 数据备份 =====
let selectedBackupFile = null;

async function loadBackupSettings() {
  try {
    const data = await api('/super/backup/settings');
    const sel = document.getElementById('backupIntervalSelect');
    if (sel) sel.value = String(data.intervalHours || 24);
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
    if (!res.ok) throw new Error(t('exportFailed', null, '导出失败'));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'foodflow-backup-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    SLF.ui.toast('✅ ' + t('backupExported', null, '备份已导出'), 'success');
  } catch (e) {
    SLF.ui.toast('❌ ' + t('exportFailed', null, '导出失败') + ': ' + e.message, 'error');
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
    SLF.ui.toast('⚠️ ' + t('pleaseSelectBackupFile', null, '请选择备份文件'), 'error');
    return;
  }
  showConfirm(t('confirmImportBackup', null, '确认导入备份？当前数据将被覆盖'), async function() {
    try {
      const text = await selectedBackupFile.text();
      const data = JSON.parse(text);
      const result = await SLF.api.post('/super/backup/import', data);
      if (!result || !result.success) throw new Error((result && result.error) || t('importFailed', null, '导入失败'));
      SLF.ui.toast('✅ ' + t('backupImported', null, '备份已导入'), 'success');
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      SLF.ui.toast('❌ ' + t('importFailed', null, '导入失败') + ': ' + e.message, 'error');
    }
  });
}
window.importBackup = importBackup;

async function saveBackupSettings() {
  try {
    const intervalHours = document.getElementById('backupIntervalSelect').value;
    await api('/super/backup/settings', { method: 'PUT', body: JSON.stringify({ intervalHours }) });
    SLF.ui.toast('✅ ' + t('backupSettingsSaved', null, '备份设置已保存'), 'success');
  } catch (e) {
    SLF.ui.toast('❌ ' + t('saveFailed', null, '保存失败'), 'error');
  }
}
window.saveBackupSettings = saveBackupSettings;

async function backupNow() {
  try {
    await api('/super/backup/now', { method: 'POST' });
    SLF.ui.toast('✅ ' + t('backupGenerated', null, '备份已生成'), 'success');
    loadBackupSettings();
  } catch (e) {
    SLF.ui.toast('❌ ' + t('backupFailed', null, '备份失败'), 'error');
  }
}
window.backupNow = backupNow;

// 登录回车
document.getElementById('loginPassword').addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); });

// 初始化
applyI18n();
if (token) showApp();

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
    try { window.doLogin = doLogin; } catch(err) {}
    try { window.editMerchant = editMerchant; } catch(err) {}
    try { window.executePasswordModal = executePasswordModal; } catch(err) {}
    try { window.exportBackup = exportBackup; } catch(err) {}
    try { window.hideConfirm = hideConfirm; } catch(err) {}
    try { window.hideErrorModal = hideErrorModal; } catch(err) {}
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
    try { window.changeSuperLang = changeSuperLang; } catch(err) {}
    try { window.loadLoginLogs = loadLoginLogs; } catch(err) {}
})();
;
// ===== 在线会话/门店统计弹窗 =====
async function showStoreBreakdown(type, period) {
  period = period || 'today';
  const periodLabel = { today: '今日', month: '本月', year: '年度' }[period];

  const titles = {
    orders: '订单总数（按门店）',
    revenue: periodLabel + '营业额（按门店）',
    sessions: '扫码会话（按门店）'
  };
  document.getElementById('osModalTitle').textContent = titles[type] || '门店统计';
  document.getElementById('osModalBody').innerHTML = '<p style="color:#888;">加载中...</p>';
  document.getElementById('onlineSessionsModal').style.display = 'flex';
  try {
    const d = await SLF.api.get('/super/store-breakdown');
    const stores = (d && d.stores) || [];
    if (!stores.length) {
      document.getElementById('osModalBody').innerHTML = '<p style="color:#888;text-align:center;padding:20px;">暂无门店</p>';
      return;
    }
    const cols = {
      orders: ['门店', '商户', '总订单', '今日订单'],
      revenue: ['门店', '商户', periodLabel + '营业额', periodLabel + '订单'],
      sessions: ['门店', '商户', '累计扫码', '当前在线']
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
  document.getElementById('osModalTitle').textContent = '在线客户端（按门店）';
  document.getElementById('osModalBody').innerHTML = '<p style="color:#888;">加载中...</p>';
  document.getElementById('onlineSessionsModal').style.display = 'flex';
  try {
    const d = await SLF.api.get('/super/online-sessions');
    const sessions = (d && d.sessions) || [];
    if (!sessions.length) {
      document.getElementById('osModalBody').innerHTML = '<p style="color:#888;text-align:center;padding:20px;">暂无在线客户端</p>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:14px;color:#ddd;">';
    html += '<tr style="background:rgba(255,255,255,0.08);color:#888;"><th style="padding:10px 12px;text-align:left;font-weight:600;">门店</th><th style="padding:10px 12px;text-align:left;font-weight:600;">商户</th><th style="padding:10px 12px;text-align:center;font-weight:600;">在线桌号</th><th style="padding:10px 12px;text-align:center;font-weight:600;">待结订单</th><th style="padding:10px 12px;"></th></tr>';
    sessions.forEach(s => {
      html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.08);">'
        + '<td style="padding:12px;">' + esc(s.store_name||'-') + '</td>'
        + '<td style="padding:12px;color:#888;">' + esc(s.merchant_name||'-') + '</td>'
        + '<td style="padding:12px;text-align:center;font-weight:600;color:#27ae60;">' + (s.online_count||0) + '</td>'
        + '<td style="padding:12px;text-align:center;">' + (s.pending_orders||0) + '</td>'
        + '<td style="padding:12px;text-align:right;"><button onclick="showStoreSessions(' + s.store_id + ',\'' + esc(s.store_name||'').replace(/'/g,"") + '\')" style="padding:6px 14px;border:none;border-radius:8px;background:#667eea;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">详情</button></td>'
        + '</tr>';
    });
    html += '</table>';
    document.getElementById('osModalBody').innerHTML = html;
  } catch (e) {
    document.getElementById('osModalBody').innerHTML = '<p style="color:#e74c3c;">' + esc(e.message) + '</p>';
  }
}
window.showOnlineSessions = showOnlineSessions;

async function showStoreSessions(storeId, storeName) {
  document.getElementById('osModalTitle').textContent = '在线会话 - ' + storeName;
  document.getElementById('osModalBody').innerHTML = '<p style="color:#888;">加载中...</p>';
  try {
    const d = await SLF.api.get('/super/online-sessions/' + storeId);
    const sessions = (d && d.sessions) || [];
    if (!sessions.length) {
      document.getElementById('osModalBody').innerHTML = '<p style="color:#888;text-align:center;padding:20px;">该店暂无在线会话</p>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;color:#ddd;">';
    html += '<tr style="background:rgba(255,255,255,0.08);color:#888;"><th style="padding:10px 12px;text-align:left;font-weight:600;">桌号</th><th style="padding:10px 12px;text-align:left;font-weight:600;">进店时间</th><th style="padding:10px 12px;text-align:left;font-weight:600;">过期时间</th><th style="padding:10px 12px;text-align:left;font-weight:600;">当前订单</th><th style="padding:10px 12px;text-align:right;font-weight:600;">金额</th></tr>';
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
    try { window.doLogin = doLogin; } catch(err) {}
    try { window.editMerchant = editMerchant; } catch(err) {}
    try { window.executePasswordModal = executePasswordModal; } catch(err) {}
    try { window.exportBackup = exportBackup; } catch(err) {}
    try { window.hideConfirm = hideConfirm; } catch(err) {}
    try { window.hideErrorModal = hideErrorModal; } catch(err) {}
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
})();
