/* ============================================================
   server/services/order.js — 订单辅助函数
   ============================================================ */
const { getAsync } = require('../db/helpers');
const { verifyPassword } = require('../middleware/password');

function formatOrder(row) {
  let items = row.items;
  let dataCorrupted = false;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (_) {
      console.warn(`订单 ${row.id} 的 items 解析失败，原始内容:`, items);
      items = []; dataCorrupted = true;
    }
  } else if (!Array.isArray(items)) {
    items = []; dataCorrupted = true;
  }
  for (const item of items) {
    if (!item.itemStatus) item.itemStatus = 'pending';
  }
  return {
    id: row.id,
    store_id: row.store_id,
    merchant_id: row.merchant_id,
    table: row.table_name,
    order_no: row.order_no || '',
    table_name: row.table_name,
    items,
    total: row.total,
    status: row.status,
    createdAt: row.createdAt,
    sessionToken: row.session_token || '',
    customerToken: row.customer_token || '',
    note: row.note || '',
    dataCorrupted
  };
}

async function normalizeOrderItems(items, storeId) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('订单至少需要一道菜品');
  const normalized = [];
  for (const item of items) {
    const menuId = Number(item.id);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(menuId) || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('菜品或数量无效');
    }
    const menuItem = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [menuId, storeId || 1]);
    if (!menuItem) throw new Error(`菜品不存在（ID: ${menuId}）`);
    const store = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [menuItem.store_id || 1]);
    if (!store) throw new Error(`菜品所属店铺不存在（ID: ${menuItem.store_id}）`);
    const currency = await getAsync('SELECT code, rate FROM currencies WHERE code=? AND merchant_id=?', [menuItem.currency_code || 'USD', store.merchant_id]);
    if (!currency || !(Number(currency.rate) > 0)) throw new Error(`菜品货币无效（${menuItem.currency_code || 'CNY'}）`);
    normalized.push({
      id: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      currency_code: currency.code,
      base_price: Number(menuItem.price) / Number(currency.rate),
      quantity,
      emoji: menuItem.emoji || '🍽️',
      itemStatus: item.itemStatus || 'pending',
      show_dual: 0,
      secondary_currency_code: '',
      unit: item.unit || menuItem.unit || '份'
    });
  }
  return normalized;
}

async function assertTableExists(table, storeId) {
  const normalized = String(table || '').trim();
  if (!normalized) throw new Error('请选择桌号');
  const existing = await getAsync('SELECT name FROM tables WHERE name = ? AND store_id = ?', [normalized, storeId || 1]);
  if (!existing) throw new Error('桌号不存在');
  return normalized;
}

async function verifyLegacyAdminPassword(inputPwd) {
  const row = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_password'");
  if (!row || !row.value) return false;
  return verifyPassword(inputPwd, row.value);
}

module.exports = { formatOrder, normalizeOrderItems, assertTableExists, verifyLegacyAdminPassword };
