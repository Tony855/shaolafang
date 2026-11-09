/* ============================================================
   routes/orders.js — 订单核心
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");
const { resolveOrderStoreId } = require("../server/services/order-store-scope");

function parsePositiveOrderRouteId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function parseNonNegativeRouteIndex(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return null;
  const index = Number(raw);
  return Number.isSafeInteger(index) ? index : null;
}

function toMoneyCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function hasActiveKhqr(order) {
  if (Number(order?.awaiting_confirm)) return true;
  if (!order?.pay_khqr_ref) return false;
  const expiresAt = Date.parse(order.pay_expires_at || '');
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

// Keep normalized USD order totals deterministic while retaining the existing
// single-rounding behavior across all remaining item quantities.
function calculateOrderTotalCents(items) {
  if (!Array.isArray(items) || !items.length) return null;
  let scaledTotal = 0n;
  for (const item of items) {
    const unitPrice = Number(item?.base_price ?? item?.price);
    const quantity = Number(item?.quantity);
    const returnedQty = item?.returnedQty === undefined || item?.returnedQty === null
      ? 0
      : Number(item.returnedQty);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1000000000 ||
        !Number.isSafeInteger(quantity) || quantity <= 0 ||
        !Number.isSafeInteger(returnedQty) || returnedQty < 0 || returnedQty > quantity) {
      return null;
    }
    const remainingQty = quantity - returnedQty;
    if (!remainingQty) continue;
    const [whole, fraction] = unitPrice.toFixed(10).split('.');
    const unitScaled = BigInt(whole) * 10000000000n + BigInt(fraction);
    scaledTotal += unitScaled * BigInt(remainingQty);
  }
  const cents = (scaledTotal + 50000000n) / 100000000n;
  if (cents > 100000000000n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

  function requireOrderTransferAccess(req, res, next) {
    if (req.waiter && !req.waiter.can_order) {
      return res.status(403).json({ error: '该服务员没有转移订单权限' });
    }
    if (!req.isAdmin || !req.adminId || req.isPrimaryAdmin || req.adminPermissions?.can_manage_order) return next();
    return res.status(403).json({ error: '没有订单管理权限' });
  }

  function formatStaffOrder(row) {
    const formatted = formatOrder(row);
    delete formatted.sessionToken;
    delete formatted.customerToken;
    return formatted;
  }

  function sendOrderError(res, error) {
    const status = Number(error && error.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return res.status(status).json({ error: error.message || '订单请求无效' });
    }
    return res.status(500).json({ error: '订单服务暂时不可用，请稍后重试' });
  }

app.post('/api/orders/:id/transfer', requireAdminOrWaiter, requireOrderTransferAccess, async (req, res) => {
  try {
    const storeId = resolveOrderStoreId(req);
    if (!storeId) return res.status(403).json({ error: '当前账号未绑定有效门店' });
    const orderId = parsePositiveOrderRouteId(req.params.id);
    const targetTable = typeof req.body?.target_table === 'string' ? req.body.target_table.trim() : '';
    if (orderId === null || !targetTable || targetTable.length > 50) {
      return res.status(400).json({ error: '订单或目标桌号无效' });
    }

    const initialOrder = await getAsync(
      'SELECT id, table_name, status FROM orders WHERE id=? AND store_id=?',
      [orderId, storeId]
    );
    if (!initialOrder) return res.status(404).json({ error: '订单不存在' });
    if (!initialOrder.table_name || initialOrder.table_name === targetTable) {
      return res.status(400).json({ error: '目标桌与当前桌相同或当前桌号无效' });
    }

    let oldTable = '';
    let targetHasOrders = false;
    let newToken = '';
    await withTransaction(async () => {
      // Lock tables first, in stable ID order, then lock the order and QR session.
      // This matches table move/create/call lock ordering and avoids stale source-table races.
      const lockedTables = await allAsync(
        'SELECT id, name, status, active FROM tables WHERE store_id=? AND name IN (?, ?) ORDER BY id FOR UPDATE',
        [storeId, initialOrder.table_name, targetTable]
      );
      const source = lockedTables.find(table => table.name === initialOrder.table_name);
      const target = lockedTables.find(table => table.name === targetTable);
      if (!source) {
        const error = new Error('源桌不存在或已更名');
        error.status = 409;
        throw error;
      }
      if (!target || target.active === 0 || target.active === false) {
        const error = new Error('目标桌不存在或已停用');
        error.status = 404;
        throw error;
      }
      if (target.status === 'reserved') {
        const error = new Error('目标桌已被预约，不能转入订单');
        error.status = 409;
        throw error;
      }

      const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE', [orderId, storeId]);
      if (!order) {
        const error = new Error('订单不存在');
        error.status = 404;
        throw error;
      }
      if (order.table_name !== initialOrder.table_name || order.status !== 'pending') {
        const error = new Error('订单状态或桌台已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }
      if (hasActiveKhqr(order)) {
        const error = new Error('订单仍有待确认或有效 KHQR 收款码，无法转桌');
        error.status = 409;
        throw error;
      }

      oldTable = order.table_name;
      const targetPending = await getAsync(
        "SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'",
        [targetTable, storeId]
      );
      targetHasOrders = Number(targetPending?.cnt || 0) > 0;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const targetSession = await getAsync(
        'SELECT token, expires_at FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [targetTable, storeId, nowIso]
      );
      const targetExpiry = targetSession ? new Date(targetSession.expires_at).getTime() : NaN;
      if (targetSession && Number.isFinite(targetExpiry) && targetExpiry > now) {
        newToken = targetSession.token;
      } else {
        newToken = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
        await runAsync(
          'INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
          [targetTable, newToken, expiresAt, nowIso, storeId, storeId]
        );
      }

      const moved = await runAsync(
        "UPDATE orders SET table_name=?, session_token=? WHERE id=? AND store_id=? AND status='pending'",
        [targetTable, newToken, orderId, storeId]
      );
      if (!moved.affectedRows) {
        const error = new Error('订单状态已变化，转桌操作已取消');
        error.status = 409;
        throw error;
      }
      await syncTableStatus(oldTable, storeId);
      await syncTableStatus(targetTable, storeId);
      const oldPending = await getAsync(
        "SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'",
        [oldTable, storeId]
      );
      if (!oldPending || Number(oldPending.cnt) === 0) {
        await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [oldTable, storeId]);
      }
      const actorType = req.waiter ? 'waiter' : 'admin';
      const actorName = req.waiter ? req.waiter.display_name : 'admin';
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [actorType, req.waiter?.id || req.adminId || 0, actorName, 'transfer_order', JSON.stringify({ order_id: orderId, from: oldTable, to: targetTable }), getClientIp(req) || 'unknown', new Date().toISOString()]
      );
    });

    io.to('waiter-' + storeId).emit('order:transfer', { orderId, from: oldTable, to: targetTable });
    io.to('kitchen-' + storeId).emit('order:transfer', { orderId, from: oldTable, to: targetTable });
    io.to('cashier-' + storeId).emit('order:transfer', { orderId, from: oldTable, to: targetTable });
    res.json({ success: true, from: oldTable, to: targetTable, targetHasOrders });
  } catch (e) {
    sendOrderError(res, e);
  }
});

app.put('/api/orders/:id/items/:index', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = parsePositiveOrderRouteId(req.params.id);
    const index = parseNonNegativeRouteIndex(req.params.index);
    const orderStoreId = resolveOrderStoreId(req);
    if (!orderStoreId) return res.status(403).json({ error: '当前账号未绑定有效门店' });
    if (id === null || index === null) {
      return res.status(400).json({ error: '订单或菜品序号无效' });
    }
    if (req.isAdmin && req.adminId && !req.isPrimaryAdmin &&
        !(req.adminPermissions && req.adminPermissions.can_edit_order)) {
      return res.status(403).json({ error: '没有编辑订单权限' });
    }
    if (!req.isAdmin && req.waiter && !req.waiter.can_mark_item) {
      return res.status(403).json({ error: '该服务员没有标记菜品权限' });
    }

    let updatedRow = null;
    let changed = false;
    await withTransaction(async () => {
      const row = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE', [id, orderStoreId]);
      if (!row) {
        const error = new Error('订单不存在');
        error.status = 404;
        throw error;
      }
      if (row.status !== 'pending') {
        const error = new Error('已结算或已取消订单不能修改菜品');
        error.status = 409;
        throw error;
      }
      if (hasActiveKhqr(row)) {
        const error = new Error('订单仍有待确认或有效 KHQR 收款码，无法修改菜品');
        error.status = 409;
        throw error;
      }

      let items = row.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (_) { items = []; }
      }
      if (!Array.isArray(items) || items.length === 0 || index >= items.length) {
        const error = new Error('菜品序号无效或订单暂无菜品');
        error.status = 400;
        throw error;
      }

      if (req.body.returnQty !== undefined && req.body.returnQty !== null) {
        const returnQty = parseNonNegativeRouteIndex(req.body.returnQty);
        const quantity = Number(items[index].quantity) || 1;
        if (!Number.isSafeInteger(returnQty) || returnQty < 0 || returnQty > quantity) {
          const error = new Error('退回数量必须为 0 至菜品数量之间的整数');
          error.status = 400;
          throw error;
        }
        const previousReturnQty = Number(items[index].returnedQty) || 0;
        const returnDelta = returnQty - previousReturnQty;
        if (returnDelta !== 0) {
          items[index].returnedQty = returnQty;
          const newTotalCents = calculateOrderTotalCents(items);
          if (newTotalCents === null) {
            const error = new Error('退菜后订单金额无效或超出允许范围');
            error.status = 400;
            throw error;
          }
          const newTotal = newTotalCents / 100;
          if (items[index].id && returnDelta > 0) {
            await runAsync('UPDATE menus SET sales_count=GREATEST(0, sales_count-?) WHERE id=? AND store_id=?', [returnDelta, items[index].id, orderStoreId]);
          } else if (items[index].id && returnDelta < 0) {
            await runAsync('UPDATE menus SET sales_count=sales_count+? WHERE id=? AND store_id=?', [-returnDelta, items[index].id, orderStoreId]);
          }
          const result = await runAsync("UPDATE orders SET items=?, total=? WHERE id=? AND store_id=? AND status='pending'", [JSON.stringify(items), newTotal, id, orderStoreId]);
          if (!result.affectedRows) {
            const error = new Error('订单状态已变化，退菜操作已取消，请刷新后重试');
            error.status = 409;
            throw error;
          }
          changed = true;
        }
      } else {
        const requestedStatus = req.body.itemStatus === undefined ? 'pending' : req.body.itemStatus;
        if (!['done', 'pending'].includes(requestedStatus)) {
          const error = new Error('菜品状态无效');
          error.status = 400;
          throw error;
        }
        if (items[index].itemStatus === 'done' && requestedStatus !== 'done') {
          const error = new Error('已完成菜品不能改回制作中');
          error.status = 409;
          throw error;
        }
        if (items[index].itemStatus !== requestedStatus) {
          items[index].itemStatus = requestedStatus;
          const result = await runAsync("UPDATE orders SET items=? WHERE id=? AND store_id=? AND status='pending'", [JSON.stringify(items), id, orderStoreId]);
          if (!result.affectedRows) {
            const error = new Error('订单状态已变化，请刷新后重试');
            error.status = 409;
            throw error;
          }
          changed = true;
        }
      }
      updatedRow = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, orderStoreId]);
    });

    const updatedOrder = formatStaffOrder(updatedRow);
    if (changed) {
      const storeId = Number(updatedRow.store_id);
      if (!Number.isSafeInteger(storeId) || storeId <= 0) throw new Error('订单门店信息无效');
      io.to('kitchen-' + storeId).emit('item:updated', { orderId: id, order: updatedOrder });
      io.to('waiter-' + storeId).emit('item:updated', { orderId: id, order: updatedOrder });
      io.to('cashier-' + storeId).emit('item:updated', { orderId: id, order: updatedOrder });
      io.to('public-table-' + storeId + '-' + updatedRow.table_name).emit('item:updated', {
        orderId: id,
        order: {
          id: updatedOrder.id,
          order_no: updatedOrder.order_no,
          table_name: updatedOrder.table_name,
          items: updatedOrder.items.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, itemStatus: item.itemStatus, returnedQty: item.returnedQty || 0 })),
          total: updatedOrder.total,
          status: updatedOrder.status,
          createdAt: updatedOrder.createdAt
        }
      });
    }
    return res.json(updatedOrder);
  } catch (e) {
    console.error('切换菜品状态失败:', e);
    sendOrderError(res, e);
  }
});

app.get('/api/orders', requireAdminOrWaiter, async (req, res) => {
  try {
    let storeId;
    if (req.isAdmin) {
      storeId = resolveOrderStoreId(req);
      if (!storeId) return res.status(403).json({ error: '当前账号未绑定有效门店' });
    } else {
      storeId = resolveOrderStoreId(req);
      if (!storeId) return res.status(403).json({ error: '当前账号未绑定有效门店' });
    }
    const status = req.query.status;
    let sql = 'SELECT * FROM orders WHERE store_id=?';
    const params = [storeId];
    if (status) {
      sql += ' AND status=?';
      params.push(status);
    }
    sql += ' ORDER BY createdAt DESC';
    const rows = await allAsync(sql, params);
    const formatted = rows.map(formatStaffOrder);
    res.json(formatted);
  } catch (e) {
    sendOrderError(res, e);
  }
});

app.get('/api/orders/:id(\\d+)', requireAdminOrWaiter, async (req, res) => {
  try {
    const orderStoreId = resolveOrderStoreId(req);
    if (!orderStoreId) return res.status(403).json({ error: '当前账号未绑定有效门店' });
    const orderId = parsePositiveOrderRouteId(req.params.id);
    if (orderId === null) return res.status(400).json({ error: '订单编号无效' });
    const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [orderId, orderStoreId]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    res.json(formatStaffOrder(row));
  } catch (e) {
    sendOrderError(res, e);
  }
});

// ============================================================
//  POST /api/orders（事务包裹 + 订单号序列化 + 结构化错误码）
// ============================================================
app.post('/api/orders', async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {};
    // ---------- 1. 认证 ----------
    const adminAuth = await authenticateAdmin(req);
    const isAdmin = Boolean(adminAuth && !adminAuth.error);
    if (isAdmin) {
      req.adminId = adminAuth.adminId || null;
      req.merchantId = adminAuth.merchantId || null;
      const requestedStoreId = adminAuth.storeId ?? req.get('X-Store-Id');
      req.storeId = Number(requestedStoreId);
      if (!Number.isSafeInteger(req.storeId) || req.storeId <= 0) {
        return res.status(403).json({ error: '管理员凭证未绑定有效门店，请指定有效门店后重试' });
      }
      // A configured legacy API key is an explicit store-scoped integration credential.
      // It is not a merchant-admin account and must not inherit or fabricate admin permissions.
      if (req.adminId && req.merchantId) {
        const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1', [req.adminId, req.merchantId]);
        if (!admin) return res.status(401).json({ error: '管理员账号已停用或不存在' });
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [req.merchantId]);
        const isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
        if (!isPrimaryAdmin && !admin.can_manage_order) return res.status(403).json({ error: '没有下单权限' });
      }
    }
    const waiter = await getWaiterFromRequest(req);
    const isWaiter = Boolean(waiter && waiter.can_order);
    if (waiter && !waiter.can_order) return res.status(403).json({ error: '该服务员没有下单权限' });

    // ---------- 2. 会话/桌号校验 ----------
    let sessionToken = null;
    let customerToken = '';
    let sessionStoreId = null;
    let table;
    const requestedTable = typeof req.body.table === 'string' ? req.body.table.trim() : '';
    if (!requestedTable || requestedTable.length > 50) {
      return res.status(400).json({ error: '桌号无效' });
    }
    if (!isAdmin && !isWaiter) {
      const token = typeof req.body.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
      customerToken = typeof req.body.customerToken === 'string' ? req.body.customerToken.trim().slice(0, 128) : '';
      if (!token || token.length > 256) return res.status(401).json({ error: '请重新扫码后再下单' });
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [token]);
      if (!session) return res.status(401).json({ error: '请重新扫码后再下单' });
      const sessionExpiresAt = new Date(session.expires_at).getTime();
      if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
        return res.status(410).json({ error: '二维码已过期或会话有效期无效，请重新扫码' });
      }
      sessionStoreId = Number(session.store_id);
      if (!Number.isSafeInteger(sessionStoreId) || sessionStoreId <= 0) {
        return res.status(401).json({ error: '扫码会话店铺信息无效，请重新扫码' });
      }
      const activeStore = await getAsync(
        'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
        [sessionStoreId]
      );
      if (!activeStore) return res.status(404).json({ error: '店铺不存在或已停用，暂时无法下单' });
      table = await assertTableExists(requestedTable, sessionStoreId);
      if (session.table_name !== table) return res.status(403).json({ error: '扫码桌号与下单桌号不一致' });
      sessionToken = token;
    } else {
      const orderStoreId = Number(req.storeId);
      if (!Number.isSafeInteger(orderStoreId) || orderStoreId <= 0) {
        return res.status(403).json({ error: '无权访问该店铺' });
      }
      table = await assertTableExists(requestedTable, orderStoreId);
    }
    const authenticatedStoreId = isAdmin ? req.storeId : (isWaiter ? Number(waiter.store_id) : sessionStoreId);
    if (!Number.isSafeInteger(Number(authenticatedStoreId)) || Number(authenticatedStoreId) <= 0) {
      return res.status(403).json({ error: '当前账号未绑定有效门店' });
    }
    const tableStore = await getAsync(
      'SELECT store_id FROM tables WHERE name=? AND store_id=?',
      [table, Number(authenticatedStoreId)]
    );
    const storeId = Number(tableStore?.store_id);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return res.status(404).json({ error: '桌台不存在或不属于当前门店' });
    }
    if (isWaiter && waiter.store_id !== storeId) return res.status(403).json({ error: '不能为其他店铺的桌号下单' });
    const finalStoreId = sessionStoreId || storeId;

    // ---------- 4. 菜品规范化与上限校验 ----------
    const rawItems = req.body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ error: '订单至少需要一道菜品' });
    }
    const maxItemsRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_items'");
    const maxItemsRaw = maxItemsRow?.value ?? '50';
    const maxItemsValue = typeof maxItemsRaw === 'string' && maxItemsRaw.trim() === '' ? NaN : Number(maxItemsRaw);
    const maxItems = Number.isSafeInteger(maxItemsValue) && maxItemsValue > 0 ? Math.min(maxItemsValue, 200) : 50;
    if (rawItems.length > maxItems) {
      return res.status(400).json({
        error: `单次下单菜品数量不能超过${maxItems}种`,
        code: 'ORDER_ITEM_TYPES_EXCEEDED',
        limit: maxItems,
        actual: rawItems.length,
      });
    }
    const maxQtyRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_item_quantity'");
    const maxQtyRaw = maxQtyRow?.value ?? '100';
    const maxQtyValue = typeof maxQtyRaw === 'string' && maxQtyRaw.trim() === '' ? NaN : Number(maxQtyRaw);
    const maxQty = Number.isSafeInteger(maxQtyValue) && maxQtyValue > 0 ? Math.min(maxQtyValue, 1000) : 100;
    for (const rawItem of rawItems) {
      const quantity = Number(rawItem && rawItem.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > maxQty) {
        return res.status(400).json({
          error: `单个菜品数量必须为 1 至 ${maxQty} 份`,
          code: 'ITEM_QTY_EXCEEDED',
          limit: maxQty,
          actual: Number.isFinite(quantity) ? quantity : null,
        });
      }
    }
    const items = await normalizeOrderItems(rawItems, finalStoreId);
    const calculatedTotalCents = calculateOrderTotalCents(items);
    if (calculatedTotalCents === null) {
      return res.status(400).json({ error: '订单金额无效或超出允许范围' });
    }
    const calculatedTotal = calculatedTotalCents / 100;
    const itemsJson = JSON.stringify(items);
    const createdAt = new Date().toISOString();

    // ---------- 5. 备注处理 ----------
    let note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    const maxNoteRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_note_length'");
    const maxNoteRaw = maxNoteRow?.value ?? '200';
    const configuredMaxNoteLen = typeof maxNoteRaw === 'string' && maxNoteRaw.trim() === '' ? NaN : Number(maxNoteRaw);
    const maxNoteLen = Number.isSafeInteger(configuredMaxNoteLen) && configuredMaxNoteLen >= 0 ? Math.min(configuredMaxNoteLen, 2000) : 200;
    if (note.length > maxNoteLen) note = note.slice(0, maxNoteLen);

    // ---------- 6. 计算订单号前缀 ----------
    const _midRow = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [finalStoreId]);
    const _mid = _midRow?.merchant_id || 1;
    const prefixRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${_mid}_order_prefix_normal`])
                   || await getAsync("SELECT value FROM settings WHERE `key` = 'order_prefix_normal'");
    const orderPrefix = (prefixRow?.value || '11').padStart(2, '0').slice(-2);
    const yyddmm = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const todayPrefix = orderPrefix + yyddmm;
    const resetRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${_mid}_order_no_reset_period`])
                  || await getAsync("SELECT value FROM settings WHERE `key` = 'order_no_reset_period'");
    const resetPeriod = resetRow?.value || 'never';
    let seqPrefix = todayPrefix;
    if (resetPeriod === 'monthly') seqPrefix = orderPrefix + yyddmm.slice(0, 4);
    else if (resetPeriod === 'yearly') seqPrefix = orderPrefix + yyddmm.slice(0, 2);
    else if (resetPeriod === 'never') seqPrefix = orderPrefix + 'GL';

    // ---------- 7. 原子冷却检查 ----------
    // Acquire the cooldown only after the payload has passed validation. Invalid
    // requests must not lock a customer's QR session and block a valid order.
    const cooldownKey = sessionToken || ('store:' + finalStoreId + ':table:' + table);
    const cooldownMs = await getOrderCooldownMs();
    const canSubmit = await checkAndSetCooldown(cooldownKey, cooldownMs);
    if (canSubmit === null) {
      return res.status(503).json({ error: '订单服务暂时不可用，请稍后重试' });
    }
    if (!canSubmit) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }

    // ---------- 7. 事务：分配订单号 + 写订单 + 更新销量 + 更新桌台 + 重置会话 ----------
    let createdOrder;
    try {
      createdOrder = await withTransaction(async () => {
        // Serialize order creation with table rename, move and delete operations.
        // Lock order is always table row -> QR session row to avoid stale-session races.
        const lockedTable = await getAsync(
          'SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE',
          [table, finalStoreId]
        );
        if (!lockedTable) {
          throw Object.assign(new Error('桌号已不存在，请重新扫码或刷新桌台'), { status: 404 });
        }
        const activeStore = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
          [finalStoreId]
        );
        if (!activeStore) throw Object.assign(new Error('店铺已停用，暂时无法下单'), { status: 404 });
        if (sessionToken) {
          const lockedSession = await getAsync(
            'SELECT table_name, store_id, expires_at FROM scan_sessions WHERE token=? FOR UPDATE',
            [sessionToken]
          );
          if (!lockedSession) {
            throw Object.assign(new Error('扫码会话已失效，请重新扫码'), { status: 401 });
          }
          const lockedExpiry = new Date(lockedSession.expires_at).getTime();
          if (!Number.isFinite(lockedExpiry) || lockedExpiry <= Date.now()) {
            throw Object.assign(new Error('二维码已过期，请重新扫码'), { status: 410 });
          }
          if (lockedSession.table_name !== table || Number(lockedSession.store_id) !== Number(finalStoreId)) {
            throw Object.assign(new Error('桌台或扫码会话已变化，请重新扫码'), { status: 409 });
          }
        }

        const orderNo = await allocateOrderNo(seqPrefix);
        const result = await runAsync(
          'INSERT INTO orders (order_no, table_name, items, total, status, createdAt, session_token, customer_token, store_id, note, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
          [orderNo, table, itemsJson, calculatedTotal, 'pending', createdAt, sessionToken, customerToken, finalStoreId, note, finalStoreId]
        );
        for (const item of items) {
          if (item.id) {
            await runAsync(
              'UPDATE menus SET sales_count = sales_count + ? WHERE id = ? AND store_id = ?',
              [Number(item.quantity) || 1, item.id, finalStoreId]
            );
          }
        }
        await syncTableStatus(table, finalStoreId);
        if (sessionToken) {
          const qrTimeoutRow = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
          const rawQrTimeout = String(qrTimeoutRow?.value ?? '45').trim();
          const parsedQrTimeout = /^\d+$/.test(rawQrTimeout) ? Number(rawQrTimeout) : NaN;
          const qrTimeoutMins = Number.isSafeInteger(parsedQrTimeout) && parsedQrTimeout >= 0 ? Math.min(parsedQrTimeout, 1440) : 45;
          if (qrTimeoutMins > 0) {
            const newExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
            await runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newExpires, sessionToken]);
          }
        }
        return { orderId: result.lastID, orderNo };
      });
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY' && String(e.message).includes('idx_order_no')) {
        console.error('[order] order_no 唯一约束冲突，可能序列化表被手动修改:', e.message);
        return res.status(409).json({ error: '订单号冲突，请重试', code: 'ORDER_NO_CONFLICT' });
      }
      throw e;
    }

    // ---------- 8. 事务外：查询 + 打印 + Socket ----------
    const newRow = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [createdOrder.orderId, finalStoreId]);

    try {
      // ===== 后厨自动打印（读数据库开关，默认关闭）=====
      const autoPrintRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`auto_print_kitchen_${finalStoreId}`]);
      const autoPrintEnabled = autoPrintRow && (autoPrintRow.value === '1' || autoPrintRow.value === 'true');
      if (autoPrintEnabled) {
        const storeInfo = await getAsync('SELECT * FROM stores WHERE id=?', [finalStoreId]);
        const result = await dispatchPrint({
          order: formatOrder(newRow),
          type: 'kitchen',
          store: storeInfo,
          getAsync,
        });
        if (result.printed) {
          console.log(`[AutoPrint] 后厨单已打印 order #${newRow.id} → ${result.printer}`);
        } else if (result.error) {
          console.error(`[AutoPrint] 打印失败 order #${newRow.id}:`, result.error);
        }
      }
    } catch (autoPrintErr) {
      console.error('[AutoPrint] Error:', autoPrintErr.message);
    }

    const orderData = formatOrder(newRow);
    const staffOrderData = { ...orderData };
    delete staffOrderData.sessionToken;
    delete staffOrderData.customerToken;
    io.to('kitchen-' + finalStoreId).emit('order:new', staffOrderData);
    io.to('waiter-' + finalStoreId).emit('order:new', staffOrderData);
    io.to('cashier-' + finalStoreId).emit('order:new', staffOrderData);
    io.to('public-table-' + finalStoreId + '-' + newRow.table_name).emit('order:new', {
      id: orderData.id,
      order_no: orderData.order_no,
      table_name: orderData.table_name,
      items: orderData.items.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, itemStatus: item.itemStatus })),
      total: orderData.total,
      status: orderData.status,
      createdAt: orderData.createdAt
    });

    const responseData = {
      success: true,
      orderId: newRow.id,
      orderNo: newRow.order_no || '',
      order: orderData
    };
    if (sessionToken) {
      const updatedSession = await getAsync('SELECT expires_at FROM scan_sessions WHERE token=?', [sessionToken]);
      if (updatedSession) responseData.newExpiresAt = updatedSession.expires_at;
    }
    res.status(201).json(responseData);
  } catch (e) {
    console.error('[POST /api/orders] 错误:', e);
    sendOrderError(res, e);
  }
});

app.put('/api/orders/:id(\\d+)', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = parsePositiveOrderRouteId(req.params.id);
    const { table, items, status, note, pay_method } = req.body || {};
    const orderStoreId = resolveOrderStoreId(req);
    if (!orderStoreId) return res.status(403).json({ error: '当前账号未绑定有效门店' });
    if (id === null) return res.status(400).json({ error: '订单编号无效' });
    const existing = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
    if (!existing) return res.status(404).json({ error: '订单不存在' });
    if (existing.status !== 'pending') return res.status(409).json({ error: '只有待处理订单可以编辑' });
    if (!req.isAdmin && existing.awaiting_confirm) return res.status(409).json({ error: '订单已通知收银员，无法修改' });
    if (req.isAdmin && !req.isPrimaryAdmin) {
      const allowed = status === 'done'
        ? Boolean(req.adminPermissions && req.adminPermissions.can_manage_order)
        : Boolean(req.adminPermissions && req.adminPermissions.can_edit_order);
      if (!allowed) return res.status(403).json({ error: status === 'done' ? '没有订单结算权限' : '无权修改订单' });
    }
    if (status !== undefined && !['pending', 'done'].includes(status)) {
      return res.status(400).json({ error: '不支持的订单状态，请使用专用取消/退款接口' });
    }
    const waiterCompletion = status === 'done' && !req.isAdmin && Boolean(req.waiter);
    if (waiterCompletion && !req.waiter.can_complete_order) {
      return res.status(403).json({ error: '该服务员没有提交订单结算权限' });
    }
    if (req.waiter && !waiterCompletion && !req.waiter.can_order) {
      return res.status(403).json({ error: '该服务员没有修改订单权限' });
    }

    let currentItems = existing.items;
    if (typeof currentItems === 'string') {
      try { currentItems = JSON.parse(currentItems); } catch (_) { currentItems = []; }
    }
    if (!Array.isArray(currentItems)) currentItems = [];

    let newItems;
    if (items === undefined || items === null) {
      newItems = currentItems;
    } else {
      if (!Array.isArray(items) || items.length === 0 || items.length > 200) {
        return res.status(400).json({ error: '订单菜品必须为 1 至 200 项的数组' });
      }
      newItems = await normalizeOrderItems(items, orderStoreId);
      const previousByMenuId = new Map(currentItems.map(item => [String(item.id), item]));
      for (const item of newItems) {
        const previous = previousByMenuId.get(String(item.id));
        if (previous && Number(previous.quantity) === Number(item.quantity)) {
          if (['done', 'pending'].includes(previous.itemStatus)) item.itemStatus = previous.itemStatus;
          item.returnedQty = Math.min(Number(previous.returnedQty) || 0, Number(item.quantity));
        }
      }
    }
    if (!Array.isArray(newItems) || newItems.length === 0) {
      return res.status(400).json({ error: '订单至少需要一道菜品' });
    }

    const calculatedTotalCents = calculateOrderTotalCents(newItems);
    if (calculatedTotalCents === null) {
      return res.status(400).json({ error: '订单金额无效或超出允许范围' });
    }
    const calculatedTotal = calculatedTotalCents / 100;
    if (status === 'done' && newItems.some(item => item.itemStatus !== 'done')) {
      return res.status(409).json({ error: '存在未完成菜品，请先完成或删除该菜品后再结算订单' });
    }

    const nextTable = table === undefined ? existing.table_name : await assertTableExists(table, orderStoreId);
    const itemsJson = JSON.stringify(newItems);
    const nextNote = typeof note === 'string' ? note.trim().slice(0, 200) : (existing.note || '');
    const paymentMethod = typeof pay_method === 'string' ? pay_method.trim().slice(0, 40) : '';
    const now = new Date().toISOString();
    let cashReceived = 0;
    let cashChange = 0;
    if (status === 'done' && req.isAdmin) {
      if (!paymentMethod) return res.status(400).json({ error: '管理员直接结算必须指定收款方式' });
      if (paymentMethod.toLowerCase() === 'cash') {
        const cashReceivedCents = toMoneyCents(req.body.cash_received);
        if (cashReceivedCents === null || cashReceivedCents < calculatedTotalCents) {
          return res.status(400).json({ error: '现金实收金额不足或格式无效，最多只能有两位小数' });
        }
        cashReceived = cashReceivedCents / 100;
        cashChange = (cashReceivedCents - calculatedTotalCents) / 100;
      }
    } else if (waiterCompletion) {
      const hasCashReceived = req.body.cash_received !== undefined && req.body.cash_received !== null && req.body.cash_received !== '';
      const hasCashChange = req.body.cash_change !== undefined && req.body.cash_change !== null && req.body.cash_change !== '';
      const cashReceivedCents = hasCashReceived ? toMoneyCents(req.body.cash_received) : 0;
      const cashChangeCents = hasCashChange ? toMoneyCents(req.body.cash_change) : 0;
      if (cashReceivedCents === null || cashChangeCents === null ||
          cashReceivedCents < 0 || cashChangeCents < 0) {
        return res.status(400).json({ error: '收款金额或找零金额无效，最多只能有两位小数' });
      }
      cashReceived = cashReceivedCents / 100;
      cashChange = cashChangeCents / 100;
    }

    await withTransaction(async () => {
      const tableNames = [...new Set([existing.table_name, nextTable])];
      const tablePlaceholders = tableNames.map(() => '?').join(',');
      const lockedTables = await allAsync(
        'SELECT id, name FROM tables WHERE store_id=? AND name IN (' + tablePlaceholders + ') ORDER BY id FOR UPDATE',
        [orderStoreId, ...tableNames]
      );
      if (lockedTables.length !== tableNames.length) {
        const error = new Error('订单关联桌台已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }

      const lockedOrder = await getAsync(
        'SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE',
        [id, orderStoreId]
      );
      const snapshotItems = typeof existing.items === 'string' ? existing.items : JSON.stringify(existing.items || []);
      const lockedItemsSnapshot = typeof lockedOrder?.items === 'string'
        ? lockedOrder.items
        : JSON.stringify(lockedOrder?.items || []);
      const lockedTotalCents = lockedOrder ? toMoneyCents(lockedOrder.total) : null;
      const existingTotalCents = toMoneyCents(existing.total);
      if (lockedOrder && hasActiveKhqr(lockedOrder)) {
        const error = new Error('订单仍有待确认或有效 KHQR 收款码，请先完成确认或取消收款码');
        error.status = 409;
        throw error;
      }
      if (!lockedOrder || lockedOrder.status !== 'pending' ||
          lockedOrder.table_name !== existing.table_name ||
          lockedTotalCents === null || lockedTotalCents !== existingTotalCents ||
          lockedItemsSnapshot !== snapshotItems) {
        const error = new Error('订单状态或内容已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }

      let nextSessionToken = lockedOrder.session_token || '';
      if (nextTable !== existing.table_name) {
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const targetSession = await getAsync(
          'SELECT token, expires_at FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at>? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
          [nextTable, orderStoreId, nowIso]
        );
        const targetExpiry = targetSession ? new Date(targetSession.expires_at).getTime() : NaN;
        if (targetSession && Number.isFinite(targetExpiry) && targetExpiry > nowMs) {
          nextSessionToken = targetSession.token;
        } else {
          nextSessionToken = crypto.randomBytes(32).toString('base64url');
          const expiresAt = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();
          await runAsync(
            'INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
            [nextTable, nextSessionToken, expiresAt, nowIso, orderStoreId, orderStoreId]
          );
        }
      }

      let update;
      if (waiterCompletion) {
        // A waiter may request settlement, but must never transiently mark an order as paid.
        update = await runAsync(
          "UPDATE orders SET table_name=?, session_token=?, items=?, total=?, note=?, status='pending', awaiting_confirm=1, pay_khqr_ref='', pay_expires_at='', pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=0",
          [nextTable, nextSessionToken, itemsJson, calculatedTotal, nextNote, paymentMethod, cashReceived, cashChange, id, orderStoreId]
        );
      } else if (status === 'done' && req.isAdmin) {
        update = await runAsync(
          "UPDATE orders SET table_name=?, session_token=?, items=?, total=?, status='done', note=?, awaiting_confirm=0, pay_khqr_ref='', pay_expires_at='', pay_method=?, cash_received=?, cash_change=?, settled_at=? WHERE id=? AND store_id=? AND status='pending'",
          [nextTable, nextSessionToken, itemsJson, calculatedTotal, nextNote, paymentMethod, cashReceived, cashChange, now, id, orderStoreId]
        );
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['admin', req.adminId || 0, req.adminUsername || 'admin', 'settle_order',
            JSON.stringify({ order_id: id, table: nextTable, total: calculatedTotal, pay_method: paymentMethod, cash_received: cashReceived, cash_change: cashChange }),
            getClientIp(req) || 'unknown', now]
        );
      } else {
        update = await runAsync(
          "UPDATE orders SET table_name=?, session_token=?, items=?, total=?, status='pending', note=? WHERE id=? AND store_id=? AND status='pending'",
          [nextTable, nextSessionToken, itemsJson, calculatedTotal, nextNote, id, orderStoreId]
        );
      }
      if (!update.affectedRows) {
        const error = new Error('订单状态已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }

      await syncTableStatus(nextTable, orderStoreId);
      if (nextTable !== existing.table_name) {
        await syncTableStatus(existing.table_name, orderStoreId);
        const oldPending = await getAsync(
          "SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'",
          [existing.table_name, orderStoreId]
        );
        if (!oldPending || Number(oldPending.cnt) === 0) {
          await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [existing.table_name, orderStoreId]);
        }
      }
      if (status === 'done' && req.isAdmin) {
        const stillPending = await getAsync(
          "SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'",
          [nextTable, orderStoreId]
        );
        if (!stillPending || Number(stillPending.cnt) === 0) {
          await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [nextTable, orderStoreId]);
        }
      }
    });;

    const updatedRow = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
    if (waiterCompletion) {
      io.to('cashier-' + orderStoreId).emit('khqr:awaiting', {
        orderId: Number(id),
        table: updatedRow.table_name,
        orderNo: updatedRow.order_no,
        total: updatedRow.total,
        storeId: orderStoreId,
      });
    } else if (status === 'done' && req.isAdmin) {
      io.to('kitchen-' + orderStoreId).emit('order:settled', { orderId: Number(id) });
      io.to('waiter-' + orderStoreId).emit('order:settled', { orderId: Number(id) });
      io.to('cashier-' + orderStoreId).emit('order:settled', { orderId: Number(id) });
      io.to('public-table-' + orderStoreId + '-' + updatedRow.table_name).emit('order:settled', { orderId: Number(id) });
    }
    res.json(formatStaffOrder(updatedRow));
  } catch (e) {
    console.error('更新订单失败:', e);
    sendOrderError(res, e);
  }
});

app.delete('/api/orders/:id(\\d+)', requireAdminKey, requirePermission('can_delete_order'), async (req, res) => {
  try {
    const storeId = Number(req.storeId);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return res.status(403).json({ error: '当前账号未绑定有效门店' });
    }
    const id = parsePositiveOrderRouteId(req.params.id);
    if (id === null) return res.status(400).json({ error: '订单编号无效' });
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '请输入管理员密码' });

    const existing = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ error: '订单不存在' });

    let deletedOrder = null;
    await withTransaction(async () => {
      const currentAdmin = await getAsync(
        'SELECT id, username, password_hash FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE',
        [req.adminId, req.merchantId]
      );
      if (!currentAdmin || !verifyPassword(password, currentAdmin.password_hash)) {
        throw Object.assign(new Error('密码错误或管理员账号已停用'), { status: 401 });
      }
      // Lock table -> order, consistent with settlement, transfer and table mutation.
      const lockedTable = await getAsync(
        'SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE',
        [existing.table_name, storeId]
      );
      if (!lockedTable) throw Object.assign(new Error('订单关联桌台已变化，删除操作已中止'), { status: 409 });

      const lockedOrder = await getAsync(
        'SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE',
        [id, storeId]
      );
      if (!lockedOrder) throw Object.assign(new Error('订单不存在或已被删除'), { status: 404 });
      if (lockedOrder.table_name !== existing.table_name) {
        throw Object.assign(new Error('订单桌台已变化，请刷新后重试'), { status: 409 });
      }
      // Financially completed/refunded orders are immutable records. Keep deletion
      // limited to unpaid or canceled orders so reports and refund history remain auditable.
      if (!['pending', 'canceled'].includes(lockedOrder.status)) {
        throw Object.assign(new Error('已结算或已退款订单不能删除，请保留财务记录'), { status: 409 });
      }
      if (hasActiveKhqr(lockedOrder)) {
        throw Object.assign(new Error('订单仍有待确认或有效 KHQR 收款码，请先取消收款码后再删除订单'), { status: 409 });
      }

      await runAsync('DELETE FROM refund_requests WHERE order_id=? AND store_id=?', [id, storeId]);
      const result = await runAsync(
        'DELETE FROM orders WHERE id=? AND store_id=?',
        [id, storeId]
      );
      if (!result.affectedRows) throw Object.assign(new Error('订单不存在或已被删除'), { status: 404 });

      await syncTableStatus(lockedOrder.table_name, storeId);
      const pending = await getAsync(
        "SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'",
        [lockedOrder.table_name, storeId]
      );
      if (!pending || Number(pending.cnt) === 0) {
        await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [lockedOrder.table_name, storeId]);
      }

      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId, currentAdmin.username, 'delete_order', 'order', id,
          JSON.stringify({
            order_no: lockedOrder.order_no, table_name: lockedOrder.table_name,
            status: lockedOrder.status, total: lockedOrder.total,
            pay_method: lockedOrder.pay_method, refund_amount: lockedOrder.refund_amount
          }), getClientIp(req), new Date().toISOString()]
      );
      deletedOrder = lockedOrder;
    });

    const payload = { orderId: id };
    io.to('kitchen-' + storeId).emit('order:deleted', payload);
    io.to('waiter-' + storeId).emit('order:deleted', payload);
    io.to('cashier-' + storeId).emit('order:deleted', payload);
    io.to('public-table-' + storeId + '-' + deletedOrder.table_name).emit('order:deleted', payload);
    res.json({ success: true });
  } catch (e) {
    sendOrderError(res, e);
  }
});

// ----- 呼叫服务员 -----

};

module.exports.parsePositiveOrderRouteId = parsePositiveOrderRouteId;
module.exports.parseNonNegativeRouteIndex = parseNonNegativeRouteIndex;
