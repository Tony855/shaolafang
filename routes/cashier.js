/* ============================================================
   routes/cashier.js — 服务员登录 + 收银员路由
   ============================================================ */
const crypto = require('crypto');
const { hashSessionToken } = require('../server/services/session-token');
const { toMoneyCents, hasActiveKhqr } = require('../server/services/order-financial');
const { isValidRefundIdempotencyKey, createRefundRequestHash, calculateRefundAllocation } = require('../server/services/refund-financial');
const { enqueueSystemAdminTelegramNotification } = require('../server/services/telegram-notification-enqueue');
const { hashPassword, needsRehash } = require('../server/middleware/password');
 
function parsePositiveOrderId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function formatStaffOrder(row, formatOrder) {
  const formatted = formatOrder(row);
  delete formatted.sessionToken;
  delete formatted.customerToken;
  return formatted;
}

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, withTransaction, isLoginLocked, recordLoginAttempt, resetLoginAttempts, cancelLoginAttempt, verifyPassword, getClientIp, requireCashier, requireAdminOrCashierOrWaiter, formatOrder, syncTableStatus, buildBatchReceipt, buildReceipt, printToNetworkPrinter, dispatchPrint, io } = deps;

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
    const waiterCandidates = await allAsync('SELECT w.* FROM waiters w JOIN stores s ON s.id=w.store_id AND s.merchant_id=w.merchant_id AND s.active=1 JOIN merchants m ON m.id=w.merchant_id AND m.status=1 WHERE w.username=? AND w.active=1', [String(username).trim()]);
    let waiter = null;
    for (const cand of waiterCandidates) {
      if (verifyPassword(password, cand.password_hash)) { waiter = cand; break; }
    }
    if (!waiter) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'waiter', '账号或密码错误']);
      await recordLoginAttempt(username, 'waiter', lockStatus.reservationId);
      return res.status(401).json({ error: '服务员账号或密码错误' });
    }
    if (needsRehash(waiter.password_hash)) {
      const upgradedHash = hashPassword(password);
      await runAsync('UPDATE waiters SET password_hash=? WHERE id=? AND password_hash=?', [upgradedHash, waiter.id, waiter.password_hash]);
    }
    await resetLoginAttempts(username, 'waiter', lockStatus.reservationId);
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, waiter.merchant_id, 'waiter', '服务员登录成功']);
    const token = crypto.randomBytes(24).toString('base64url');
    const waiterTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
    const configuredWaiterTimeoutHours = Number(waiterTimeoutSetting?.value ?? 12);
    const waiterTimeoutHours = Number.isSafeInteger(configuredWaiterTimeoutHours) && configuredWaiterTimeoutHours > 0 ? Math.min(configuredWaiterTimeoutHours, 720) : 12;
    const expiresAt = new Date(Date.now() + waiterTimeoutHours * 60 * 60 * 1000).toISOString();
    await runAsync('INSERT INTO waiter_sessions (waiter_id, token_hash, expires_at) VALUES (?, ?, ?)', [waiter.id, hashSessionToken(token), expiresAt]);
    const store = await getAsync('SELECT name FROM stores WHERE id=? AND merchant_id=? AND active=1', [waiter.store_id, waiter.merchant_id]);
    if (!store) return res.status(403).json({ error: '服务员所属门店已停用' });
    res.json({ token, storeId: Number(waiter.store_id), storeName: store.name, waiter: { id: waiter.id, username: waiter.username, display_name: waiter.display_name, can_order: waiter.can_order, can_mark_item: waiter.can_mark_item, can_complete_order: waiter.can_complete_order, store_id: waiter.store_id } });
  } catch (_) {
    console.error('[waiter/login] request failed');
    res.status(500).json({ error: '服务员登录失败，请稍后重试' });
  }
});

