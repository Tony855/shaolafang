/* ============================================================
   routes/waiter-overview.js — 服务员总览
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.get('/api/waiter/overview', async (req, res) => {
  try {
    const waiter = await getWaiterFromRequest(req);
    if (!waiter) return res.status(401).json({ error: '请先登录服务员账号' });
    const storeId = Number(waiter.store_id);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return res.status(403).json({ error: '服务员未绑定有效门店' });
    }
    const store = await getAsync('SELECT id, name FROM stores WHERE id=? AND merchant_id=?', [storeId, waiter.merchant_id]);
    if (!store) return res.status(403).json({ error: '服务员所属门店不存在或已变更' });
    const tables = await allAsync('SELECT id, name, status, store_id FROM tables WHERE store_id=? ORDER BY id', [storeId]);
    const rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND status != 'canceled' ORDER BY createdAt DESC", [storeId]);
    const safeWaiter = {
      id: waiter.id, username: waiter.username, display_name: waiter.display_name,
      can_order: waiter.can_order, can_mark_item: waiter.can_mark_item,
      can_complete_order: waiter.can_complete_order, active: waiter.active,
      store_id: waiter.store_id, merchant_id: waiter.merchant_id
    };
    const orders = rows.map(row => {
      const formatted = formatOrder(row);
      delete formatted.sessionToken;
      delete formatted.customerToken;
      return formatted;
    });
    res.json({ waiter: safeWaiter, storeName: store.name, tables, orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 服务员管理 -----

async function cashierUsernameExists(username) {
  const rows = await allAsync("SELECT `key`, value FROM settings WHERE `key` LIKE 'cashiers_%'");
  for (const row of rows) {
    try {
      const list = JSON.parse(row.value);
      if (list.find(c => c.username === username)) return true;
    } catch (e) {}
  }
  return false;
}


};
