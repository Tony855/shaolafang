/* ============================================================
   routes/cashier.js — 服务员登录 + 收银员路由
   ============================================================ */
const crypto = require('crypto');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, isLoginLocked, recordLoginAttempt, resetLoginAttempts, verifyPassword, getClientIp, requireCashier, formatOrder, syncTableStatus, buildBatchReceipt, buildReceipt, printToNetworkPrinter, dispatchPrint, io } = deps;

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
    const waiter = await getAsync('SELECT * FROM waiters WHERE username=? AND active=1', [String(username).trim()]);
    if (!waiter) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'waiter', '账号不存在']);
      recordLoginAttempt(username, 'waiter');
      return res.status(401).json({ error: '服务员账号或密码错误' });
    }
    if (!verifyPassword(password, waiter.password_hash)) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 0, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, waiter.merchant_id, 'waiter', '密码错误']);
      recordLoginAttempt(username, 'waiter');
      return res.status(401).json({ error: '服务员账号或密码错误' });
    }
    resetLoginAttempts(username, 'waiter');
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, waiter.merchant_id, 'waiter', '服务员登录成功']);
    const token = crypto.randomBytes(24).toString('base64url');
    const waiterTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
    const waiterTimeoutHours = parseInt(waiterTimeoutSetting?.value || '12', 10);
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
    let targetStoreId = storeId || 1;
    for (const row of allCashierSettings) {
      try {
        const list = JSON.parse(row.value);
        const found = list.find(c => c.username === String(username).trim() && c.active);
        if (found) {
          cashier = found;
          targetStoreId = parseInt(row.key.replace('cashiers_', ''), 10) || 1;
          break;
        }
      } catch (e) { continue; }
    }
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
    resetLoginAttempts(username, 'cashier');
    const store = await getAsync('SELECT merchant_id, name FROM stores WHERE id=?', [targetStoreId]);
    const merchantId = store?.merchant_id || 1;
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, merchantId, 'cashier', '收银员登录成功']);
    const token = crypto.randomBytes(24).toString('base64url');
    const cashierTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'cashier_session_timeout'");
    const cashierTimeoutHours = parseInt(cashierTimeoutSetting?.value || '12', 10);
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
    const orderIds = (req.body?.order_ids || []).map(id => parseInt(id)).filter(id => !isNaN(id));
    if (!orderIds.length) return res.status(400).json({ error: '请选择要结算的订单' });
    const placeholders = orderIds.map(() => '?').join(',');
    const orders = await allAsync('SELECT * FROM orders WHERE id IN (' + placeholders + ') AND store_id=? AND status=\'pending\'', [...orderIds, req.storeId]);
    if (!orders.length) return res.status(400).json({ error: '没有可结算的待处理订单' });
    for (const o of orders) {
      try {
        const items = JSON.parse(o.items || '[]');
        if (!items.every(it => it.itemStatus === 'done')) return res.status(400).json({ error: '订单 ' + (o.order_no || o.id) + ' 存在未完成菜品，无法结算' });
      } catch(e) { return res.status(400).json({ error: '订单 ' + (o.order_no || o.id) + ' 数据异常' }); }
    }
    const now = new Date().toISOString();
    const totalAmount = orders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const tableNames = [...new Set(orders.map(o => o.table_name))];
    for (const order of orders) {
      await runAsync("UPDATE orders SET status='done', createdAt=? WHERE id=? AND store_id=?", [now, order.id, req.storeId]);
      await syncTableStatus(order.table_name, req.storeId);
    }
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['cashier', 0, req.cashier.username, 'batch_settle', JSON.stringify({ order_ids: orders.map(o => o.id), tables: tableNames, count: orders.length, total: totalAmount.toFixed(2) }), getClientIp(req), now]);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cashier/orders/batch-print', requireCashier, async (req, res) => {
  try {
    const orderIds = (req.body?.order_ids || []).map(id => parseInt(id)).filter(id => !isNaN(id));
    if (!orderIds.length) return res.status(400).json({ error: '请选择要打印的订单' });
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
      if (!items.every(it => it.itemStatus === 'done')) return res.status(400).json({ error: '存在未完成菜品，无法结算' });
    } catch(e) { return res.status(400).json({ error: '订单数据异常' }); }
    const { pay_method, cash_received, cash_change } = req.body || {};
    await runAsync(
      "UPDATE orders SET status='done', createdAt=?, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=?",
      [new Date().toISOString(), pay_method || '', Number(cash_received) || 0, Number(cash_change) || 0, id, req.storeId]
    );
    await syncTableStatus(order.table_name, req.storeId);
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['cashier', 0, req.cashier.username, 'settle_order', JSON.stringify({ order_id: id, table: order.table_name, total: order.total }), getClientIp(req), new Date().toISOString()]);
    io.to('kitchen-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('waiter-' + req.storeId).emit('order:settled', { orderId: id });
    res.json({ success: true, message: '结算成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    if (order.status === 'done') return res.status(400).json({ error: '已结算订单不能取消，请使用退款' });
    await runAsync("UPDATE orders SET status='canceled', createdAt=? WHERE id=? AND store_id=?", [new Date().toISOString(), id, req.storeId]);
    await syncTableStatus(order.table_name, req.storeId);
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['cashier', 0, req.cashier.username, 'cancel_order', JSON.stringify({ order_id: id, table: order.table_name }), getClientIp(req), new Date().toISOString()]);
    res.json({ success: true, message: '取消成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cashier/orders/:id/refund', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_refund) {
      return res.status(403).json({ error: '没有退款权限' });
    }
    const id = parseInt(req.params.id);
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'done') return res.status(400).json({ error: '只有已结算订单才能退款' });
    await runAsync("UPDATE orders SET status='refunded', createdAt=? WHERE id=? AND store_id=?", [new Date().toISOString(), id, req.storeId]);
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['cashier', 0, req.cashier.username, 'refund_order', JSON.stringify({ order_id: id, table: order.table_name, total: order.total }), getClientIp(req), new Date().toISOString()]);
    res.json({ success: true, message: '退款成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const settledOrders = await allAsync("SELECT * FROM orders WHERE store_id=? AND status='done' AND SUBSTRING(createdAt, 1, 10)=? ORDER BY createdAt DESC", [req.storeId, today]);
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

};