// ----- 收银员登录 -----
app.post('/api/cashier/login', async (req, res) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const rawStoreId = req.body?.storeId;
    let requestedStoreId = null;
    if (rawStoreId !== undefined && rawStoreId !== null && rawStoreId !== '') {
      requestedStoreId = parsePositiveOrderId(rawStoreId);
      if (requestedStoreId === null) {
        return res.status(400).json({ error: '门店编号无效' });
      }
    }
    if (!username || username.length > 50 || !password || password.length > 128) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [
        new Date().toISOString(), getClientIp(req), username, 'cashier', '请输入有效账号和密码'
      ]);
      return res.status(400).json({ error: '请输入有效的收银员账号和密码' });
    }
    const lockStatus = await isLoginLocked(username, 'cashier');
    if (lockStatus.locked) return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });

    const allCashierSettings = await allAsync("SELECT `key`, value FROM settings WHERE `key` LIKE 'cashiers_%'");
    const candidates = [];
    for (const row of allCashierSettings) {
      const sid = Number(String(row.key).replace(/^cashiers_/, ''));
      if (!Number.isSafeInteger(sid) || sid <= 0 || (requestedStoreId && sid !== requestedStoreId)) continue;
      try {
        const list = JSON.parse(row.value);
        if (!Array.isArray(list)) continue;
        for (const candidate of list) {
          const active = candidate?.active === true || candidate?.active === 1 ||
            candidate?.active === '1' || candidate?.active === 'true';
          if (candidate && candidate.username === username && active &&
              verifyPassword(password, candidate.password_hash)) {
            candidates.push({ cashier: candidate, storeId: sid });
          }
        }
      } catch (_) {
        // A malformed settings row must not authenticate an account.
      }
    }
    if (candidates.length === 0) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [
        new Date().toISOString(), getClientIp(req), username, 'cashier', '账号或密码错误'
      ]);
      await recordLoginAttempt(username, 'cashier', lockStatus.reservationId);
      return res.status(401).json({ error: '收银员账号或密码错误' });
    }
    if (candidates.length > 1) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [
        new Date().toISOString(), getClientIp(req), username, 'cashier', '账号在多个门店匹配，请指定门店'
      ]);
      await cancelLoginAttempt(username, 'cashier', lockStatus.reservationId);
      return res.status(409).json({ error: '该收银员账号在多个门店匹配，请先选择门店' });
    }

    const candidate = candidates[0];
    const store = await getAsync(
      'SELECT s.id, s.merchant_id, s.name FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
      [candidate.storeId]
    );
    if (!store) { await cancelLoginAttempt(username, 'cashier', lockStatus.reservationId); return res.status(403).json({ error: '收银员所属门店或商户已停用' }); }
    const merchantId = Number(store.merchant_id);
    const token = crypto.randomBytes(24).toString('base64url');
    const cashierTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'cashier_session_timeout'");
    const configuredCashierTimeoutHours = Number(cashierTimeoutSetting?.value ?? 12);
    const cashierTimeoutHours = Number.isSafeInteger(configuredCashierTimeoutHours) && configuredCashierTimeoutHours > 0
      ? Math.min(configuredCashierTimeoutHours, 720) : 12;
    const expiresAt = new Date(Date.now() + cashierTimeoutHours * 60 * 60 * 1000).toISOString();

    let authenticatedCashier;
    let authenticatedStoreName = store.name;
    await withTransaction(async () => {
      const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
      if (!merchant) throw Object.assign(new Error('商户已停用，请联系管理员'), { status: 403 });
      const lockedStore = await getAsync(
        'SELECT s.id, s.merchant_id, s.name FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1 FOR UPDATE',
        [candidate.storeId, merchantId]
      );
      if (!lockedStore) throw Object.assign(new Error('收银员所属门店或商户已停用'), { status: 403 });
      authenticatedStoreName = lockedStore.name;

      const settingKey = 'cashiers_' + candidate.storeId;
      const settingsRow = await getAsync('SELECT value FROM settings WHERE `key`=? FOR UPDATE', [settingKey]);
      let list;
      try { list = settingsRow?.value ? JSON.parse(settingsRow.value) : []; }
      catch (_) { throw Object.assign(new Error('收银员账号数据损坏，请联系管理员'), { status: 500 }); }
      if (!Array.isArray(list)) throw Object.assign(new Error('收银员账号数据格式无效，请联系管理员'), { status: 500 });
      const index = list.findIndex(item => String(item.id) === String(candidate.cashier.id) && item.username === username);
      if (index < 0) throw Object.assign(new Error('收银员账号已变更，请重新登录'), { status: 401 });
      const current = list[index];
      const currentActive = current.active === true || current.active === 1 || current.active === '1' || current.active === 'true';
      if (!currentActive || !verifyPassword(password, current.password_hash)) {
        throw Object.assign(new Error('收银员账号或密码错误'), { status: 401 });
      }
      if (needsRehash(current.password_hash)) {
        current.password_hash = hashPassword(password);
        await runAsync('UPDATE settings SET value=? WHERE `key`=?', [JSON.stringify(list), settingKey]);
      }
      authenticatedCashier = {
        id: current.id, username: current.username, display_name: current.display_name,
        permissions: current.permissions || {}
      };
      await runAsync(
        'INSERT INTO login_logs (createdAt, success, ip, username, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)',
        [new Date().toISOString(), getClientIp(req), username, merchantId, 'cashier', '收银员登录成功']
      );
      await runAsync(
        'INSERT INTO cashier_sessions (cashier_id, store_id, merchant_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
        [current.id, candidate.storeId, merchantId, hashSessionToken(token), expiresAt]
      );
    });

    await resetLoginAttempts(username, 'cashier', lockStatus.reservationId);
    res.json({
      token, storeId: candidate.storeId, storeName: authenticatedStoreName, cashier: authenticatedCashier
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : '收银员登录失败' });
  }
});

