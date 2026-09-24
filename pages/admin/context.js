/*
 * pages/admin/context.js — 共享上下文（在所有模块之前加载）
 */
window.SLF = window.SLF || {};
window.SLF.admin = {
  // 这些值会在 admin.js 加载后被替换
  $: (sel) => document.querySelector(sel),
  api: async (path, opts = {}) => {
    if (opts.method && opts.method !== 'GET') {
      return SLF.api.request(path, { method: opts.method, body: opts.body });
    }
    return SLF.api.get(path);
  },
  tAdmin: (key) => key,
  L: (key) => key,
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  hasPermission: () => true,
  applyPermissions: () => {},
  showConfirm: (msg, cb) => cb && cb(),
  showPasswordModal: (title, cb) => cb && cb(''),
  categoriesCache: () => [],
  menusCache: () => [],
  ordersCache: () => [],
  setCategories: () => {},
  setMenus: () => {},
  setTables: () => {},
  setOrders: () => {},
  dualCurrencyEnabled: false,
  secondaryCurrencyCode: 'USD',
  adminId: 0,
  buildSessionLabels: (orders) => new Map(),
};
