/* ============================================================
   routes/tables.js — 桌台管理
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

// Management table listing: never expose qr_token or allow a caller to select another store.
app.get('/api/tables', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? Number(req.storeId) : Number(req.waiterStoreId);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return res.status(403).json({ error: '无权访问该店铺桌台' });
    }
    const rows = await allAsync(
      'SELECT id, name, status, store_id FROM tables WHERE store_id=? ORDER BY id',
      [storeId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '获取桌台失败' });
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
    const storeId = Number(req.isAdmin ? req.storeId : req.waiterStoreId);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return res.status(403).json({ error: '无权访问该店铺桌台' });
    }
    const fromTable = typeof req.body?.from_table === 'string' ? req.body.from_table.trim() : '';
    const targetTable = typeof req.body?.target_table === 'string' ? req.body.target_table.trim() : '';
    if (!fromTable || !targetTable) return res.status(400).json({ error: '请选择源桌和目标桌' });
    if (fromTable === targetTable) return res.status(400).json({ error: '目标桌与当前桌相同' });

    const moved = await withTransaction(async () => {
      // Lock both table rows in a deterministic order to serialize concurrent moves.
      const lockedTables = await allAsync(
        'SELECT id, name, status FROM tables WHERE store_id=? AND name IN (?, ?) ORDER BY id FOR UPDATE',
        [storeId, fromTable, targetTable]
      );
      const source = lockedTables.find(row => row.name === fromTable);
      const target = lockedTables.find(row => row.name === targetTable);
      if (!source) throw Object.assign(new Error('源桌不存在'), { status: 404 });
      if (!target) throw Object.assign(new Error('目标桌不存在'), { status: 404 });
      if (!['available', 'occupied', 'reserved'].includes(target.status)) {
        throw Object.assign(new Error('目标桌当前不可用'), { status: 409 });
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const targetSession = await getAsync(
        'SELECT token, expires_at FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [targetTable, storeId, nowIso]
      );
      let newToken = targetSession && Number.isFinite(new Date(targetSession.expires_at).getTime()) &&
        new Date(targetSession.expires_at).getTime() > now ? targetSession.token : null;
      if (!newToken) {
        newToken = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
        await runAsync(
          'INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
          [targetTable, newToken, expiresAt, nowIso, storeId, storeId]
        );
      }

      const result = await runAsync(
        "UPDATE orders SET table_name=?, session_token=? WHERE table_name=? AND store_id=? AND status='pending'",
        [targetTable, newToken, fromTable, storeId]
      );
      if (result.affectedRows === 0) {
        throw Object.assign(new Error('当前桌没有未结算订单可以转移'), { status: 400 });
      }

      await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [fromTable, storeId]);
      await syncTableStatus(fromTable, storeId);
      await syncTableStatus(targetTable, storeId);
      return result.affectedRows;
    });

    io.to('waiter-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: moved });
    io.to('kitchen-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: moved });
    io.to('cashier-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: moved });
    res.json({ success: true, from: fromTable, to: targetTable, count: moved });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : '整桌转移失败' });
  }
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