// ----- 收银员登出 -----
app.post('/api/cashier/logout', async (req, res) => {
  try {
    const token = req.get('X-Cashier-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (token) {
      await runAsync('DELETE FROM cashier_sessions WHERE token_hash=?', [hashSessionToken(token)]).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});


// ----- 收银员订单列表 -----
app.get('/api/cashier/orders', requireCashier, async (req, res) => {
  try {
    const rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND status != 'canceled' ORDER BY createdAt DESC", [req.storeId]);
    res.json({ orders: rows.map(row => formatStaffOrder(row, formatOrder)) });
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

app.get('/api/cashier/orders/:id', requireCashier, async (req, res) => {
  try {
    const id = parsePositiveOrderId(req.params.id);
    if (id === null) return res.status(400).json({ error: '订单编号无效' });
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    res.json(formatStaffOrder(order, formatOrder));
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

app.put('/api/cashier/orders/batch-settle', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_settle) return res.status(403).json({ error: '没有结算订单权限' });
    const rawOrderIds = Array.isArray(req.body?.order_ids) ? req.body.order_ids : [];
    if (!rawOrderIds.length) return res.status(400).json({ error: '请选择要结算的订单' });
    if (rawOrderIds.length > 100) return res.status(400).json({ error: '单次最多结算 100 笔订单' });
    const parsedOrderIds = rawOrderIds.map(parsePositiveOrderId);
    if (parsedOrderIds.some(id => id === null)) {
      return res.status(400).json({ error: '订单列表包含无效编号，请刷新后重试' });
    }
    const orderIds = [...new Set(parsedOrderIds)];
    const placeholders = orderIds.map(() => '?').join(',');
    const orders = await allAsync("SELECT * FROM orders WHERE id IN (" + placeholders + ") AND store_id=? AND status='pending'", [...orderIds, req.storeId]);
    if (orders.length !== orderIds.length) return res.status(409).json({ error: '部分订单不存在、已处理或不属于当前门店，请刷新后重试' });
    if (orders.some(hasActiveKhqr)) {
      return res.status(409).json({ error: '部分订单仍有待确认或有效 KHQR 收款码，请先完成确认或取消收款码' });
    }
    for (const o of orders) {
      try {
        const items = JSON.parse(o.items || '[]');
        if (!Array.isArray(items) || !items.length || !items.every(it => it.itemStatus === 'done')) return res.status(400).json({ error: '订单 ' + (o.order_no || o.id) + ' 存在未完成菜品或没有有效菜品，无法结算' });
      } catch(e) { return res.status(400).json({ error: '订单 ' + (o.order_no || o.id) + ' 数据异常' }); }
    }
    const now = new Date().toISOString();
    const orderTotalCents = orders.map(order => toMoneyCents(order.total));
    if (orderTotalCents.some(cents => cents === null || cents <= 0)) {
      return res.status(400).json({ error: '订单金额无效，无法批量结算' });
    }
    const totalAmountCents = orderTotalCents.reduce((sum, cents) => sum + cents, 0);
    if (!Number.isSafeInteger(totalAmountCents) || totalAmountCents <= 0) {
      return res.status(400).json({ error: '订单金额超出安全范围，无法批量结算' });
    }
    const totalAmount = totalAmountCents / 100;
    const { pay_method, cash_received } = req.body || {};
    const paymentMethod = typeof pay_method === 'string' ? pay_method.trim().slice(0, 40) : '';
    if (!paymentMethod) return res.status(400).json({ error: '请选择收款方式' });
    const isCashPayment = paymentMethod.toLowerCase() === 'cash';
    const cashReceivedCents = isCashPayment ? toMoneyCents(cash_received) : 0;
    if (isCashPayment && (cashReceivedCents === null || cashReceivedCents < totalAmountCents)) {
      return res.status(400).json({ error: '现金实收金额不足或格式无效，最多只能有两位小数' });
    }
    const cashChangeCents = isCashPayment ? cashReceivedCents - totalAmountCents : 0;
    const cashReceived = isCashPayment ? cashReceivedCents / 100 : 0;
    const cashChange = cashChangeCents / 100;
    let settlementOrders = orders;
    let tableNames = [...new Set(orders.map(o => o.table_name))];
    await withTransaction(async () => {
      // Lock affected tables first, matching table move/rename/delete lock order.
      const tablePlaceholders = tableNames.map(() => '?').join(',');
      const lockedTables = await allAsync(
        'SELECT id, name FROM tables WHERE store_id=? AND name IN (' + tablePlaceholders + ') ORDER BY id FOR UPDATE',
        [req.storeId, ...tableNames]
      );
      if (lockedTables.length !== tableNames.length) {
        const error = new Error('订单关联桌台已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }
      // Then lock orders in stable ID order and revalidate the live amounts/items.
      const lockedOrders = await allAsync(
        "SELECT * FROM orders WHERE id IN (" + placeholders + ") AND store_id=? AND status='pending' ORDER BY id FOR UPDATE",
        [...orderIds, req.storeId]
      );
      if (lockedOrders.length !== orderIds.length) {
        const error = new Error('部分订单状态已变化，批量结算已取消');
        error.status = 409;
        throw error;
      }
      if (lockedOrders.some(order => !tableNames.includes(order.table_name))) {
        const error = new Error('订单桌台已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }
      if (lockedOrders.some(hasActiveKhqr)) {
        const error = new Error('订单仍有待确认或有效 KHQR 收款码，请先完成确认或取消收款码');
        error.status = 409;
        throw error;
      }
      const lockedOrderTotalCents = lockedOrders.map(order => toMoneyCents(order.total));
      const lockedTotalCents = lockedOrderTotalCents.some(cents => cents === null || cents <= 0)
        ? null
        : lockedOrderTotalCents.reduce((sum, cents) => sum + cents, 0);
      if (!Number.isSafeInteger(lockedTotalCents) || lockedTotalCents !== totalAmountCents ||
          (isCashPayment && cashReceivedCents < lockedTotalCents)) {
        const error = new Error('订单金额已变化，请刷新后重新核对收款金额');
        error.status = 409;
        throw error;
      }
      for (const order of lockedOrders) {
        let liveItems;
        try { liveItems = JSON.parse(order.items || '[]'); } catch (_) { liveItems = null; }
        if (!Array.isArray(liveItems) || !liveItems.length || !liveItems.every(item => item.itemStatus === 'done')) {
          const error = new Error('订单 ' + (order.order_no || order.id) + ' 存在未完成菜品或数据异常');
          error.status = 409;
          throw error;
        }
      }
      settlementOrders = lockedOrders;
      tableNames = [...new Set(lockedOrders.map(o => o.table_name))];
      for (let index = 0; index < settlementOrders.length; index++) {
        const order = settlementOrders[index];
        // Allocate any batch cash change to the final order so per-order totals
        // reconcile with the aggregate cash tendered and change in the audit log.
        const orderCents = toMoneyCents(order.total);
        if (orderCents === null || orderCents <= 0) {
          const error = new Error('订单金额无效，批量结算已取消');
          error.status = 409;
          throw error;
        }
        const orderCashChangeCents = isCashPayment && index === settlementOrders.length - 1 ? cashChangeCents : 0;
        const orderCashChange = orderCashChangeCents / 100;
        const orderCashReceived = isCashPayment ? (orderCents + orderCashChangeCents) / 100 : 0;
        const updated = await runAsync("UPDATE orders SET status='done', awaiting_confirm=0, pay_khqr_ref='', pay_expires_at='', pay_qr_generation_id='', settled_at=?, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending'", [now, paymentMethod, orderCashReceived, orderCashChange, order.id, req.storeId]);
        if (!updated.affectedRows) {
          const error = new Error('订单状态已变化，批量结算已回滚，请刷新后重试');
          error.status = 409;
          throw error;
        }
      }
      const store = await getAsync('SELECT name FROM stores WHERE id=? AND merchant_id=?', [req.storeId, req.merchantId]);
      for (const order of settlementOrders) {
        await enqueueSystemAdminTelegramNotification({
          getAsync,
          eventKey: `order:${order.id}:settled`,
          event: { type: 'order.settled', storeName: store?.name || `Store ${req.storeId}`, orderNo: order.order_no || String(order.id), amount: Number(order.total), currency: 'USD' }
        });
      }
      for (const tableName of tableNames) {
        await syncTableStatus(tableName, req.storeId);
        const left = await getAsync("SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [tableName, req.storeId]);
        if (!left || Number(left.cnt) === 0) await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [tableName, req.storeId]);
      }
      await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'batch_settle', JSON.stringify({ order_ids: settlementOrders.map(o => o.id), tables: tableNames, count: settlementOrders.length, total: totalAmount.toFixed(2), pay_method: paymentMethod, cash_received: cashReceived, cash_change: cashChange }), getClientIp(req), now]);
    });
    let printed = false, printError = null;
    const autoPrintRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", ['auto_print_receipt_' + req.storeId]);
    if (autoPrintRow && autoPrintRow.value === '1') {
      try {
        const printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [req.storeId]);
        const store = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [req.storeId, req.merchantId]);
        if (printer && printer.type === 'network' && printer.ip_address) {
          const printData = buildBatchReceipt(settlementOrders, store, printer);
          await printToNetworkPrinter(printData, printer.ip_address, printer.port);
          printed = true;
        }
      } catch (pe) { printError = '打印机连接失败，请检查设备连接和网络设置'; }
    }
    // Broadcast every settled order so KDS, waiter, cashier and customer views
    // converge immediately after a batch operation just like single settlement.
    for (const order of settlementOrders) {
      const payload = { orderId: Number(order.id) };
      io.to('kitchen-' + req.storeId).emit('order:settled', payload);
      io.to('waiter-' + req.storeId).emit('order:settled', payload);
      io.to('cashier-' + req.storeId).emit('order:settled', payload);
      io.to('public-table-' + req.storeId + '-' + order.table_name).emit('order:settled', payload);
    }
    res.json({ success: true, settled: settlementOrders.length, total: totalAmount.toFixed(2), printed, printError });
  } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
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
        return res.status(502).json({ success: false, error: '打印机连接失败，请检查设备连接和网络设置', printData: printData.toString('base64') });
      }
    }
    res.json({ success: true, printed: false, printData: printData.toString('base64') });
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

app.put('/api/cashier/orders/:id/settle', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_settle) {
      return res.status(403).json({ error: '没有结算订单权限' });
    }
    const id = parsePositiveOrderId(req.params.id);
    if (id === null) return res.status(400).json({ error: '订单编号无效' });
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status === 'done') return res.status(400).json({ error: '订单已结算' });
    if (order.status === 'canceled') return res.status(400).json({ error: '订单已取消' });
    if (hasActiveKhqr(order)) return res.status(409).json({ error: '订单仍有待确认或有效 KHQR 收款码，请先完成确认或取消收款码' });
    try {
      const items = JSON.parse(order.items || '[]');
      if (!Array.isArray(items) || !items.length || !items.every(it => it.itemStatus === 'done')) return res.status(400).json({ error: '存在未完成菜品或没有有效菜品，无法结算' });
    } catch(e) { return res.status(400).json({ error: '订单数据异常' }); }
    const { pay_method, cash_received } = req.body || {};
    const paymentMethod = typeof pay_method === 'string' ? pay_method.trim().slice(0, 40) : '';
    if (!paymentMethod) return res.status(400).json({ error: '请选择收款方式' });
    const orderTotalCents = toMoneyCents(order.total);
    if (orderTotalCents === null || orderTotalCents <= 0) return res.status(400).json({ error: '订单金额无效' });
    const isCashPayment = paymentMethod.toLowerCase() === 'cash';
    const cashReceivedCents = isCashPayment ? toMoneyCents(cash_received) : 0;
    if (isCashPayment && (cashReceivedCents === null || cashReceivedCents < orderTotalCents)) {
      return res.status(400).json({ error: '现金实收金额不足或格式无效，最多只能有两位小数' });
    }
    const cashChangeCents = isCashPayment ? cashReceivedCents - orderTotalCents : 0;
    const cashReceived = isCashPayment ? cashReceivedCents / 100 : 0;
    const cashChange = cashChangeCents / 100;
    const settledAt = new Date().toISOString();
    let settledTableName = order.table_name;
    await withTransaction(async () => {
      // Lock the table before the order, matching table move/rename/delete operations.
      const lockedTable = await getAsync(
        'SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE',
        [order.table_name, req.storeId]
      );
      if (!lockedTable) {
        const error = new Error('订单关联桌台已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }
      // Re-read the order after obtaining the table lock.
      const lockedOrder = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE', [id, req.storeId]);
      if (!lockedOrder || lockedOrder.status !== 'pending' || lockedOrder.table_name !== order.table_name) {
        const error = new Error('订单状态已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }
      if (hasActiveKhqr(lockedOrder)) {
        const error = new Error('订单已有待确认或有效 KHQR 收款码，请先完成确认或取消收款码');
        error.status = 409;
        throw error;
      }
      const lockedTotalCents = toMoneyCents(lockedOrder.total);
      let lockedItems;
      try { lockedItems = JSON.parse(lockedOrder.items || '[]'); } catch (_) { lockedItems = null; }
      if (lockedTotalCents === null || lockedTotalCents <= 0 ||
          lockedTotalCents !== orderTotalCents ||
          !Array.isArray(lockedItems) || !lockedItems.length || !lockedItems.every(item => item.itemStatus === 'done')) {
        const error = new Error('订单内容或金额已变化，请刷新后重新核对');
        error.status = 409;
        throw error;
      }
      if (isCashPayment && cashReceivedCents < lockedTotalCents) {
        const error = new Error('现金实收金额不足，请重新录入');
        error.status = 400;
        throw error;
      }
      settledTableName = lockedOrder.table_name;
      const settled = await runAsync(
        "UPDATE orders SET status='done', awaiting_confirm=0, pay_khqr_ref='', pay_expires_at='', pay_qr_generation_id='', settled_at=?, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending'",
        [settledAt, paymentMethod, cashReceived, cashChange, id, req.storeId]
      );
      if (!settled.affectedRows) {
        const error = new Error('订单状态已变化，请刷新后重试');
        error.status = 409;
        throw error;
      }
      await syncTableStatus(settledTableName, req.storeId);
      const stillPending = await getAsync("SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [settledTableName, req.storeId]);
      if (!stillPending || Number(stillPending.cnt) === 0) {
        await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [settledTableName, req.storeId]);
      }
      await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'settle_order', JSON.stringify({ order_id: id, table: settledTableName, total: lockedOrder.total, pay_method: paymentMethod, cash_received: cashReceived, cash_change: cashChange }), getClientIp(req), settledAt]);
    });
    io.to('kitchen-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('waiter-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('cashier-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('public-table-' + req.storeId + '-' + settledTableName).emit('order:settled', { orderId: id });
    res.json({ success: true, message: '结算成功' });
  } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
});

app.put('/api/cashier/orders/:id/cancel', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_cancel) {
      return res.status(403).json({ error: '没有取消订单权限' });
    }
    const id = parsePositiveOrderId(req.params.id);
    if (id === null) return res.status(400).json({ error: '订单编号无效' });
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status === 'canceled') return res.status(400).json({ error: '订单已取消' });
    if (order.status !== 'pending') return res.status(400).json({ error: '只有待处理订单可以取消' });
    const canceledAt = new Date().toISOString();
    let canceledTableName = order.table_name;
    await withTransaction(async () => {
      const lockedTable = await getAsync(
        'SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE',
        [order.table_name, req.storeId]
      );
      if (!lockedTable) {
        const error = new Error('订单关联桌台已变化，取消操作已中止');
        error.status = 409;
        throw error;
      }
      const lockedOrder = await getAsync(
        'SELECT table_name, status, awaiting_confirm, pay_khqr_ref, pay_expires_at FROM orders WHERE id=? AND store_id=? FOR UPDATE',
        [id, req.storeId]
      );
      if (!lockedOrder || lockedOrder.status !== 'pending' || lockedOrder.table_name !== order.table_name) {
        const error = new Error('订单状态已变化，取消操作已中止');
        error.status = 409;
        throw error;
      }
      // Do not cancel an order while a customer may still complete its KHQR payment.
      // Recheck after acquiring the order lock to close the race with QR generation/notification.
      if (hasActiveKhqr(lockedOrder)) {
        const error = new Error('订单仍有待确认或有效 KHQR 收款码，请先取消收款码后再取消订单');
        error.status = 409;
        throw error;
      }
      canceledTableName = lockedOrder.table_name;
      const canceled = await runAsync(
        "UPDATE orders SET status='canceled', awaiting_confirm=0, pay_khqr_ref='', pay_expires_at='', pay_qr_generation_id='' WHERE id=? AND store_id=? AND status='pending'",
        [id, req.storeId]
      );
      if (!canceled.affectedRows) {
        const error = new Error('订单状态已变化，取消操作已中止');
        error.status = 409;
        throw error;
      }
      await syncTableStatus(canceledTableName, req.storeId);
      await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'cancel_order', JSON.stringify({ order_id: id, table: canceledTableName }), getClientIp(req), canceledAt]);
    });
    const canceledPayload = { orderId: Number(id) };
    io.to('kitchen-' + req.storeId).emit('order:cancelled', canceledPayload);
    io.to('waiter-' + req.storeId).emit('order:cancelled', canceledPayload);
    io.to('cashier-' + req.storeId).emit('order:cancelled', canceledPayload);
    io.to('public-table-' + req.storeId + '-' + canceledTableName).emit('order:cancelled', canceledPayload);
    res.json({ success: true, message: '取消成功' });
  } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
});

