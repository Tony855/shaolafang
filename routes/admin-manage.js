/* ============================================================
   routes/admin-manage.js — 全局配置 + 催单 + 管理员/收银员 CRUD + 重置
   ============================================================ */
const crypto = require('crypto');
const QRCode = require('qrcode');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrCashier, requireAdminOrCashierOrWaiter, requireAdminOrWaiter, hashPassword, verifyPassword, logAudit, getClientIp, io } = deps;

  /* ===== KHQR 多收款码管理 ===== */
  // ★ 内存缓存：KHQR providers 读得多改得少，缓存 30 秒
  const _khqrProvidersCache = new Map();  // storeId -> { data, expireAt }
  const KHQR_PROVIDERS_TTL = 30000;

  async function loadKhqrProviders(storeId) {
    const cached = _khqrProvidersCache.get(storeId);
    if (cached && cached.expireAt > Date.now()) {
      return cached.data;
    }
    const row = await getAsync('SELECT value FROM settings WHERE `key`=?', ['store_' + storeId + '_khqr_providers']);
    let data = [];
    if (row && row.value) {
      try { data = JSON.parse(row.value); } catch (e) { data = []; }
    }
    _khqrProvidersCache.set(storeId, { data, expireAt: Date.now() + KHQR_PROVIDERS_TTL });
    return data;
  }

  // ★ 写操作后主动失效缓存
  function invalidateKhqrProviders(storeId) {
    _khqrProvidersCache.delete(storeId);
  }

  async function saveKhqrProviders(storeId, list) {
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      ['store_' + storeId + '_khqr_providers', JSON.stringify(list)]
    );
    // ★ 写后失效缓存
    if (typeof invalidateKhqrProviders === 'function') invalidateKhqrProviders(storeId);
  }

  /* ===== KHQR 辅助：解析并校验当前 store ===== */
  async function resolveKhqrStore(req) {
    const sid = parseInt(req.storeId, 10) || 0;
    if (!sid || sid <= 0) {
      throw Object.assign(new Error('未指定店铺，请先在顶部切换店铺'), { status: 400 });
    }
    // 校验 store 属于当前商户
    const store = await getAsync('SELECT id, name FROM stores WHERE id=? AND merchant_id=?', [sid, req.merchantId]);
    if (!store) {
      throw Object.assign(new Error('店铺不存在或不属于当前商户'), { status: 403 });
    }
    return { storeId: store.id, storeName: store.name };
  }


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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ----- 商户管理员管理 -----
  app.get('/api/admin/admins', requireAdminKey, async (req, res) => {
    try {
      const rows = await allAsync('SELECT id, username, display_name, active, last_login_at, created_at, (id = (SELECT MIN(id) FROM merchant_admins ma2 WHERE ma2.merchant_id = merchant_admins.merchant_id)) AS is_primary, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier FROM merchant_admins WHERE merchant_id=? ORDER BY id', [req.merchantId]);
      res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  app.post('/api/admin/admins', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const { username, password, display_name, active, permissions } = req.body || {};
      if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写管理员资料' });
      if (password.length < 12 || password.length > 128) return res.status(400).json({ error: '管理员密码长度必须为 12 至 128 个字符' });
      const exists = await getAsync('SELECT id FROM merchant_admins WHERE username=?', [String(username).trim()]);
      if (exists) return res.status(400).json({ error: '用户名已存在' });

      const p1 = permissions || {};
      const permFields = ['can_manage_menu','can_manage_table','can_manage_order','can_delete_order','can_edit_order','can_manage_store','can_manage_waiter','can_manage_currency','can_manage_printer','can_manage_admin','can_view_logs','can_manage_cashier'];
      const permCols = permFields.join(', ');
      const permVals = permFields.map(f => p1[f] ? 1 : 0);

      const result = await runAsync(
        'INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name, active, ' + permCols + ') VALUES (?, ?, ?, ?, ?, ' + permFields.map(() => '?').join(',') + ')',
        [req.merchantId, String(username).trim(), hashPassword(password), display_name, active ? 1 : 0, ...permVals]
      );
      await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'create_admin', 'merchant_admin', result.lastID, `创建管理员: ${username}`, getClientIp(req));
      res.status(201).json(await getAsync('SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier FROM merchant_admins WHERE id=?', [result.lastID]));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
        if (password.length < 12 || password.length > 128) return res.status(400).json({ error: '管理员密码长度必须为 12 至 128 个字符' });
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== KHQR 静态码上传 + 自动解析 ===== */
  const multer = require('multer');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const khqr = require('../server/services/khqr');

  const khqrUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, os.tmpdir()),
      filename: (req, file, cb) => cb(null, 'khqr_' + Date.now() + path.extname(file.originalname)),
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (/^image\//.test(file.mimetype)) return cb(null, true);
      cb(new Error('只能上传图片'));
    },
  });

  app.post('/api/admin/khqr/upload', requireAdminKey, requirePermission('can_manage_store'), khqrUpload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '请上传二维码图片' });
      const filePath = req.file.path;
      try {
        const buf = fs.readFileSync(filePath);
        const { storeId: sid, storeName } = await resolveKhqrStore(req);

        // ★ 自动识别 KHQR / VietQR
        const { parseAnyQR } = require('../server/services/qr-detect');
        const parsed = await parseAnyQR(buf);

        const { identifyBank } = require('../server/config/khqr-banks');
        const { identifyVietBank } = require('../server/config/vietqr-banks');
        const explicitBank = (req.body && req.body.bank) ? String(req.body.bank).trim() : '';

        let bank, bankIcon = '', bakongId = '', bankBin = '', bankAccount = '';
        const { resolveIcon } = require('../server/services/icon-resolver');
        if (parsed.kind === 'VIETQR') {
          bankBin = parsed.bankBin || '';
          bankAccount = parsed.bankAccount || '';
          const info = identifyVietBank(bankBin);
          bank = explicitBank || info.name;
          bankIcon = resolveIcon(info.icon);
        } else {
          bakongId = parsed.bakongId || '';
          const info = identifyBank(bakongId);
          bank = explicitBank || info.name;
          bankIcon = resolveIcon(info.icon);
        }

        const currency = parsed.currency || (parsed.kind === 'VIETQR' ? 'VND' : 'USD');
        const label = (req.body && req.body.label || '').trim() ||
          (parsed.merchantName + ' - ' + currency);

        const list = await loadKhqrProviders(sid);
        const newProvider = {
          id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          country: parsed.country,                  // ★ 'KH' | 'VN'
          kind: parsed.kind,                        // ★ 'KHQR' | 'VIETQR'
          label: label,
          bank: bank,
          bankIcon: bankIcon,                       // ★ 磁盘真实文件名
          bankBin: bankBin,                         // VietQR 用
          bankAccount: bankAccount,                 // VietQR 用
          payload: parsed.payload,
          merchantName: parsed.merchantName,
          bakongId: bakongId,                       // KHQR 用
          currency: currency,
          qrType: parsed.qrType,                    // 'STATIC' | 'DYNAMIC'
          isDefault: list.length === 0,
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        list.push(newProvider);
        await saveKhqrProviders(sid, list);
        console.log('[khqr/upload] store=' + sid + ' (' + storeName + ') country=' +
          parsed.country + ' 新增 provider=' + newProvider.id);

        res.json({
          success: true,
          provider: newProvider,
          country: parsed.country,
          kind: parsed.kind,
          merchantName: parsed.merchantName,
          currency: currency,
          bank: bank,
          bankBin: bankBin,
          bankAccount: bankAccount,
          bakongId: bakongId,
          payloadPreview: parsed.payload.slice(0, 30) + '...',
          totalProviders: list.length,
        });
      } finally {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    } catch (e) {
      console.error('[khqr/upload]', e);
      res.status(400).json({ error: e.message });
    }
  });

  /* ===== 读取当前 KHQR 配置 ===== */
  app.get('/api/admin/khqr/info', requireAdminKey, async (req, res) => {
    try {
      const { storeId: sid, storeName } = await resolveKhqrStore(req);
      const payload = await getAsync('SELECT value FROM settings WHERE `key`=?', ['store_' + sid + '_khqr_static_payload']);
      const name = await getAsync('SELECT value FROM settings WHERE `key`=?', ['store_' + sid + '_khqr_merchant_name']);
      const bakong = await getAsync('SELECT value FROM settings WHERE `key`=?', ['store_' + sid + '_khqr_bakong_id']);
      res.json({
        configured: !!payload,
        merchantName: name ? name.value : '',
        bakongId: bakong ? bakong.value : '',
        payloadPreview: payload ? payload.value.slice(0, 30) + '...' : '',
      });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== 生成动态码 ===== */
  app.post('/api/cashier/khqr/generate', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      if (req.isCashier && !req.cashier?.permissions?.can_settle) return res.status(403).json({ error: '没有生成收款码权限' });
      if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_manage_order)) return res.status(403).json({ error: '没有订单收款权限' });
      if (req.isWaiter && !req.waiter?.can_order) return res.status(403).json({ error: '该服务员没有下单权限' });
      const { storeId: sid } = await resolveKhqrStore(req);
      const { order_id, pay_method, cash_received, cash_change } = req.body || {};
      if (!order_id) return res.status(400).json({ error: '缺少订单 ID' });

      const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [order_id, sid]);
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.status !== 'pending') return res.status(400).json({ error: '订单已结算或已取消' });

      const expireRow = await getAsync('SELECT value FROM settings WHERE `key`=?', ['store_' + sid + '_khqr_expire_minutes']);
      const expireMin = Math.max(1, Math.min(60, parseInt(expireRow ? expireRow.value : '10', 10) || 10));

      // 选择哪个收款码
      const list = await loadKhqrProviders(sid);
      const enabledList = list.filter(p => p.enabled);
      if (enabledList.length === 0) return res.status(400).json({ error: '未配置银行收款码，请先在系统设置中上传' });

      const providerId = (req.body && req.body.provider_id) || '';
      let provider;
      if (providerId) {
        provider = enabledList.find(p => p.id === providerId);
        if (!provider) return res.status(400).json({ error: '指定的收款码不存在或已禁用' });
      } else {
        provider = enabledList.find(p => p.isDefault) || enabledList[0];
      }
      const payloadRow = { value: provider.payload };
      const nameRow = { value: provider.merchantName };

      // 币种直接读 provider 存储时已解析好的字段，避免二次解析出错
      let staticCurrency = provider.currency;
      if (!staticCurrency) {
        // 兜底：重新解析
        const staticInfo = khqr.extractInfo(khqr.parseTLV(provider.payload));
        staticCurrency = staticInfo.currency === '840' ? 'USD' : (staticInfo.currency === '116' ? 'KHR' : 'USD');
      }
      console.log('[khqr/debug] 请求币种=', JSON.stringify(req.body && req.body.currency),
        '请求类型=', typeof (req.body && req.body.currency),
        'provider=', provider.id,
        'staticCurrency=', staticCurrency);

      const requestedCurrency = String((req.body && req.body.currency) || '').trim().toUpperCase();
      const targetCurrency = ['USD', 'KHR'].includes(requestedCurrency) ? requestedCurrency : staticCurrency;
      // 订单原始币种
      let orderCurrency = 'USD';
      try {
        const items = JSON.parse(order.items || '[]');
        if (items[0] && items[0].currency_code) orderCurrency = items[0].currency_code;
      } catch (e) {}

      // 换算：静态码币种 != 订单币种 时，按汇率转
      let finalAmount = Number(order.total);
      if (orderCurrency !== targetCurrency) {
        const rates = await allAsync('SELECT code, rate FROM currencies WHERE merchant_id=?', [req.merchantId || 1]);
        const rateMap = {};
        for (const r of rates) rateMap[r.code] = Number(r.rate) || 1;
        // rate = 该币兑 USD 汇率
        const usdRateOfOrder = rateMap[orderCurrency] || 1;
        const usdRateOfStatic = rateMap[targetCurrency] || 1;
        // 订单币种 → USD → 静态码币种
        const usdAmount = Number(order.total) / usdRateOfOrder;
        finalAmount = usdAmount * usdRateOfStatic;
      }

      const orderNo = order.order_no || ('#' + order.id);
      const dynamicPayload = khqr.buildDynamicPayload(payloadRow.value, finalAmount, targetCurrency, orderNo);
      const currency = targetCurrency;

      // 前端 <img> 带不了 token，直接返回 base64 dataURL
      const qrDataUrl = await QRCode.toDataURL(dynamicPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 240,
      });
      const expiresAt = new Date(Date.now() + expireMin * 60 * 1000).toISOString();

      // 保存到订单
      const qrUpdate = await runAsync("UPDATE orders SET pay_method=?, pay_khqr_ref=?, pay_expires_at=? WHERE id=? AND store_id=? AND status='pending'",
        ['khqr', dynamicPayload, expiresAt, order.id, sid]);
      if (!qrUpdate.affectedRows) return res.status(409).json({ error: '订单状态已变化，无法生成新的收款码' });
      res.json({
        qr_payload: dynamicPayload,
        qr_data_url: qrDataUrl,
        provider_id: provider.id,
        provider_label: provider.label,
        provider_bank: provider.bank,
        amount: Number(finalAmount.toFixed(2)),
        original_amount: Number(order.total),
        original_currency: orderCurrency,
        currency,
        merchant_name: nameRow ? nameRow.value : '',
        order_no: orderNo,
        expires_at: expiresAt,
        expire_minutes: expireMin,
      });
    } catch (e) {
      console.error('[khqr/generate]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /* ===== 到账确认 ===== */
  app.post('/api/cashier/khqr/confirm', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      if (req.isCashier && !req.cashier?.permissions?.can_settle) return res.status(403).json({ error: '没有确认收款权限' });
      if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_manage_order)) return res.status(403).json({ error: '没有订单收款权限' });
      if (req.isWaiter && !req.waiter?.can_order) return res.status(403).json({ error: '该服务员没有提交收款确认权限' });
      const { storeId: sid } = await resolveKhqrStore(req);
      const { order_id, pay_method, cash_received, cash_change } = req.body || {};
      if (!order_id) return res.status(400).json({ error: '缺少订单 ID' });

      const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [order_id, sid]);
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.status !== 'pending') return res.status(400).json({ error: '订单状态不允许确认' });
      if (!Number(order.awaiting_confirm) && !order.pay_khqr_ref) {
        return res.status(409).json({ error: '该订单尚未提交收款确认，也没有已生成的 KHQR 收款码' });
      }

      // 身份由服务端认证中间件决定，不能信任客户端传入的 role。
      if (req.waiter) {
        if (req.waiterStoreId !== sid && req.waiter.store_id !== sid) {
          return res.status(403).json({ error: '不能操作其他门店的订单' });
        }
        const result = await runAsync(
          "UPDATE orders SET awaiting_confirm=1, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=0",
          [String(pay_method || '').slice(0, 20), Math.max(0, Number(cash_received) || 0), Math.max(0, Number(cash_change) || 0), order_id, sid]
        );
        if (!result.affectedRows) return res.status(409).json({ error: '订单状态已变化，请刷新后重试' });
        return res.json({ success: true, status: 'awaiting_confirm' });
      }

      // 只有已认证的管理员/收银员可人工确认到账；更新必须绑定当前门店且保持待处理状态。
      const settledAt = new Date().toISOString();
      const result = await runAsync("UPDATE orders SET status='done', awaiting_confirm=0, pay_method='khqr', settled_at=?, paid_confirmed_by=? WHERE id=? AND store_id=? AND status='pending'",
        [settledAt, req.adminId || req.cashierId || 'unknown', order_id, sid]);
      if (!result.affectedRows) return res.status(409).json({ error: '订单状态已变化，请刷新后重试' });
      await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.isCashier ? 'cashier' : 'admin', req.adminId || req.cashierId || 0, req.isCashier ? (req.cashier?.username || 'cashier') : 'admin', 'khqr_confirm', JSON.stringify({ order_id }), req.ip || '', new Date().toISOString()]);
      res.json({ success: true, status: 'done' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });


  /* ===== 列出所有 KHQR provider ===== */
  app.get('/api/admin/khqr/providers', requireAdminKey, async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const list = await loadKhqrProviders(sid);
      res.json({ providers: list });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== 删除某个 provider ===== */
  app.delete('/api/admin/khqr/providers/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const id = req.params.id;
      const list = await loadKhqrProviders(sid);
      const idx = list.findIndex(p => p.id === id);
      if (idx < 0) return res.status(404).json({ error: '收款码不存在' });
      const removed = list.splice(idx, 1)[0];
      // 如果删掉的是默认且还有剩余，把第一个设为默认
      if (removed.isDefault && list.length > 0) list[0].isDefault = true;
      await saveKhqrProviders(sid, list);
      res.json({ success: true, remaining: list.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== 设为默认 ===== */
  app.post('/api/admin/khqr/providers/:id/default', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const id = req.params.id;
      const list = await loadKhqrProviders(sid);
      let found = false;
      for (const p of list) {
        if (p.id === id) { p.isDefault = true; found = true; }
        else p.isDefault = false;
      }
      if (!found) return res.status(404).json({ error: '收款码不存在' });
      await saveKhqrProviders(sid, list);
      res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== 启用/禁用 ===== */
  app.post('/api/admin/khqr/providers/:id/toggle', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const id = req.params.id;
      const list = await loadKhqrProviders(sid);
      const p = list.find(x => x.id === id);
      if (!p) return res.status(404).json({ error: '收款码不存在' });
      p.enabled = !p.enabled;
      await saveKhqrProviders(sid, list);
      res.json({ success: true, enabled: p.enabled });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== 二维码图片（PNG） ===== */
  app.get('/api/cashier/khqr/qrimage', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const { order_id, size } = req.query;
      if (!order_id) return res.status(400).json({ error: '缺少订单 ID' });

      const order = await getAsync('SELECT pay_khqr_ref FROM orders WHERE id=? AND store_id=?', [order_id, sid]);
      if (!order || !order.pay_khqr_ref) return res.status(404).json({ error: '未生成动态码' });

      const px = Math.max(120, Math.min(1024, parseInt(size, 10) || 240));
      const dataUrl = await QRCode.toDataURL(order.pay_khqr_ref, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: px,
      });
      const base64 = dataUrl.split(',')[1];
      const buf = Buffer.from(base64, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store, no-cache');
      res.send(buf);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== 服务员：通知收银员核实到账 ===== */
  app.post('/api/waiter/khqr/notify', requireAdminOrWaiter, async (req, res) => {
    try {
      const { order_id, pay_method, cash_received, cash_change } = req.body || {};
      if (!order_id) return res.status(400).json({ error: '缺少订单 ID' });

      let sid;
      let actorName = 'admin';
      if (req.isAdmin) {
        sid = req.storeId;
        actorName = 'admin';
      } else if (req.waiter) {
        sid = req.waiterStoreId || req.waiter.store_id;
        actorName = req.waiter.display_name || req.waiter.username || 'waiter';
      }
      if (!sid) return res.status(400).json({ error: '未指定店铺' });

      const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [order_id, sid]);
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.status !== 'pending') return res.status(400).json({ error: '订单状态不允许通知' });

      // 幂等：已通知过直接返回
      if (order.awaiting_confirm) {
        return res.json({ success: true, status: 'awaiting_confirm', already: true });
      }

      await runAsync(
        'UPDATE orders SET awaiting_confirm=1, pay_method=?, cash_received=?, cash_change=? WHERE id=?',
        [String(pay_method || '').slice(0, 20), Number(cash_received) || 0, Number(cash_change) || 0, order_id]
      );

      // 广播给收银台
      io.to('cashier-' + sid).emit('khqr:awaiting', {
        orderId: order.id,
        table: order.table_name,
        orderNo: order.order_no,
        total: order.total,
        storeId: sid,
      });

      // 审计日志
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.isAdmin ? 'admin' : 'waiter',
         req.isAdmin ? (req.adminId || 0) : (req.waiter ? req.waiter.id : 0),
         actorName, 'khqr_notify_awaiting',
         JSON.stringify({ order_id: order.id, table: order.table_name }),
         getClientIp(req), new Date().toISOString()]
      );

      res.json({ success: true, status: 'awaiting_confirm' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ===== 取消/退回待确认 ===== */
  app.post('/api/cashier/khqr/cancel', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const { order_id } = req.body || {};
      if (!order_id) return res.status(400).json({ error: '缺少订单 ID' });
      const result = await runAsync("UPDATE orders SET awaiting_confirm=0, pay_khqr_ref='', pay_expires_at='' WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=1",
        [order_id, sid]);
      if (!result.affectedRows) return res.status(409).json({ error: '订单不存在或当前状态不允许取消待确认' });
      res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

};
