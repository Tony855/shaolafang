/*
 * pages/admin/context.js — 共享上下文（在所有模块之前加载）
 */
window.SLF = window.SLF || {};
window.SLF.admin = {
  // null-safe $ : 找不到元素时返回空壳对象，避免整页崩
  $: (sel) => {
    const el = document.querySelector(sel);
    if (el) return el;
    return {
      textContent: '',
      innerHTML: '',
      value: '',
      placeholder: '',
      checked: false,
      disabled: false,
      style: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
      addEventListener: () => {},
      removeEventListener: () => {},
      setAttribute: () => {},
      removeAttribute: () => {},
      getAttribute: () => null,
      appendChild: () => {},
      removeChild: () => {},
      focus: () => {},
      blur: () => {},
      click: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      dataset: {}
    };
  },
  api: async (path, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    return SLF.api._request(method, path, { body: opts.body });
  },
  tAdmin: (key) => (SLF.i18n && SLF.i18n.t ? SLF.i18n.t(key) : key),
  L: (key) => (SLF.i18n && SLF.i18n.t ? SLF.i18n.t(key) : key),
  esc: (s) => String(s ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c])),
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
  dualCurrencyEnabled: () => false,
  secondaryCurrencyCode: () => '',
  secondaryCurrencyCode: 'USD',
  adminId: 0,
  buildSessionLabels: (orders) => new Map(),
};
