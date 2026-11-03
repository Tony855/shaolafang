/* ============================================================
   routes/cashier.js — 服务员登录 + 收银员路由
   ============================================================ */
const crypto = require('crypto');
const { hashPassword, needsRehash } = require('../server/middleware/password');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, withTransaction, isLoginLocked, recordLoginAttempt, resetLoginAttempts, verifyPassword, getClientIp, requireCashier, requireAdminOrCashierOrWaiter, formatOrder, syncTableStatus, buildBatchReceipt, buildReceipt, printToNetworkPrinter, dispatchPrint, io } = deps;

app.post('/api/waiter/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'waiter', '请输入账号和密码']);
      return res.status(400).json({ error: '请输入服务员账号和密码' });
    }
    const lockStatus = await isLoginLocked(username, 'waiter');
    if (lockStatus.locked) {
      return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
    }
    const waiterCandidates = await allAsync('SELECT * FROM waiters WHERE username=? AND active=1', [String(username).trim()]);
    let waiter = null;
    for (const cand of waiterCandidates) {
      if (verifyPassword(password, cand.password_hash)) { waiter = cand; break; }
    }
    if (!waiter) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'waiter', '账号或密码错误']);
      recordLoginAttempt(username, 'waiter');
      return res.status(401).json({ error: '服务员账号或密码错误' });
    }
    if (needsRehash(waiter.password_hash)) {
      const upgradedHash = hashPassword(password);
      await runAsync('UPDATE waiters SET password_hash=? WHERE id=? AND password_hash=?', [upgradedHash, waiter.id, waiter.password_hash]);
    }
    resetLoginAttempts(username, 'waiter');
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, waiter.merchant_id, 'waiter', '服务员登录成功']);
    const token = crypto.randomBytes(24).toString('base64url');
    const waiterTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
    const configuredWaiterTimeoutHours = Number.parseInt(waiterTimeoutSetting?.value || '12', 10);
    const waiterTimeoutHours = Number.isSafeInteger(configuredWaiterTimeoutHours) && configuredWaiterTimeoutHours > 0 ? Math.min(configuredWaiterTimeoutHours, 720) : 12;
    const expiresAt = new Date(Date.now() + waiterTimeoutHours * 60 * 60 * 1000).toISOString();
    await runAsync('INSERT INTO waiter_sessions (waiter_id, token, expires_at) VALUES (?, ?, ?)', [waiter.id, token, expiresAt]);
    const store = await getAsync('SELECT name FROM stores WHERE id=?', [waiter.store_id || 1]);
    res.json({ token, storeId: waiter.store_id || 1, storeName: store?.name || '', waiter: { id: waiter.id, username: waiter.username, display_name: waiter.display_name, can_order: waiter.can_order, can_mark_item: waiter.can_mark_item, can_complete_order: waiter.can_complete_order, store_id: waiter.store_id } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 收银员登录 -----
app.post('/api/cashier/login', async (req, res) => {
  try {
    const { username, password, storeId } = req.body || {};
    if (!username || !password) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'cashier', '请输入账号和密码']);
      return res.status(400).json({ error: '请输入收银员账号和密码' });
    }
    const lockStatus = await isLoginLocked(username, 'cashier');
    if (lockStatus.locked) {
      return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
    }
    const allCashierSettings = await allAsync("SELECT `key`, value FROM settings WHERE `key` LIKE 'cashiers_%'");
    let cashier = null;
    let targetStoreId = storeId ? parseInt(storeId, 10) : 0;
    const candidates = [];
    for (const row of allCashierSettings) {
      try {
        const sid = parseInt(String(row.key).replace('cashiers_', ''), 10) || 1;
        if (targetStoreId && sid !== targetStoreId) continue;
        const list = JSON.parse(row.value);
        const found = list.find(c => c.username === String(username).trim() && c.active);
        if (found) candidates.push({ cashier: found, storeId: sid });
      } catch (e) { continue; }
    }
    for (const cand of candidates) {
      if (verifyPassword(password, cand.cashier.password_hash)) {
        cashier = cand.cashier;
        targetStoreId = cand.storeId;
        break;
      }
    }
    if (!cashier) targetStoreId = targetStoreId || 1;
    if (!cashier) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'cashier', '账号不存在']);
      recordLoginAttempt(username, 'cashier');
      return res.status(401).json({ error: '收银员账号或密码错误' });
    }
    if (!verifyPassword(password, cashier.password_hash)) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'cashier', '密码错误']);
      recordLoginAttempt(username, 'cashier');
      return res.status(401).json({ error: '收银员账号或密码错误' });
    }
    if (needsRehash(cashier.password_hash)) {
      const settingKey = 'cashiers_' + targetStoreId;
      const settingsRow = await getAsync('SELECT value FROM settings WHERE `key`=?', [settingKey]);
      if (settingsRow) {
        try {
          const list = JSON.parse(settingsRow.value);
          const index = list.findIndex(item => String(item.id) === String(cashier.id));
          if (index >= 0 && list[index].password_hash === cashier.password_hash) {
            list[index].password_hash = hashPassword(password);
            await runAsync('UPDATE settings SET value=? WHERE `key`=?', [JSON.stringify(list), settingKey]);
          }
        } catch (e) { console.warn('[cashier] legacy password migration skipped:', e.message); }
      }
    }
    resetLoginAttempts(username, 'cashier');
    const store = await getAsync('SELECT merchant_id, name FROM stores WHERE id=?', [targetStoreId]);
    const merchantId = store?.merchant_id || 1;
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, merchantId, 'cashier', '收银员登录成功']);
    const token = crypto.randomBytes(24).toString('base64url');
    const cashierTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'cashier_session_timeout'");
    const configuredCashierTimeoutHours = Number.parseInt(cashierTimeoutSetting?.value || '12', 10);
    const cashierTimeoutHours = Number.isSafeInteger(configuredCashierTimeoutHours) && configuredCashierTimeoutHours > 0 ? Math.min(configuredCashierTimeoutHours, 720) : 12;
    const expiresAt = new Date(Date.now() + cashierTimeoutHours * 60 * 60 * 1000).toISOString();
    await runAsync('INSERT INTO cashier_sessions (cashier_id, store_id, merchant_id, token, expires_at) VALUES (?, ?, ?, ?, ?)', [cashier.id, targetStoreId, merchantId, token, expiresAt]);
    res.json({
      token,
      storeId: targetStoreId,
      storeName: store?.name || '',
      cashier: {
        id: cashier.id,
        username: cashier.username,
        display_name: cashier.display_name,
        permissions: cashier.permissions || {}
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 收银员登出 -----
app.post('/api/cashier/logout', async (req, res) => {
  try {
    const token = req.get('X-Cashier-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (token) {
      await runAsync('DELETE FROM cashier_sessions WHERE token=?', [token]).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ----- 收银员订单列表 -----
app.get('/api/cashier/orders', requireCashier, async (req, res) => {
  try {
    const rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND status != 'canceled' ORDER BY createdAt DESC", [req.storeId]);
    res.json({ orders: rows.map(formatOrder) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cashier/orders/:id', requireCashier, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    res.json(formatOrder(order));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cashier/orders/batch-settle', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_settle) return res.status(403).json({ error: '没有结算订单权限' });
    const orderIds = [...new Set((Array.isArray(req.body?.order_ids) ? req.body.order_ids : []).map(id => Number(id)).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!orderIds.length) return res.status(400).json({ error: '请选择要结算的订单' });
    if (orderIds.length > 100) return res.status(400).json({ error: '单次最多结算 100 笔订单' });
    const placeholders = orderIds.map(() => '?').join(',');
    const orders = await allAsync("SELECT * FROM orders WHERE id IN (" + placeholders + ") AND store_id=? AND status='pending'", [...orderIds, req.storeId]);
    if (orders.length !== orderIds.length) return res.status(409).json({ error: '部分订单不存在、已处理或不属于当前门店，请刷新后重试' });
    for (const o of orders) {
      try {
        const items = JSON.parse(o.items || '[]');
        if (!Array.isArray(items) || !items.length || !items.every(it => it.itemStatus === 'done')) return res.status(400).json({ error: '订单 ' + (o.order_no || o.id) + ' 存在未完成菜品或没有有效菜品，无法结算' });
      } catch(e) { return res.status(400).json({ error: '订单 ' + (o.order_no || o.id) + ' 数据异常' }); }
    }
    const now = new Date().toISOString();
    const totalAmount = Math.round(orders.reduce((s, o) => s + Number(o.total), 0) * 100) / 100;
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return res.status(400).json({ error: '订单金额无效，无法批量结算' });
    const { pay_method, cash_received } = req.body || {};
    const paymentMethod = typeof pay_method === 'string' ? pay_method.trim().slice(0, 40) : '';
    if (!paymentMethod) return res.status(400).json({ error: '请选择收款方式' });
    const cashReceived = paymentMethod.toLowerCase() === 'cash' ? Number(cash_received) : 0;
    if (paymentMethod.toLowerCase() === 'cash' && (!Number.isFinite(cashReceived) || cashReceived < totalAmount)) {
      return res.status(400).json({ error: '现金实收金额不足' });
    }
    const cashChange = paymentMethod.toLowerCase() === 'cash' ? Math.round((cashReceived - totalAmount) * 100) / 100 : 0;
    const tableNames = [...new Set(orders.map(o => o.table_name))];
    await withTransaction(async () => {
      for (let index = 0; index < orders.length; index++) {
        const order = orders[index];
        // Allocate any batch cash change to the final order so per-order totals
        // reconcile with the aggregate cash tendered and change in the audit log.
        const orderCashChange = paymentMethod.toLowerCase() === 'cash' && index === orders.length - 1 ? cashChange : 0;
        const orderCashReceived = paymentMethod.toLowerCase() === 'cash' ? Number(order.total) + orderCashChange : 0;
        const updated = await runAsync("UPDATE orders SET status='done', awaiting_confirm=0, settled_at=?, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending'", [now, paymentMethod, orderCashReceived, orderCashChange, order.id, req.storeId]);
        if (!updated.affectedRows) {
          const error = new Error('订单状态已变化，批量结算已回滚，请刷新后重试');
          error.status = 409;
          throw error;
        }
      }
      for (const tableName of tableNames) {
        await syncTableStatus(tableName, req.storeId);
        const left = await getAsync("SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [tableName, req.storeId]);
        if (!left || Number(left.cnt) === 0) await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [tableName, req.storeId]);
      }
      await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'batch_settle', JSON.stringify({ order_ids: orders.map(o => o.id), tables: tableNames, count: orders.length, total: totalAmount.toFixed(2), pay_method: paymentMethod, cash_received: cashReceived, cash_change: cashChange }), getClientIp(req), now]);
    });
    let printed = false, printError = null;
    const autoPrintRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", ['auto_print_receipt_' + req.storeId]);
    if (autoPrintRow && autoPrintRow.value === '1') {
      try {
        const printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [req.storeId]);
        const store = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [req.storeId, req.merchantId]);
        if (printer && printer.type === 'network' && printer.ip_address) {
          const printData = buildBatchReceipt(orders, store, printer);
          await printToNetworkPrinter(printData, printer.ip_address, printer.port);
          printed = true;
        }
      } catch (pe) { printError = pe.message; }
    }
    res.json({ success: true, settled: orders.length, total: totalAmount.toFixed(2), printed, printError });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/cashier/orders/batch-print', requireCashier, async (req, res) => {
  try {
    const orderIds = [...new Set((Array.isArray(req.body?.order_ids) ? req.body.order_ids : [])
      .map(id => Number(id)).filter(id => Number.isSafeInteger(id) && id > 0))];
    if (!orderIds.length) return res.status(400).json({ error: '请选择要打印的订单' });
    if (orderIds.length > 100) return res.status(400).json({ error: '单次最多打印 100 笔订单' });
    const placeholders = orderIds.map(() => '?').join(',');
    const orders = await allAsync('SELECT * FROM orders WHERE id IN (' + placeholders + ') AND store_id=?', [...orderIds, req.storeId]);
    if (!orders.length) return res.status(404).json({ error: '订单不存在' });
    const printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [req.storeId]);
    const store = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [req.storeId, req.merchantId]);
    const printData = buildBatchReceipt(orders, store, printer);
    if (printer && printer.type === 'network' && printer.ip_address) {
      try {
        await printToNetworkPrinter(printData, printer.ip_address, printer.port);
        return res.json({ success: true, printed: true, printer: printer.name });
      } catch (e) {
        return res.status(502).json({ success: false, error: e.message, printData: printData.toString('base64') });
      }
    }
    res.json({ success: true, printed: false, printData: printData.toString('base64') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cashier/orders/:id/settle', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_settle) {
      return res.status(403).json({ error: '没有结算订单权限' });
    }
    const id = parseInt(req.params.id);
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status === 'done') return res.status(400).json({ error: '订单已结算' });
    if (order.status === 'canceled') return res.status(400).json({ error: '订单已取消' });
    try {
      const items = JSON.parse(order.items || '[]');
      if (!Array.isArray(items) || !items.length || !items.every(it => it.itemStatus === 'done')) return res.status(400).json({ error: '存在未完成菜品或没有有效菜品，无法结算' });
    } catch(e) { return res.status(400).json({ error: '订单数据异常' }); }
    const { pay_method, cash_received } = req.body || {};
    const paymentMethod = typeof pay_method === 'string' ? pay_method.trim().slice(0, 40) : '';
    if (!paymentMethod) return res.status(400).json({ error: '请选择收款方式' });
    const orderTotal = Number(order.total);
    if (!Number.isFinite(orderTotal) || orderTotal <= 0) return res.status(400).json({ error: '订单金额无效' });
    const cashReceived = paymentMethod.toLowerCase() === 'cash' ? Number(cash_received) : 0;
    if (paymentMethod.toLowerCase() === 'cash' && (!Number.isFinite(cashReceived) || cashReceived < orderTotal)) {
      return res.status(400).json({ error: '现金实收金额不足' });
    }
    const cashChange = paymentMethod.toLowerCase() === 'cash' ? Math.round((cashReceived - orderTotal) * 100) / 100 : 0;
    const settledAt = new Date().toISOString();
    await withTransaction(async () => {
      const settled = await runAsync(
        "UPDATE orders SET status='done', awaiting_confirm=0, settled_at=?, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending'",
        [settledAt, paymentMethod, cashReceived, cashChange, id, req.storeId]
      );
      if (!settled.affectedRows) {
        const error = new Error('订单状态已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }
      await syncTableStatus(order.table_name, req.storeId);
      const stillPending = await getAsync("SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [order.table_name, req.storeId]);
      if (!stillPending || Number(stillPending.cnt) === 0) {
        await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [order.table_name, req.storeId]);
      }
      await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'settle_order', JSON.stringify({ order_id: id, table: order.table_name, total: order.total, pay_method: paymentMethod, cash_received: cashReceived, cash_change: cashChange }), getClientIp(req), settledAt]);
    });
    io.to('kitchen-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('waiter-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('cashier-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('public-table-' + req.storeId + '-' + order.table_name).emit('order:settled', { orderId: id });
    res.json({ success: true, message: '结算成功' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/cashier/orders/:id/cancel', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_cancel) {
      return res.status(403).json({ error: '没有取消订单权限' });
    }
    const id = parseInt(req.params.id);
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status === 'canceled') return res.status(400).json({ error: '订单已取消' });
    if (order.status !== 'pending') return res.status(400).json({ error: '只有待处理订单可以取消' });
    const canceledAt = new Date().toISOString();
    await withTransaction(async () => {
      const canceled = await runAsync(
        "UPDATE orders SET status='canceled' WHERE id=? AND store_id=? AND status='pending'",
        [id, req.storeId]
      );
      if (!canceled.affectedRows) {
        const error = new Error('订单状态已变化，取消操作已中止');
        error.status = 409;
        throw error;
      }
      await syncTableStatus(order.table_name, req.storeId);
      await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'cancel_order', JSON.stringify({ order_id: id, table: order.table_name }), getClientIp(req), canceledAt]);
    });
    res.json({ success: true, message: '取消成功' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/cashier/orders/:id/refund', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_refund) {
      return res.status(403).json({ error: '没有退款权限' });
    }
    const id = parseInt(req.params.id);
    const { amount, reason, note } = req.body || {};
    if (!reason) return res.status(400).json({ error: '请选择退款原因' });

    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'done') return res.status(400).json({ error: '只有已结算订单才能退款' });
    if (order.status === 'refunded') return res.status(400).json({ error: '订单已退款' });

    const orderTotal = Number(order.total);
    const refundAmt = amount === undefined || amount === null || amount === ''
      ? orderTotal
      : Number(amount);
    if (!Number.isFinite(orderTotal) || orderTotal <= 0 ||
        !Number.isFinite(refundAmt) || refundAmt <= 0 || refundAmt > orderTotal) {
      return res.status(400).json({ error: '退款金额必须大于 0 且不能超过订单应收金额' });
    }
    const cleanReason = String(reason).trim().slice(0, 100);
    if (!cleanReason) return res.status(400).json({ error: '请选择退款原因' });
    const cleanNote = typeof note === 'string' ? note.slice(0, 200) : '';
    const now = new Date().toISOString();
    await withTransaction(async () => {
      const refundUpdate = await runAsync(
        "UPDATE orders SET status='refunded', refund_reason=?, refund_note=?, refunded_at=?, refunded_by=?, refund_amount=? WHERE id=? AND store_id=? AND status='done'",
        [cleanReason, cleanNote, now, req.cashier.username || '', refundAmt, id, req.storeId]
      );
      if (!refundUpdate.affectedRows) {
        const error = new Error('订单状态已变化，可能已被其他收银员处理');
        error.status = 409;
        throw error;
      }
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'refund_order',
         JSON.stringify({ order_id: id, table: order.table_name, total: order.total, refund_amount: refundAmt, reason: cleanReason, note: cleanNote }),
         getClientIp(req), now]
      );
    });

    // 广播到各端（订单状态变了）
    io.to('kitchen-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('waiter-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('cashier-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('public-table-' + req.storeId + '-' + order.table_name).emit('order:settled', { orderId: id });

    res.json({ success: true, message: '退款成功' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ===== 单个订单打印小票 =====
app.post('/api/cashier/orders/:id(\\d+)/print', requireCashier, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    const formattedOrder = formatOrder(order);
    const store = await getAsync('SELECT name, address, phone FROM stores WHERE id=?', [req.storeId]);

    const result = await dispatchPrint({
      order: formattedOrder,
      type: 'receipt',
      store: store || { name: 'FoodFlow', address: '' },
      getAsync,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cashier/report/today', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_view_report) {
      return res.status(403).json({ error: '没有查看报表权限' });
    }
    const today = new Date().toISOString().split('T')[0];
    const settledOrders = await allAsync("SELECT * FROM orders WHERE store_id=? AND status='done' AND SUBSTRING(COALESCE(settled_at, createdAt), 1, 10)=? ORDER BY COALESCE(settled_at, createdAt) DESC", [req.storeId, today]);
    const totalRevenue = settledOrders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
    res.json({
      date: today,
      orderCount: settledOrders.length,
      totalRevenue: totalRevenue.toFixed(2),
      avgOrderValue: settledOrders.length > 0 ? (totalRevenue / settledOrders.length).toFixed(2) : '0.00',
      orders: settledOrders.map(formatOrder)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 收银台获取本商户启用的支付方式 -----
app.get('/api/cashier/payment-methods', requireAdminOrCashierOrWaiter, async (req, res) => {
  try {
    const mid = req.merchantId;
    const row = await getAsync("SELECT value FROM settings WHERE `key`=?", [`merchant_${mid}_payment_methods`]);
    const methods = {};
    const builtin = ['cash', 'wechat', 'alipay', 'card'];
    builtin.forEach(k => { methods[k] = true; });
    // 读该商户所有 store 的 KHQR bank
    const stores = await allAsync("SELECT id FROM stores WHERE merchant_id=?", [mid]);
    const bankSet = new Set();
    for (const st of stores) {
      const r = await getAsync("SELECT value FROM settings WHERE `key`=?", [`store_${st.id}_khqr_providers`]);
      if (!r || !r.value) continue;
      try {
        const list = JSON.parse(r.value);
        (list || []).forEach(p => {
          if (p && p.bank) {
            const key = String(p.bank).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (key) bankSet.add(key);
          }
        });
      } catch (e) {}
    }
    bankSet.forEach(b => { methods[b] = true; });
    // 已有配置覆盖
    if (row && row.value) {
      try {
        const saved = JSON.parse(row.value);
        Object.keys(saved).forEach(k => { methods[k] = saved[k] !== false; });
      } catch (e) {}
    }
    res.json({ methods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 收银台获取本店铺启用的 KHQR 收款码 -----
app.get('/api/cashier/khqr/providers', requireAdminOrCashierOrWaiter, async (req, res) => {
  try {
    const sid = req.storeId;
    const row = await getAsync("SELECT value FROM settings WHERE `key`=?", [`store_${sid}_khqr_providers`]);
    let list = [];
    if (row && row.value) {
      try { list = JSON.parse(row.value); } catch (e) {}
    }
    const QRCode = require('qrcode');
    const enabled = list.filter(p => p.enabled);
    const out = [];
    for (const p of enabled) {
      let dataUrl = '';
      try {
        dataUrl = await QRCode.toDataURL(p.payload, { errorCorrectionLevel: 'M', margin: 1, width: 400 });
      } catch (e) { console.warn('[khqr] qr gen failed', p.id, e.message); }
      out.push({
        id: p.id,
        bank: p.bank,
        currency: p.currency,
        merchantName: p.merchantName,
        isDefault: p.isDefault,
        enabled: p.enabled !== false,
        qr_data_url: dataUrl,
      });
    }
    res.json({ providers: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

};