app.put('/api/cashier/orders/:id/refund', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_refund) {
      return res.status(403).json({ error: '没有退款权限' });
    }
    const id = parsePositiveOrderId(req.params.id);
    if (id === null) return res.status(400).json({ error: '订单编号无效' });
    const { amount, reason, note } = req.body || {};
    const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 100) : '';
    if (!cleanReason) return res.status(400).json({ error: '请选择退款原因' });
    const requestedAmountCents = amount === undefined || amount === null || amount === ''
      ? null
      : toMoneyCents(amount);
    if (requestedAmountCents !== null && requestedAmountCents <= 0) {
      return res.status(400).json({ error: '退款金额必须是大于 0 的有效金额' });
    }
    if (amount !== undefined && amount !== null && amount !== '' && requestedAmountCents === null) {
      return res.status(400).json({ error: '退款金额最多只能有两位小数' });
    }
    const cleanNote = typeof note === 'string' ? note.slice(0, 200) : '';
    const idempotencyKey = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
    if (!isValidRefundIdempotencyKey(idempotencyKey)) {
      return res.status(400).json({ error: '退款请求标识无效，请重新打开退款窗口后重试' });
    }
    const requestHash = createRefundRequestHash({
      orderId: id,
      amountCents: requestedAmountCents,
      reason: cleanReason,
      note: cleanNote,
      cashier: String(req.cashier.username || '')
    });
    const now = new Date().toISOString();
    let tableName = '';
    let orderTotal = 0;
    let refundAmount = 0;
    let totalRefunded = 0;
    let remainingAmount = 0;
    let fullyRefunded = false;
    let responsePayload = null;
    let replayedResponse = null;

    await withTransaction(async () => {
      const insertRequest = await runAsync(
        'INSERT IGNORE INTO refund_requests (store_id, order_id, idempotency_key, request_hash, response_json, cashier_username, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
        [req.storeId, id, idempotencyKey, requestHash, req.cashier.username || '', now]
      );
      const existingRequest = await getAsync(
        'SELECT request_hash, response_json FROM refund_requests WHERE store_id=? AND idempotency_key=? FOR UPDATE',
        [req.storeId, idempotencyKey]
      );
      if (!existingRequest) throw new Error('退款请求记录创建失败');
      if (existingRequest.request_hash !== requestHash) {
        const error = new Error('该退款请求标识已用于其他退款内容，请勿重复使用');
        error.status = 409;
        throw error;
      }
      if (existingRequest.response_json) {
        try { replayedResponse = JSON.parse(existingRequest.response_json); }
        catch (_) { throw new Error('退款请求记录损坏，请联系管理员核对'); }
        return;
      }
      if (Number(insertRequest.affectedRows) !== 1) {
        const error = new Error('该退款请求仍在处理中或记录不完整，请稍后使用原请求标识重试');
        error.status = 409;
        throw error;
      }

      const lockedOrder = await getAsync(
        'SELECT status, total, refund_amount, table_name, order_no FROM orders WHERE id=? AND store_id=? FOR UPDATE',
        [id, req.storeId]
      );
      if (!lockedOrder) {
        const error = new Error('订单不存在');
        error.status = 404;
        throw error;
      }
      if (lockedOrder.status !== 'done') {
        const error = new Error(lockedOrder.status === 'refunded' ? '订单已全额退款' : '只有已结算且未全额退款的订单才能退款');
        error.status = 409;
        throw error;
      }

      const orderTotalCents = toMoneyCents(lockedOrder.total);
      const alreadyRefundedCents = lockedOrder.refund_amount === null || lockedOrder.refund_amount === undefined || lockedOrder.refund_amount === ''
        ? 0
        : toMoneyCents(lockedOrder.refund_amount);
      if (orderTotalCents === null || orderTotalCents <= 0 ||
          alreadyRefundedCents === null || alreadyRefundedCents < 0 || alreadyRefundedCents > orderTotalCents) {
        const error = new Error('订单金额或历史退款金额无效，无法退款');
        error.status = 409;
        throw error;
      }
      const allocation = calculateRefundAllocation({
        orderTotalCents,
        alreadyRefundedCents,
        requestedRefundCents: requestedAmountCents
      });
      if (!allocation) {
        const error = new Error('订单退款金额计算异常，操作已取消');
        error.status = 409;
        throw error;
      }
      if (allocation.reason === 'no-balance') {
        const error = new Error('订单没有可退款余额');
        error.status = 409;
        throw error;
      }
      if (allocation.reason === 'exceeds-balance' || allocation.reason === 'invalid-request') {
        const error = new Error('退款金额不能超过剩余可退款金额 ' + (allocation.availableCents / 100).toFixed(2));
        error.status = 400;
        throw error;
      }
      const { availableCents, refundAmountCents, totalRefundedCents, remainingCents } = allocation;
      orderTotal = orderTotalCents / 100;
      refundAmount = refundAmountCents / 100;
      totalRefunded = totalRefundedCents / 100;
      fullyRefunded = remainingCents === 0;
      remainingAmount = remainingCents / 100;
      tableName = lockedOrder.table_name;
      const refundUpdate = await runAsync(
        "UPDATE orders SET status=?, refund_reason=?, refund_note=?, refunded_at=?, refunded_by=?, refund_amount=? WHERE id=? AND store_id=? AND status='done'",
        [fullyRefunded ? 'refunded' : 'done', cleanReason, cleanNote, now, req.cashier.username || '', totalRefunded.toFixed(2), id, req.storeId]
      );
      if (!refundUpdate.affectedRows) {
        const error = new Error('订单状态已变化，退款操作已回滚');
        error.status = 409;
        throw error;
      }
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['cashier', 0, req.cashier.username, 'refund_order',
         JSON.stringify({ order_id: id, table: tableName, total: orderTotal, refund_amount: refundAmount, total_refunded: totalRefunded, remaining_amount: remainingAmount, fully_refunded: fullyRefunded, reason: cleanReason, note: cleanNote, idempotency_key: idempotencyKey }),
         getClientIp(req), now]
      );
      responsePayload = {
        success: true,
        message: fullyRefunded ? '订单已全额退款' : '部分退款成功',
        refund_amount: refundAmount,
        total_refunded: totalRefunded,
        remaining_amount: remainingAmount,
        fully_refunded: fullyRefunded
      };
      const savedRequest = await runAsync(
        'UPDATE refund_requests SET response_json=? WHERE store_id=? AND idempotency_key=? AND request_hash=?',
        [JSON.stringify(responsePayload), req.storeId, idempotencyKey, requestHash]
      );
      if (!savedRequest.affectedRows) throw new Error('退款结果保存失败，操作已回滚');
      const store = await getAsync('SELECT name FROM stores WHERE id=? AND merchant_id=?', [req.storeId, req.merchantId]);
      const refundKey = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);
      await enqueueSystemAdminTelegramNotification({
        getAsync,
        eventKey: `order:${id}:refunded:${refundKey}`,
        event: { type: 'order.refunded', storeName: store?.name || `Store ${req.storeId}`, orderNo: lockedOrder.order_no || String(id), refundAmount, currency: 'USD' }
      });
    });

    if (replayedResponse) return res.json({ ...replayedResponse, idempotent_replay: true });
    io.to('kitchen-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('waiter-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('cashier-' + req.storeId).emit('order:settled', { orderId: id });
    io.to('public-table-' + req.storeId + '-' + tableName).emit('order:settled', { orderId: id });
    res.json(responsePayload);
  } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
});

