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
    const storeId = waiter.store_id || 1;
    const store = await getAsync('SELECT name FROM stores WHERE id=?', [storeId]);
    const tables = await allAsync('SELECT * FROM tables WHERE store_id=? ORDER BY id', [storeId]);
    const rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND status != 'canceled' ORDER BY createdAt DESC", [storeId]);
    res.json({ waiter, storeName: store?.name || '', tables, orders: rows.map(formatOrder) });
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
