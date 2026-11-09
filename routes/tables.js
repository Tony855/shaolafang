const { parsePositiveRouteId } = require('../server/services/route-id');
/* ============================================================
   routes/tables.js — 桌台管理
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

  function requireTableAccess(req, res, next) {
    if (!req.isAdmin || !req.adminId || req.isPrimaryAdmin || req.adminPermissions?.can_manage_table) return next();
    return res.status(403).json({ error: '没有桌台管理权限' });
  }

// Management table listing: never expose qr_token or allow a caller to select another store.
app.get('/api/tables', requireAdminOrWaiter, requireTableAccess, async (req, res) => {
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
    const storeId = Number(req.storeId);
    const merchantId = Number(req.merchantId);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const status = req.body?.status || 'available';
    if (!Number.isSafeInteger(storeId) || storeId <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
      return res.status(400).json({ error: '店铺或商户信息无效' });
    }
    if (!name || name.length > 50) return res.status(400).json({ error: '桌号名称必须为 1 至 50 个字符' });
    if (!['available', 'occupied', 'reserved'].includes(status)) {
      return res.status(400).json({ error: '无效的桌号状态' });
    }

    const newTable = await withTransaction(async () => {
      const result = await runAsync(
        'INSERT INTO tables (name, status, qr_token, store_id, merchant_id) VALUES (?, ?, ?, ?, ?)',
        [name, status, createTableToken(), storeId, merchantId]
      );
      return getAsync(
        'SELECT id, name, status, store_id FROM tables WHERE id=? AND store_id=?',
        [result.lastID, storeId]
      );
    });
    res.status(201).json(newTable);
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该桌号名称已存在' });
    res.status(e.status || 500).json({ error: e.status ? e.message : '创建桌台失败' });
  }
});

// ----- 整桌转移：把整个桌的所有未结算订单转到目标桌 -----
app.post('/api/tables/move', requireAdminOrWaiter, requireTableAccess, async (req, res) => {
  try {
    if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_manage_table)) {
      return res.status(403).json({ error: '没有桌台管理权限' });
    }
    if (req.waiter && !req.waiter.can_order) {
      return res.status(403).json({ error: '该服务员没有桌台操作权限' });
    }
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
      if (!['available', 'occupied'].includes(target.status)) {
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
      // Keep pending service calls and active reservations attached to the
      // physical table move instead of leaving stale records on the source.
      await runAsync(
        "UPDATE waiter_calls SET table_name=? WHERE table_name=? AND store_id=? AND status='pending'",
        [targetTable, fromTable, storeId]
      );
      await runAsync(
        "UPDATE reservations SET table_name=? WHERE table_name=? AND store_id=? AND status IN ('pending','confirmed')",
        [targetTable, fromTable, storeId]
      );

      await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [fromTable, storeId]);
      await syncTableStatus(fromTable, storeId);
      await syncTableStatus(targetTable, storeId);
      const sourceReservations = await getAsync(
        "SELECT COUNT(*) AS count FROM reservations WHERE table_name=? AND store_id=? AND status IN ('pending','confirmed')",
        [fromTable, storeId]
      );
      const targetReservations = await getAsync(
        "SELECT COUNT(*) AS count FROM reservations WHERE table_name=? AND store_id=? AND status IN ('pending','confirmed')",
        [targetTable, storeId]
      );
      const targetOrders = await getAsync(
        "SELECT COUNT(*) AS count FROM orders WHERE table_name=? AND store_id=? AND status='pending'",
        [targetTable, storeId]
      );
      if (Number(sourceReservations?.count || 0) === 0) {
        await runAsync("UPDATE tables SET status='available' WHERE name=? AND store_id=? AND status='reserved'", [fromTable, storeId]);
      }
      if (Number(targetReservations?.count || 0) > 0 && Number(targetOrders?.count || 0) === 0) {
        await runAsync("UPDATE tables SET status='reserved' WHERE name=? AND store_id=? AND status='available'", [targetTable, storeId]);
      }
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
    const storeId = Number(req.storeId);
    const id = parsePositiveRouteId(req.params.id);
    if (!Number.isSafeInteger(storeId) || storeId <= 0 || !Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: '桌台或店铺信息无效' });
    }

    const updated = await withTransaction(async () => {
      const existing = await getAsync(
        'SELECT id, name, status FROM tables WHERE id=? AND store_id=? FOR UPDATE',
        [id, storeId]
      );
      if (!existing) throw Object.assign(new Error('桌号不存在'), { status: 404 });
      const newName = req.body?.name !== undefined ? String(req.body.name).trim() : existing.name;
      const newStatus = req.body?.status || existing.status;
      if (!newName || newName.length > 50) {
        throw Object.assign(new Error('桌号名称必须为 1 至 50 个字符'), { status: 400 });
      }
      if (!['available', 'occupied', 'reserved'].includes(newStatus)) {
        throw Object.assign(new Error('无效的桌号状态'), { status: 400 });
      }

      await runAsync('UPDATE tables SET name=?, status=? WHERE id=? AND store_id=?', [newName, newStatus, id, storeId]);
      if (newName !== existing.name) {
        // Keep every active reference aligned with the renamed table in the same transaction.
        await runAsync(
          "UPDATE orders SET table_name=? WHERE table_name=? AND store_id=? AND status='pending'",
          [newName, existing.name, storeId]
        );
        await runAsync(
          'UPDATE scan_sessions SET table_name=? WHERE table_name=? AND store_id=?',
          [newName, existing.name, storeId]
        );
        await runAsync(
          "UPDATE waiter_calls SET table_name=? WHERE table_name=? AND store_id=? AND status='pending'",
          [newName, existing.name, storeId]
        );
        await runAsync(
          "UPDATE reservations SET table_name=? WHERE table_name=? AND store_id=? AND status IN ('pending','confirmed')",
          [newName, existing.name, storeId]
        );
      }
      return getAsync('SELECT id, name, status, store_id FROM tables WHERE id=? AND store_id=?', [id, storeId]);
    });
    res.json(updated);
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该桌号名称已存在，请换一个' });
    res.status(e.status || 500).json({ error: e.status ? e.message : '更新桌台失败' });
  }
});

app.delete('/api/tables/:id', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const storeId = Number(req.storeId);
    const id = parsePositiveRouteId(req.params.id);
    if (!Number.isSafeInteger(storeId) || storeId <= 0 || !Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: '桌台或店铺信息无效' });
    }

    await withTransaction(async () => {
      const existing = await getAsync(
        'SELECT id, name FROM tables WHERE id=? AND store_id=? FOR UPDATE',
        [id, storeId]
      );
      if (!existing) throw Object.assign(new Error('桌号不存在'), { status: 404 });

      // Lock dependent rows before checking, so an order/call cannot be inserted
      // between the emptiness check and deleting the table.
      const pendingOrders = await allAsync(
        "SELECT id FROM orders WHERE table_name=? AND store_id=? AND status='pending' ORDER BY id FOR UPDATE",
        [existing.name, storeId]
      );
      const pendingCalls = await allAsync(
        "SELECT id FROM waiter_calls WHERE table_name=? AND store_id=? AND status='pending' ORDER BY id FOR UPDATE",
        [existing.name, storeId]
      );
      const activeReservations = await allAsync(
        "SELECT id FROM reservations WHERE table_name=? AND store_id=? AND status IN ('pending','confirmed') ORDER BY id FOR UPDATE",
        [existing.name, storeId]
      );
      if (pendingOrders.length || pendingCalls.length || activeReservations.length) {
        throw Object.assign(new Error('该桌仍有关联的未结订单、待处理呼叫或有效预约，不能删除'), { status: 409 });
      }

      await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [existing.name, storeId]);
      await runAsync('DELETE FROM tables WHERE id=? AND store_id=?', [id, storeId]);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : '删除桌台失败' });
  }
});

// ----- 订单列表 -----

};