// ===== 单个订单打印小票 =====
app.post('/api/cashier/orders/:id(\\d+)/print', requireCashier, async (req, res) => {
  try {
    const id = parsePositiveOrderId(req.params.id);
    if (id === null) return res.status(400).json({ error: '订单编号无效' });
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    const formattedOrder = formatStaffOrder(order, formatOrder);
    const store = await getAsync('SELECT name, address, phone FROM stores WHERE id=?', [req.storeId]);

    const result = await dispatchPrint({
      order: formattedOrder,
      type: 'receipt',
      store: store || { name: 'FoodFlow', address: '' },
      getAsync,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: '请求失败，请稍后重试' });
  }
});

app.get('/api/cashier/report/today', requireCashier, async (req, res) => {
  try {
    if (!req.cashier.permissions?.can_view_report) {
      return res.status(403).json({ error: '没有查看报表权限' });
    }
    const today = new Date().toISOString().split('T')[0];
    const settledOrders = await allAsync("SELECT * FROM orders WHERE store_id=? AND status IN ('done', 'refunded') AND SUBSTRING(COALESCE(settled_at, createdAt), 1, 10)=? ORDER BY COALESCE(settled_at, createdAt) DESC", [req.storeId, today]);
    const reportAmounts = settledOrders.map(order => {
      const orderTotalCents = toMoneyCents(order.total);
      const refundedCents = order.refund_amount === null || order.refund_amount === undefined || order.refund_amount === ''
        ? 0
        : toMoneyCents(order.refund_amount);
      if (orderTotalCents === null || orderTotalCents < 0 ||
          refundedCents === null || refundedCents < 0 || refundedCents > orderTotalCents) {
        const error = new Error('订单金额或历史退款金额异常，无法生成报表');
        error.status = 409;
        throw error;
      }
      return { revenueCents: orderTotalCents - refundedCents, refundedCents };
    });
    const totalRevenueCents = reportAmounts.reduce((sum, amount) => sum + amount.revenueCents, 0);
    const totalRefundedCents = reportAmounts.reduce((sum, amount) => sum + amount.refundedCents, 0);
    if (!Number.isSafeInteger(totalRevenueCents) || !Number.isSafeInteger(totalRefundedCents)) {
      const error = new Error('报表金额超出安全范围');
      error.status = 409;
      throw error;
    }
    const totalRevenue = totalRevenueCents / 100;
    const totalRefunded = totalRefundedCents / 100;
    const refundedOrderCount = settledOrders.filter(o => o.status === 'refunded').length;
    res.json({
      date: today,
      orderCount: settledOrders.length,
      totalRevenue: totalRevenue.toFixed(2),
      totalRefunded: totalRefunded.toFixed(2),
      refundedOrderCount,
      avgOrderValue: settledOrders.length > 0
        ? (Math.round(totalRevenueCents / settledOrders.length) / 100).toFixed(2)
        : '0.00',
      orders: settledOrders.map(row => formatStaffOrder(row, formatOrder))
    });
  } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
    res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
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
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
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
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

};

module.exports.parsePositiveOrderId = parsePositiveOrderId;
