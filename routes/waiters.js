/* ============================================================
   routes/waiters.js — 服务员管理
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.get('/api/admin/waiters', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const rows = await allAsync(
      `SELECT w.id, w.username, w.display_name, w.can_order, w.can_mark_item, w.can_complete_order, w.active, w.store_id, s.name AS store_name
       FROM waiters w
       LEFT JOIN stores s ON s.id = w.store_id
       WHERE w.merchant_id = ?
       ORDER BY w.store_id, w.id`,
      [req.merchantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/waiters', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const { username, password, display_name, can_order, can_mark_item, can_complete_order, store_id } = req.body || {};
    if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写服务员资料' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    const targetStoreId = store_id || req.storeId || 1;
    const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
    if (!store) return res.status(400).json({ error: '店铺不存在' });
    if (await cashierUsernameExists(String(username).trim())) return res.status(409).json({ error: '该用户名已被收银员账号使用，请换一个' });
    const result = await runAsync(
      'INSERT INTO waiters (username, password_hash, display_name, can_order, can_mark_item, can_complete_order, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [String(username).trim(), hashPassword(password), display_name, can_order ? 1 : 0, can_mark_item ? 1 : 0, can_complete_order ? 1 : 0, targetStoreId, req.merchantId]
    );
    res.status(201).json(await getAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=?', [result.lastID]));
  } catch (e) {
    if (String(e.message).includes('Duplicate entry')) return res.status(409).json({ error: '服务员账号已存在' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync(
      'SELECT w.* FROM waiters w JOIN stores s ON s.id = w.store_id WHERE w.id=? AND s.merchant_id=?',
      [id, req.merchantId]
    );
    if (!current) return res.status(404).json({ error: '服务员不存在' });

    const targetStoreId = parseInt(req.body.store_id, 10) || current.store_id;
    const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
    if (!store) return res.status(400).json({ error: '目标店铺不存在或不属于当前商户' });

    const next = { ...current, ...req.body };
    await runAsync(
      'UPDATE waiters SET username=?, display_name=?, can_order=?, can_mark_item=?, can_complete_order=?, active=?, store_id=? WHERE id=?',
      [String(next.username||current.username).trim(), next.display_name||current.display_name, next.can_order?1:0, next.can_mark_item?1:0, next.can_complete_order?1:0, next.active?1:0, targetStoreId, id]
    );
    if (req.body.password) {
      if (req.body.password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      await runAsync('UPDATE waiters SET password_hash=? WHERE id=?', [hashPassword(req.body.password), id]);
    }
    res.json(await getAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync(
      'SELECT w.* FROM waiters w JOIN stores s ON s.id = w.store_id WHERE w.id=? AND s.merchant_id=?',
      [id, req.merchantId]
    );
    if (!current) return res.status(404).json({ error: '服务员不存在' });
    await runAsync('DELETE FROM waiters WHERE id=?', [id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 店铺管理 -----

};
