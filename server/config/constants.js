/* ============================================================
   server/config/constants.js — 常量与格式化工具
   ============================================================ */

function formatGlobalDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatGlobalTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const VALID_LANGS = ['zh', 'en', 'vi', 'th', 'km'];

const DEFAULT_CREDENTIALS = {
  superAdmin: {
    username:    process.env.INIT_SUPER_USERNAME   || 'superadmin',
    password:    process.env.INIT_SUPER_PASSWORD   || 'super123',
    displayName: '超级管理员',
  },
  merchantAdmin: {
    username:    process.env.INIT_ADMIN_USERNAME   || 'admin',
    password:    process.env.INIT_ADMIN_PASSWORD   || 'admin123',
    displayName: 'FoodFlow管理员',
  },
  waiter: {
    username:    process.env.INIT_WAITER_USERNAME  || 'waiter',
    password:    process.env.INIT_WAITER_PASSWORD  || '123456',
    displayName: '服务员A',
  },
  cashier: {
    username:    process.env.INIT_CASHIER_USERNAME || 'cashier',
    password:    process.env.INIT_CASHIER_PASSWORD || '123456',
    displayName: '收银员',
  },
};

module.exports = { formatGlobalDateTime, formatGlobalTime, VALID_LANGS, DEFAULT_CREDENTIALS };
