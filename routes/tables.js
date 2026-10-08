/* ============================================================
   routes/tables.js — 桌台管理
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.get('/api/tables', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || req.get('X-Store-Id') || '1', 10);
    const rows = await allAsync('SELECT * FROM tables WHERE store_id=? ORDER BY id', [storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tables', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const { name, status } = req.body;
    if (!name) return res.status(400).json({ error: '桌号名称必填' });
    const result = await runAsync(
      'INSERT INTO tables (name, status, store_id, merchant_id) VALUES (?, ?, ?, ?)',
      [name, status || 'available', req.storeId || 1, req.merchantId]
    );
    await runAsync('UPDATE tables SET qr_token=? WHERE id=?', [createTableToken(), result.lastID]);
    const newTable = await getAsync('SELECT * FROM tables WHERE id = ?', [result.lastID]);
    res.status(201).json(newTable);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 整桌转移：把整个桌的所有未结算订单转到目标桌 -----
app.post('/api/tables/move', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const fromTable = (req.body?.from_table || '').trim();
    const targetTable = (req.body?.target_table || '').trim();
    if (!fromTable || !targetTable) return res.status(400).json({ error: '请选择源桌和目标桌' });
    if (fromTable === targetTable) return res.status(400).json({ error: '目标桌与当前桌相同' });

    const target = await getAsync('SELECT * FROM tables WHERE name=? AND store_id=?', [targetTable, storeId]);
    if (!target) return res.status(404).json({ error: '目标桌不存在' });

    const nowIso = new Date().toISOString();
    // 查目标桌的有效 session
    const targetSession = await getAsync(
      "SELECT token FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      [targetTable, storeId, nowIso]
    );
    let newToken;
    if (targetSession) {
      newToken = targetSession.token;
    } else {
      newToken = 'auto_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const exp = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      await runAsync(
        'INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
        [targetTable, newToken, exp, nowIso, storeId, storeId]
      );
    }

    // 一次性把所有未结算订单的 table_name 和 session_token 都改过来
    const result = await runAsync(
      "UPDATE orders SET table_name=?, session_token=? WHERE table_name=? AND store_id=? AND status='pending'",
      [targetTable, newToken, fromTable, storeId]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ error: '当前桌没有未结算订单可以转移' });
    }

    // 删除源桌的旧 session
    await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at > ?', [fromTable, storeId, nowIso]);

    await syncTableStatus(fromTable, storeId);
    await syncTableStatus(targetTable, storeId);

    io.to('waiter-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: result.affectedRows });
    io.to('kitchen-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: result.affectedRows });
    io.to('cashier-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: result.affectedRows });

    res.json({ success: true, from: fromTable, to: targetTable, count: result.affectedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 转移订单 -----
app.put('/api/tables/:id', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!existing) return res.status(404).json({ error: '桌号不存在' });
    const newName = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
    const newStatus = req.body.status || existing.status;
    if (!newName) return res.status(400).json({ error: '桌号名称不能为空' });
    if (!['available', 'occupied', 'reserved'].includes(newStatus)) {
      return res.status(400).json({ error: '无效的桌号状态' });
    }
    try {
      await runAsync('UPDATE tables SET name=?, status=? WHERE id=? AND store_id=?', [newName, newStatus, id, req.storeId]);
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: '该桌号名称已存在，请换一个' });
      }
      throw e;
    }
    if (newName !== existing.name) {
      await runAsync("UPDATE orders SET table_name=? WHERE table_name=? AND store_id=? AND status=\"pending\"", [newName, existing.name, req.storeId]);
    }
    const updated = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tables/:id', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!existing) return res.status(404).json({ error: '桌号不存在' });
    const orderCount = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name = ? AND store_id = ? AND status != 'canceled'", [existing.name, req.storeId]);
    if (orderCount.count > 0) return res.status(409).json({ error: '该桌仍有未完成订单，不能删除' });
    await runAsync('DELETE FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 订单列表 -----

};
