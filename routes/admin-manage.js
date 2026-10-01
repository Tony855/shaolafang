/* ============================================================
   routes/admin-manage.js — 全局配置 + 催单 + 管理员/收银员 CRUD + 重置
   ============================================================ */
const crypto = require('crypto');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, hashPassword, verifyPassword, logAudit, getClientIp, io } = deps;

  app.get('/api/public/global-config', async (req, res) => {
    try {
      const idleSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
      const qrSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const intervalSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'order_interval_seconds'");
      const cashierIdle = await getAsync("SELECT value FROM settings WHERE `key` = 'cashier_idle_timeout'");
      const kitchenIdle = await getAsync("SELECT value FROM settings WHERE `key` = 'kitchen_idle_timeout'");
      res.json({
        admin_idle_timeout: parseInt(idleSetting?.value || '30', 10),
        qr_session_timeout: parseInt(qrSetting?.value || '45', 10),
        order_interval_seconds: parseInt(intervalSetting?.value || '30', 10),
        cashier_idle_timeout: parseInt(cashierIdle?.value || '30', 10),
        kitchen_idle_timeout: parseInt(kitchenIdle?.value || '120', 10),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 催单（需要 session 校验 + 限流）-----
  app.post('/api/orders/:id(\\d+)/urge', async (req, res) => {
    try {
      const id = req.params.id;
      const { sessionToken } = req.body || {};

      // 1. 必须带 sessionToken
      if (!sessionToken) {
        return res.status(401).json({ error: '请重新扫码后再催单' });
      }

      // 2. 验证 session 有效
      const session = await getAsync('SELECT table_name, store_id, expires_at FROM scan_sessions WHERE token=?', [sessionToken]);
      if (!session) return res.status(401).json({ error: '扫码会话不存在，请重新扫码' });
      if (new Date(session.expires_at).getTime() < Date.now()) {
        return res.status(410).json({ error: '二维码已过期，请重新扫码' });
      }

      // 3. 订单必须属于该 session 的桌号 + 店铺
      const order = await getAsync(
        'SELECT * FROM orders WHERE id=? AND store_id=? AND table_name=?',
        [id, session.store_id, session.table_name]
      );
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.status !== 'pending') return res.status(400).json({ error: '订单已完成或已取消' });

      // 4. 催单限流：同一订单 5 分钟内只能催 1 次
      const URGE_COOLDOWN_MS = 5 * 60 * 1000;
      const recent = await getAsync(
        "SELECT created_at FROM waiter_calls WHERE table_name=? AND store_id=? AND type='urge' AND message LIKE ? ORDER BY created_at DESC LIMIT 1",
        [order.table_name, order.store_id, `%#${id} %`]
      );
      if (recent) {
        const elapsed = Date.now() - new Date(recent.created_at).getTime();
        if (elapsed < URGE_COOLDOWN_MS) {
          const remaining = Math.ceil((URGE_COOLDOWN_MS - elapsed) / 60000);
          return res.status(429).json({ error: `已催单，请${remaining}分钟后再试`, cooldownMinutes: remaining });
        }
      }

      // 5. 写入催单记录
      const callId = crypto.randomBytes(16).toString('hex');
      await runAsync(
        'INSERT INTO waiter_calls (id, table_name, type, message, status, store_id, created_at, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
        [callId, order.table_name, 'urge', `订单 #${id} 顾客催单`, 'pending', order.store_id || 1, new Date().toISOString(), order.store_id || 1]
      );

      io.to('kitchen-' + (order.store_id || 1)).emit('order:urge', { orderId: id, table: order.table_name });
      io.to('waiter-' + (order.store_id || 1)).emit('order:urge', { orderId: id, table: order.table_name });

      res.json({ success: true, message: '已通知后厨，请稍候' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 商户管理员管理 -----
  app.get('/api/admin/admins', requireAdminKey, async (req, res) => {
    try {
      const rows = await allAsync('SELECT id, username, display_name, active, last_login_at, created_at, (id = (SELECT MIN(id) FROM merchant_admins ma2 WHERE ma2.merchant_id = merchant_admins.merchant_id)) AS is_primary, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier FROM merchant_admins WHERE merchant_id=? ORDER BY id', [req.merchantId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/admins', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const { username, password, display_name, active } = req.body || {};
      if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写管理员资料' });
      if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      const exists = await getAsync('SELECT id FROM merchant_admins WHERE username=?', [String(username).trim()]);
      if (exists) return res.status(400).json({ error: '用户名已存在' });
      const result = await runAsync(
        'INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name, active) VALUES (?, ?, ?, ?, ?)',
        [req.merchantId, String(username).trim(), hashPassword(password), display_name, active ? 1 : 0]
      );
      await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'create_admin', 'merchant_admin', result.lastID, `创建管理员: ${username}`, getClientIp(req));
      res.status(201).json(await getAsync('SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier FROM merchant_admins WHERE id=?', [result.lastID]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { display_name, active, password, permissions } = req.body || {};
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
      if (!admin) return res.status(404).json({ error: '管理员不存在' });
      const primaryAdminId = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [req.merchantId]);
      const isPrimaryAdmin = primaryAdminId && primaryAdminId.min_id === admin.id;
      if (isPrimaryAdmin) return res.status(400).json({ error: '主管理员拥有全部权限，不可修改权限和状态' });
      if (id === req.adminId && active === 0) return res.status(400).json({ error: '不能禁用当前登录账号' });
      const fields = [];
      const values = [];
      if (display_name !== undefined) { fields.push('display_name=?'); values.push(display_name); }
      if (active !== undefined) { fields.push('active=?'); values.push(active ? 1 : 0); }
      if (password) {
        if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
        fields.push('password_hash=?'); values.push(hashPassword(password));
      }
      if (permissions && typeof permissions === 'object') {
        const permFields = ['can_manage_menu', 'can_manage_table', 'can_manage_order', 'can_delete_order', 'can_edit_order', 'can_manage_store', 'can_manage_waiter', 'can_manage_currency', 'can_manage_printer', 'can_manage_admin', 'can_view_logs', 'can_manage_cashier'];
        for (const field of permFields) {
          if (permissions[field] !== undefined) {
            fields.push(field + '=?');
            values.push(permissions[field] ? 1 : 0);
          }
        }
      }
      if (fields.length) {
        values.push(id);
        values.push(req.merchantId);
        await runAsync(`UPDATE merchant_admins SET ${fields.join(',')} WHERE id=? AND merchant_id=?`, values);
      }
      await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'update_admin', 'merchant_admin', id, `更新管理员: ${admin.username}`, getClientIp(req));
      res.json(await getAsync('SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (id === req.adminId) return res.status(400).json({ error: '不能删除当前登录账号' });
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
      if (admin) {
        const primaryAdminIdDel = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [req.merchantId]);
        if (primaryAdminIdDel && primaryAdminIdDel.min_id === admin.id) return res.status(400).json({ error: '主管理员不可删除' });
      }
      if (!admin) return res.status(404).json({ error: '管理员不存在' });
      await runAsync('DELETE FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
      await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'delete_admin', 'merchant_admin', id, `删除管理员: ${admin.username}`, getClientIp(req));
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 收银员管理（按商户聚合，跨店铺）-----
  async function getCashiers(storeId) {
    const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", ['cashiers_' + storeId]);
    if (!row || !row.value) return [];
    try { return JSON.parse(row.value); } catch (e) { return []; }
  }
  async function saveCashiers(storeId, cashiers) {
    const exists = await getAsync("SELECT value FROM settings WHERE `key` = ?", ['cashiers_' + storeId]);
    if (exists) {
      await runAsync("UPDATE settings SET value=? WHERE `key`=?", [JSON.stringify(cashiers), 'cashiers_' + storeId]);
    } else {
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?)", ['cashiers_' + storeId, JSON.stringify(cashiers)]);
    }
  }

  // 聚合查询本商户下所有店铺的收银员
  async function getAllCashiersByMerchant(merchantId) {
    const stores = await allAsync('SELECT id, name FROM stores WHERE merchant_id=? ORDER BY id', [merchantId]);
    const result = [];
    for (const s of stores) {
      const list = await getCashiers(s.id);
      for (const c of list) {
        result.push({
          id: c.id,
          username: c.username,
          display_name: c.display_name,
          active: c.active,
          permissions: c.permissions,
          created_at: c.created_at,
          store_id: s.id,
          store_name: s.name
        });
      }
    }
    return result;
  }

  // 根据 cashier.id 找到所在店铺
  async function findCashierStore(merchantId, cashierId) {
    const stores = await allAsync('SELECT id, name FROM stores WHERE merchant_id=? ORDER BY id', [merchantId]);
    for (const s of stores) {
      const list = await getCashiers(s.id);
      const idx = list.findIndex(c => c.id === cashierId);
      if (idx !== -1) return { store: s, list, idx };
    }
    return null;
  }

  app.get('/api/admin/cashiers', requireAdminKey, async (req, res) => {
    try {
      const list = await getAllCashiersByMerchant(req.merchantId);
      res.json({ cashiers: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/cashiers', requireAdminKey, async (req, res) => {
    try {
      const { username, password, display_name, permissions, active, store_id } = req.body || {};
      if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写收银员资料' });
      if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

      const targetStoreId = parseInt(store_id, 10) || req.storeId || 1;

      const store = await getAsync('SELECT id, name FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
      if (!store) return res.status(400).json({ error: '目标店铺不存在或不属于当前商户' });

      const all = await getAllCashiersByMerchant(req.merchantId);
      if (all.find(c => c.username === String(username).trim())) {
        return res.status(400).json({ error: '该商户下已存在同名收银员账号' });
      }
      const dupWaiter = await getAsync('SELECT id FROM waiters WHERE username=? LIMIT 1', [String(username).trim()]);
      if (dupWaiter) return res.status(409).json({ error: '该用户名已被服务员账号使用，请换一个' });

      const cashiers = await getCashiers(targetStoreId);
      const newCashier = {
        id: Date.now(),
        username: String(username).trim(),
        display_name,
        password_hash: hashPassword(password),
        active: active !== false,
        permissions: {
          can_settle: permissions?.can_settle !== false,
          can_cancel: permissions?.can_cancel !== false,
          can_refund: permissions?.can_refund === true,
          can_view_report: permissions?.can_view_report !== false
        },
        created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
      };
      cashiers.push(newCashier);
      await saveCashiers(targetStoreId, cashiers);
      await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'create_cashier', 'cashier', newCashier.id, `创建收银员: ${username} (店铺 #${targetStoreId})`, getClientIp(req));
      res.status(201).json({ success: true, cashier: { id: newCashier.id, username: newCashier.username, display_name: newCashier.display_name, active: newCashier.active, permissions: newCashier.permissions, created_at: newCashier.created_at, store_id: targetStoreId, store_name: store.name } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/cashiers/:id', requireAdminKey, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { display_name, password, permissions, active, store_id } = req.body || {};

      const found = await findCashierStore(req.merchantId, id);
      if (!found) return res.status(404).json({ error: '收银员不存在' });
      const { store: oldStore, list: oldList, idx } = found;
      const cashier = oldList[idx];

      const targetStoreId = parseInt(store_id, 10) || oldStore.id;
      const storeChanged = targetStoreId !== oldStore.id;

      let newStore = oldStore;
      if (storeChanged) {
        const s = await getAsync('SELECT id, name FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
        if (!s) return res.status(400).json({ error: '目标店铺不存在或不属于当前商户' });
        newStore = s;
        const all = await getAllCashiersByMerchant(req.merchantId);
        if (all.find(c => c.id !== id && c.username === cashier.username)) {
          return res.status(400).json({ error: '目标店铺已存在同名收银员' });
        }
      }

      if (display_name !== undefined) cashier.display_name = display_name;
      if (active !== undefined) cashier.active = active !== false;
      if (password) {
        if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
        cashier.password_hash = hashPassword(password);
      }
      if (permissions && typeof permissions === 'object') {
        if (permissions.can_settle !== undefined) cashier.permissions.can_settle = permissions.can_settle !== false;
        if (permissions.can_cancel !== undefined) cashier.permissions.can_cancel = permissions.can_cancel !== false;
        if (permissions.can_refund !== undefined) cashier.permissions.can_refund = permissions.can_refund === true;
        if (permissions.can_view_report !== undefined) cashier.permissions.can_view_report = permissions.can_view_report !== false;
      }

      if (storeChanged) {
        oldList.splice(idx, 1);
        await saveCashiers(oldStore.id, oldList);
        const targetList = await getCashiers(newStore.id);
        targetList.push(cashier);
        await saveCashiers(newStore.id, targetList);
      } else {
        oldList[idx] = cashier;
        await saveCashiers(oldStore.id, oldList);
      }

      await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'update_cashier', 'cashier', id, `更新收银员: ${cashier.username}${storeChanged ? ' (店铺 #' + oldStore.id + ' -> #' + newStore.id + ')' : ''}`, getClientIp(req));
      res.json({ success: true, cashier: { id: cashier.id, username: cashier.username, display_name: cashier.display_name, active: cashier.active, permissions: cashier.permissions, created_at: cashier.created_at, store_id: newStore.id, store_name: newStore.name } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/cashiers/:id', requireAdminKey, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const found = await findCashierStore(req.merchantId, id);
      if (!found) return res.status(404).json({ error: '收银员不存在' });
      const { store, list, idx } = found;
      const username = list[idx].username;
      list.splice(idx, 1);
      await saveCashiers(store.id, list);
      await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'delete_cashier', 'cashier', id, `删除收银员: ${username} (店铺 #${store.id})`, getClientIp(req));
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/reset-data', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: '请输入管理员密码' });
      const merchantId = req.merchantId;
      if (!merchantId) return res.status(400).json({ error: '商户信息缺失' });
      const admin = await getAsync('SELECT password_hash FROM merchant_admins WHERE id=?', [req.adminId]);
      if (!admin || !verifyPassword(password, admin.password_hash)) {
        return res.status(401).json({ error: '密码错误，重置失败' });
      }
      await runAsync('DELETE FROM orders WHERE merchant_id = ?', [merchantId]);
      await runAsync('DELETE FROM waiter_calls WHERE merchant_id = ?', [merchantId]);
      await runAsync('DELETE FROM scan_sessions WHERE merchant_id = ?', [merchantId]);
      await runAsync('DELETE FROM reservations WHERE merchant_id = ?', [merchantId]);
      res.json({ success: true, message: '订单数据已重置' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
