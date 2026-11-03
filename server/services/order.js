/* ============================================================
   server/services/order.js — 订单辅助函数
   ============================================================ */
const { getAsync } = require('../db/helpers');
const { hashPassword, verifyPassword, needsRehash } = require('../middleware/password');

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
    settled_at: row.settled_at || '',
    sessionToken: row.session_token || '',
    customerToken: row.customer_token || '',
    note: row.note || '',
    awaiting_confirm: Number(row.awaiting_confirm) || 0,
    pay_method: row.pay_method || '',
    cash_received: Number(row.cash_received) || 0,
    cash_change: Number(row.cash_change) || 0,
    dataCorrupted
  };
}

async function normalizeOrderItems(items, storeId) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('订单至少需要一道菜品');
  const normalized = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('菜品数据格式无效');
    const menuId = Number(item.id);
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(menuId) || menuId <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error('菜品或数量无效');
    }
    const menuItem = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ? AND active=1', [menuId, storeId || 1]);
    if (!menuItem) throw new Error(`菜品不存在、已下架或不属于当前门店（ID: ${menuId}）`);
    const store = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [menuItem.store_id || 1]);
    if (!store) throw new Error(`菜品所属店铺不存在（ID: ${menuItem.store_id}）`);
    const currency = await getAsync('SELECT code, rate FROM currencies WHERE code=? AND merchant_id=?', [menuItem.currency_code || 'USD', store.merchant_id]);
    const price = Number(menuItem.price);
    const rate = Number(currency?.rate);
    if (!currency || !Number.isFinite(price) || price < 0 || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`菜品价格或货币汇率无效（${menuItem.currency_code || 'USD'}）`);
    }
    normalized.push({
      id: menuItem.id,
      name: menuItem.name,
      price,
      currency_code: currency.code,
      base_price: price / rate,
      quantity,
      emoji: menuItem.emoji || '🍽️',
      // Kitchen status and unit are server-controlled; ignore client-supplied values.
      itemStatus: 'pending',
      show_dual: 0,
      secondary_currency_code: '',
      unit: menuItem.unit || '份'
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
  if (!row || !row.value || !verifyPassword(inputPwd, row.value)) return false;
  if (needsRehash(row.value)) {
    const upgradedHash = hashPassword(inputPwd);
    await runAsync("UPDATE settings SET value=? WHERE `key` = 'admin_password' AND value=?", [upgradedHash, row.value]);
  }
  return true;
}

module.exports = { formatOrder, normalizeOrderItems, assertTableExists, verifyLegacyAdminPassword };
