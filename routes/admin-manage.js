/* ============================================================
   routes/admin-manage.js — 全局配置 + 催单 + 管理员/收银员 CRUD + 重置
   ============================================================ */
const crypto = require('crypto');
const { hashSessionToken } = require('../server/services/session-token');
const QRCode = require('qrcode');
const { parsePositiveRouteId } = require('../server/services/route-id');

function normalizeAdminFlag(value, fallback, field) {
  if (value === undefined) return fallback;
  if ([true, 1, '1'].includes(value)) return 1;
  if ([false, 0, '0'].includes(value)) return 0;
  throw Object.assign(new Error(field + ' 参数无效'), { status: 400 });
}

function parsePositiveOrderId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function toMoneyCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function convertUsdCentsToKhr(usdCents, rateValue) {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0) return null;
  const rawRate = String(rateValue ?? '').trim();
  if (!/^\d+(?:\.\d{1,10})?$/.test(rawRate)) return null;
  const [whole, fraction = ''] = rawRate.split('.');
  const rateScaled = BigInt(whole) * 10000000000n + BigInt((fraction + '0000000000').slice(0, 10));
  if (rateScaled <= 0n) return null;
  // USD cents / 100 * KHR per USD; round once to the whole-riel amount required by KHQR.
  const khr = (BigInt(usdCents) * rateScaled + 500000000000n) / 1000000000000n;
  if (khr <= 0n || khr > 999999999n) return null;
  return Number(khr);
}

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, withTransaction, syncTableStatus, requireAdminKey, requirePermission, requireAdminOrCashier, requireAdminOrCashierOrWaiter, requireAdminOrWaiter, hashPassword, verifyPassword, logAudit, getClientIp, io } = deps;

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
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

  // ----- 催单（需要 session 校验 + 限流）-----
  app.post('/api/orders/:id(\\d+)/urge', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const sessionToken = typeof req.body?.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
      const customerToken = typeof req.body?.customerToken === 'string' ? req.body.customerToken.trim() : '';
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: '订单编号无效' });
      if (!sessionToken || sessionToken.length > 256 || !customerToken || customerToken.length > 128) {
        return res.status(401).json({ error: '顾客会话已失效，请重新扫码后再催单' });
      }

      const initialSession = await getAsync(
        'SELECT table_name, store_id, expires_at FROM scan_sessions WHERE token_hash=?',
        [hashSessionToken(sessionToken)]
      );
      if (!initialSession) return res.status(401).json({ error: '扫码会话不存在，请重新扫码' });
      const initialExpiry = new Date(initialSession.expires_at).getTime();
      if (!Number.isFinite(initialExpiry) || initialExpiry <= Date.now()) {
        return res.status(410).json({ error: '二维码已过期，请重新扫码' });
      }

      const result = await withTransaction(async () => {
        // Lock table -> session -> order; this matches order creation and table operations.
        const tableRow = await getAsync(
          'SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE',
          [initialSession.table_name, initialSession.store_id]
        );
        if (!tableRow) throw Object.assign(new Error('桌台已变化，请重新扫码'), { status: 409 });
        const activeStore = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
          [initialSession.store_id]
        );
        if (!activeStore) throw Object.assign(new Error('店铺已停用，暂时无法催单'), { status: 404 });

        const session = await getAsync(
          'SELECT table_name, store_id, expires_at FROM scan_sessions WHERE token_hash=? FOR UPDATE',
          [hashSessionToken(sessionToken)]
        );
        if (!session) throw Object.assign(new Error('扫码会话已失效，请重新扫码'), { status: 401 });
        const expiresAt = new Date(session.expires_at).getTime();
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          throw Object.assign(new Error('二维码已过期，请重新扫码'), { status: 410 });
        }
        if (session.table_name !== initialSession.table_name ||
            Number(session.store_id) !== Number(initialSession.store_id)) {
          throw Object.assign(new Error('扫码桌台已变化，请重新扫码'), { status: 409 });
        }

        const order = await getAsync(
          'SELECT * FROM orders WHERE id=? AND store_id=? AND table_name=? AND session_token=? AND customer_token=? FOR UPDATE',
          [id, session.store_id, session.table_name, hashSessionToken(sessionToken), hashSessionToken(customerToken)]
        );
        if (!order) throw Object.assign(new Error('订单不存在或已转移'), { status: 404 });
        if (order.status !== 'pending') throw Object.assign(new Error('订单已完成或已取消'), { status: 400 });

        const URGE_COOLDOWN_MS = 5 * 60 * 1000;
        const recent = await getAsync(
          "SELECT created_at FROM waiter_calls WHERE table_name=? AND store_id=? AND type='urge' AND message LIKE ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [order.table_name, order.store_id, `%#${id} %`]
        );
        if (recent) {
          const elapsed = Date.now() - new Date(recent.created_at).getTime();
          if (!Number.isFinite(elapsed) || elapsed < URGE_COOLDOWN_MS) {
            const remaining = Number.isFinite(elapsed)
              ? Math.max(1, Math.ceil((URGE_COOLDOWN_MS - elapsed) / 60000))
              : 5;
            return { limited: true, remaining };
          }
        }

        const callId = crypto.randomBytes(16).toString('hex');
        await runAsync(
          'INSERT INTO waiter_calls (id, table_name, type, message, status, store_id, created_at, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
          [callId, order.table_name, 'urge', `订单 #${id} 顾客催单`, 'pending', order.store_id || 1, new Date().toISOString(), order.store_id || 1]
        );
        return { limited: false, callId, storeId: order.store_id || 1, tableName: order.table_name };
      });

      if (result.limited) {
        return res.status(429).json({ error: `已催单，请${result.remaining}分钟后再试`, cooldownMinutes: result.remaining });
      }
      io.to('kitchen-' + result.storeId).emit('order:urge', { orderId: id, table: result.tableName });
      io.to('waiter-' + result.storeId).emit('order:urge', { orderId: id, table: result.tableName });
      res.json({ success: true, message: '已通知后厨，请稍候' });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : '催单失败' });
    }
  });

  // ----- 商户管理员管理 -----
  app.get('/api/admin/admins', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const rows = await allAsync('SELECT id, username, display_name, active, last_login_at, created_at, (id = (SELECT MIN(id) FROM merchant_admins ma2 WHERE ma2.merchant_id = merchant_admins.merchant_id)) AS is_primary, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier, can_manage_financial_reconciliation FROM merchant_admins WHERE merchant_id=? ORDER BY id', [req.merchantId]);
      res.json(rows);
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

  app.post('/api/admin/admins', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0) return res.status(403).json({ error: '商户信息无效' });
      if (!username || username.length > 50 || !displayName || displayName.length > 100) {
        return res.status(400).json({ error: '管理员账号和姓名必填，账号最多 50 个字符，姓名最多 100 个字符' });
      }
      if (password.length < 12 || password.length > 128) return res.status(400).json({ error: '管理员密码长度必须为 12 至 128 个字符' });
      if (body.permissions !== undefined && (!body.permissions || typeof body.permissions !== 'object' || Array.isArray(body.permissions))) {
        return res.status(400).json({ error: '管理员权限配置格式无效' });
      }

      const permFields = ['can_manage_menu','can_manage_table','can_manage_order','can_delete_order','can_edit_order','can_manage_store','can_manage_waiter','can_manage_currency','can_manage_printer','can_manage_admin','can_view_logs','can_manage_cashier','can_manage_financial_reconciliation'];
      const active = normalizeAdminFlag(body.active, 1, 'active');
      const permVals = permFields.map(field => normalizeAdminFlag(body.permissions?.[field], 0, field));
      let adminId;
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const exists = await getAsync('SELECT id FROM merchant_admins WHERE username=?', [username]);
        if (exists) throw Object.assign(new Error('用户名已存在'), { status: 409 });
        const result = await runAsync(
          'INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name, active, ' + permFields.join(', ') + ') VALUES (?, ?, ?, ?, ?, ' + permFields.map(() => '?').join(',') + ')',
          [merchantId, username, hashPassword(password), displayName, active, ...permVals]
        );
        adminId = result.lastID;
        const actor = req.adminId ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId]) : null;
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['merchant_admin', req.adminId || null, actor?.username || '', 'create_admin', 'merchant_admin', adminId,
            JSON.stringify({ username, display_name: displayName, active }), getClientIp(req), new Date().toISOString()]
        );
      });
      res.status(201).json(await getAsync(
        'SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier, can_manage_financial_reconciliation FROM merchant_admins WHERE id=? AND merchant_id=?',
        [adminId, merchantId]
      ));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' || e.status === 409) return res.status(409).json({ error: '用户名已存在' });
      res.status(e.status || 500).json({ error: e.status ? e.message : '创建管理员失败，所有更改已回滚' });
    }
  });

  app.put('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
      const merchantId = Number(req.merchantId);
      const body = req.body || {};
      if (id === null || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '管理员或商户编号无效' });
      }
      if (body.display_name !== undefined && (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.trim().length > 100)) {
        return res.status(400).json({ error: '管理员姓名必须为 1 至 100 个字符' });
      }
      if (body.password !== undefined && body.password !== '' &&
          (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128)) {
        return res.status(400).json({ error: '管理员密码长度必须为 12 至 128 个字符' });
      }
      if (body.permissions !== undefined && (!body.permissions || typeof body.permissions !== 'object' || Array.isArray(body.permissions))) {
        return res.status(400).json({ error: '管理员权限配置格式无效' });
      }
      const permFields = ['can_manage_menu', 'can_manage_table', 'can_manage_order', 'can_delete_order', 'can_edit_order', 'can_manage_store', 'can_manage_waiter', 'can_manage_currency', 'can_manage_printer', 'can_manage_admin', 'can_view_logs', 'can_manage_cashier', 'can_manage_financial_reconciliation'];
      let updatedAdmin;
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
        if (!admin) throw Object.assign(new Error('管理员不存在'), { status: 404 });
        const primary = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [merchantId]);
        if (Number(primary?.min_id) === id) throw Object.assign(new Error('主管理员拥有全部权限，不可修改权限和状态'), { status: 400 });

        const active = normalizeAdminFlag(body.active, Number(admin.active), 'active');
        if (id === Number(req.adminId) && active === 0) throw Object.assign(new Error('不能禁用当前登录账号'), { status: 400 });
        const assignments = [];
        const changedFields = [];
        const values = [];
        if (body.display_name !== undefined) { assignments.push('display_name=?'); changedFields.push('display_name'); values.push(body.display_name.trim()); }
        if (body.active !== undefined) { assignments.push('active=?'); changedFields.push('active'); values.push(active); }
        const passwordChanged = typeof body.password === 'string' && body.password.length > 0;
        if (passwordChanged) { assignments.push('password_hash=?'); changedFields.push('password_hash'); values.push(hashPassword(body.password)); }
        let permissionsChanged = false;
        if (body.permissions !== undefined) {
          for (const field of permFields) {
            if (body.permissions[field] !== undefined) {
              const value = normalizeAdminFlag(body.permissions[field], Number(admin[field]), field);
              if (value !== Number(admin[field])) permissionsChanged = true;
              assignments.push(field + '=?');
              changedFields.push(field);
              values.push(value);
            }
          }
        }
        if (assignments.length) {
          values.push(id, merchantId);
          await runAsync('UPDATE merchant_admins SET ' + assignments.join(',') + ' WHERE id=? AND merchant_id=?', values);
        }
        if (passwordChanged || (body.active !== undefined && active !== Number(admin.active)) || permissionsChanged) {
          await runAsync('DELETE FROM admin_sessions WHERE admin_id=?', [id]);
        }
        const actor = req.adminId ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId]) : null;
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['merchant_admin', req.adminId || null, actor?.username || '', 'update_admin', 'merchant_admin', id,
            JSON.stringify({ username: admin.username, changed_fields: changedFields }),
            getClientIp(req), new Date().toISOString()]
        );
        updatedAdmin = await getAsync(
          'SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs, can_manage_cashier, can_manage_financial_reconciliation FROM merchant_admins WHERE id=? AND merchant_id=?',
          [id, merchantId]
        );
      });
      res.json(updatedAdmin);
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '更新管理员失败，所有更改已回滚' }); }
  });

  app.delete('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '管理员或商户编号无效' });
      }
      if (id === Number(req.adminId)) return res.status(400).json({ error: '不能删除当前登录账号' });
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const admin = await getAsync('SELECT id, username FROM merchant_admins WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
        if (!admin) throw Object.assign(new Error('管理员不存在'), { status: 404 });
        const primary = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [merchantId]);
        if (Number(primary?.min_id) === id) throw Object.assign(new Error('主管理员不可删除'), { status: 400 });
        await runAsync('DELETE FROM admin_sessions WHERE admin_id=?', [id]);
        await runAsync('DELETE FROM merchant_admins WHERE id=? AND merchant_id=?', [id, merchantId]);
        const actor = req.adminId ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId]) : null;
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['merchant_admin', req.adminId || null, actor?.username || '', 'delete_admin', 'merchant_admin', id,
            JSON.stringify({ username: admin.username }), getClientIp(req), new Date().toISOString()]
        );
      });
      res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '删除管理员失败，所有更改已回滚' }); }
  });

  // ----- 收银员管理（按商户聚合，跨店铺）-----
  async function getCashiers(storeId, forUpdate = false) {
    const row = await getAsync(
      "SELECT value FROM settings WHERE `key` = ?" + (forUpdate ? ' FOR UPDATE' : ''),
      ['cashiers_' + storeId]
    );
    if (!row || !row.value) return [];
    let parsed;
    try { parsed = JSON.parse(row.value); }
    catch (_) { throw Object.assign(new Error('门店收银员数据损坏，已停止写入以防止覆盖原始数据'), { status: 500 }); }
    if (!Array.isArray(parsed)) throw Object.assign(new Error('门店收银员数据格式无效，已停止写入'), { status: 500 });
    return parsed;
  }

  async function saveCashiers(storeId, cashiers) {
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      ['cashiers_' + storeId, JSON.stringify(cashiers)]
    );
  }

  async function getAllCashiersByMerchant(merchantId, forUpdate = false) {
    const stores = await allAsync(
      'SELECT id, name FROM stores WHERE merchant_id=? ORDER BY id' + (forUpdate ? ' FOR UPDATE' : ''),
      [merchantId]
    );
    const result = [];
    for (const store of stores) {
      const list = await getCashiers(store.id, forUpdate);
      for (const cashier of list) {
        result.push({
          id: cashier.id, username: cashier.username, display_name: cashier.display_name,
          active: cashier.active, permissions: cashier.permissions, created_at: cashier.created_at,
          store_id: store.id, store_name: store.name
        });
      }
    }
    return result;
  }

  async function findCashierStore(merchantId, cashierId, forUpdate = false) {
    const stores = await allAsync(
      'SELECT id, name FROM stores WHERE merchant_id=? ORDER BY id' + (forUpdate ? ' FOR UPDATE' : ''),
      [merchantId]
    );
    for (const store of stores) {
      const list = await getCashiers(store.id, forUpdate);
      const idx = list.findIndex(cashier => String(cashier.id) === String(cashierId));
      if (idx !== -1) return { store, list, idx };
    }
    return null;
  }

  async function writeCashierAudit(req, action, cashierId, details) {
    const actor = req.adminId
      ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, req.merchantId])
      : null;
    await runAsync(
      'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['merchant_admin', req.adminId || null, actor?.username || '', action, 'cashier', cashierId,
        JSON.stringify(details), getClientIp(req), new Date().toISOString()]
    );
  }

  function normalizeCashierPermissions(input, current = {}) {
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
      throw Object.assign(new Error('收银员权限配置格式无效'), { status: 400 });
    }
    const permissions = {};
    for (const [field, fallback] of [
      ['can_settle', true], ['can_cancel', true], ['can_refund', false], ['can_view_report', true]
    ]) {
      permissions[field] = normalizeAdminFlag(input?.[field], current[field] === undefined ? (fallback ? 1 : 0) : (current[field] ? 1 : 0), field) === 1;
    }
    return permissions;
  }

  app.get('/api/admin/cashiers', requireAdminKey, requirePermission('can_manage_cashier'), async (req, res) => {
    try {
      const list = await getAllCashiersByMerchant(req.merchantId);
      res.json({ cashiers: list });
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

  app.post('/api/admin/cashiers', requireAdminKey, requirePermission('can_manage_cashier'), async (req, res) => {
    try {
      const body = req.body || {};
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
      const merchantId = Number(req.merchantId);
      const targetStoreId = parsePositiveRouteId(body.store_id === undefined ? req.storeId : body.store_id);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || targetStoreId === null) {
        return res.status(400).json({ error: '商户或门店编号无效' });
      }
      if (!username || username.length > 50 || !displayName || displayName.length > 100) {
        return res.status(400).json({ error: '收银员账号和姓名必填，账号最多 50 个字符，姓名最多 100 个字符' });
      }
      if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '密码长度必须为 6 至 128 个字符' });
      const active = normalizeAdminFlag(body.active, 1, 'active') === 1;
      const permissions = normalizeCashierPermissions(body.permissions);
      let newCashier;
      let storeName = '';
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const store = await getAsync('SELECT id, name FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [targetStoreId, merchantId]);
        if (!store) throw Object.assign(new Error('目标店铺不存在或已停用'), { status: 400 });
        const all = await getAllCashiersByMerchant(merchantId, true);
        if (all.some(cashier => cashier.username === username)) {
          throw Object.assign(new Error('该商户下已存在同名收银员账号'), { status: 409 });
        }
        const dupWaiter = await getAsync('SELECT id FROM waiters WHERE username=? LIMIT 1', [username]);
        if (dupWaiter) throw Object.assign(new Error('该用户名已被服务员账号使用，请换一个'), { status: 409 });

        const cashiers = await getCashiers(targetStoreId, true);
        newCashier = {
          id: crypto.randomBytes(6).readUIntBE(0, 6) || 1,
          username,
          display_name: displayName,
          password_hash: hashPassword(password),
          active,
          permissions,
          created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
        };
        cashiers.push(newCashier);
        await saveCashiers(targetStoreId, cashiers);
        storeName = store.name;
        await writeCashierAudit(req, 'create_cashier', newCashier.id, {
          username, display_name: displayName, store_id: targetStoreId, active, permissions
        });
      });
      res.status(201).json({
        success: true,
        cashier: { id: newCashier.id, username: newCashier.username, display_name: newCashier.display_name,
          active: newCashier.active, permissions: newCashier.permissions, created_at: newCashier.created_at,
          store_id: targetStoreId, store_name: storeName }
      });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' || e.status === 409) return res.status(409).json({ error: e.status ? e.message : '收银员账号已存在' });
      res.status(e.status || 500).json({ error: e.status ? e.message : '创建收银员失败，所有更改已回滚' });
    }
  });

  app.put('/api/admin/cashiers/:id', requireAdminKey, requirePermission('can_manage_cashier'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
      const merchantId = Number(req.merchantId);
      const body = req.body || {};
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '收银员或商户编号无效' });
      }
      if (body.display_name !== undefined && (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.trim().length > 100)) {
        return res.status(400).json({ error: '收银员姓名必须为 1 至 100 个字符' });
      }
      if (body.password !== undefined && body.password !== '' &&
          (typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 128)) {
        return res.status(400).json({ error: '密码长度必须为 6 至 128 个字符' });
      }
      const requestedTargetStoreId = body.store_id === undefined ? null : parsePositiveRouteId(body.store_id);
      if (body.store_id !== undefined && requestedTargetStoreId === null) {
        return res.status(400).json({ error: '目标门店编号无效' });
      }
      let updatedCashier;
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const found = await findCashierStore(merchantId, id, true);
        if (!found) throw Object.assign(new Error('收银员不存在'), { status: 404 });
        const { store: oldStore, list: oldList, idx } = found;
        const cashier = { ...oldList[idx], permissions: { ...(oldList[idx].permissions || {}) } };
        const targetStoreId = requestedTargetStoreId === null ? parsePositiveRouteId(oldStore.id) : requestedTargetStoreId;
        if (targetStoreId === null) throw Object.assign(new Error('目标门店编号无效'), { status: 400 });
        const storeChanged = targetStoreId !== Number(oldStore.id);
        const newStore = storeChanged
          ? await getAsync('SELECT id, name FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [targetStoreId, merchantId])
          : oldStore;
        if (!newStore) throw Object.assign(new Error('目标店铺不存在或已停用'), { status: 400 });

        const previousActive = normalizeAdminFlag(cashier.active, 1, 'active') === 1;
        const active = normalizeAdminFlag(body.active, previousActive ? 1 : 0, 'active') === 1;
        const previousPermissions = normalizeCashierPermissions(undefined, cashier.permissions);
        const permissions = normalizeCashierPermissions(body.permissions, cashier.permissions);
        const passwordChanged = typeof body.password === 'string' && body.password.length > 0;
        const permissionsChanged = Object.keys(permissions).some(field => permissions[field] !== previousPermissions[field]);
        const accessChanged = passwordChanged || active !== previousActive || permissionsChanged || storeChanged;
        if (body.display_name !== undefined) cashier.display_name = body.display_name.trim();
        cashier.active = active;
        cashier.permissions = permissions;
        if (passwordChanged) cashier.password_hash = hashPassword(body.password);

        if (storeChanged) {
          oldList.splice(idx, 1);
          await saveCashiers(oldStore.id, oldList);
          const targetList = await getCashiers(newStore.id, true);
          if (targetList.some(item => item.username === cashier.username)) {
            throw Object.assign(new Error('目标店铺已存在同名收银员'), { status: 409 });
          }
          targetList.push(cashier);
          await saveCashiers(newStore.id, targetList);
        } else {
          oldList[idx] = cashier;
          await saveCashiers(oldStore.id, oldList);
        }
        if (accessChanged) {
          await runAsync('DELETE FROM cashier_sessions WHERE cashier_id=? AND merchant_id=?', [id, merchantId]);
        }
        await writeCashierAudit(req, 'update_cashier', id, {
          username: cashier.username, old_store_id: oldStore.id, new_store_id: newStore.id,
          active, permissions, password_changed: passwordChanged
        });
        updatedCashier = {
          id: cashier.id, username: cashier.username, display_name: cashier.display_name,
          active: cashier.active, permissions: cashier.permissions, created_at: cashier.created_at,
          store_id: newStore.id, store_name: newStore.name
        };
      });
      res.json({ success: true, cashier: updatedCashier });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY' || e.status === 409) return res.status(409).json({ error: e.status ? e.message : '收银员账号已存在' });
      res.status(e.status || 500).json({ error: e.status ? e.message : '更新收银员失败，所有更改已回滚' });
    }
  });

  app.delete('/api/admin/cashiers/:id', requireAdminKey, requirePermission('can_manage_cashier'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '收银员或商户编号无效' });
      }
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const found = await findCashierStore(merchantId, id, true);
        if (!found) throw Object.assign(new Error('收银员不存在'), { status: 404 });
        const { store, list, idx } = found;
        const cashier = list[idx];
        await runAsync('DELETE FROM cashier_sessions WHERE cashier_id=? AND merchant_id=?', [id, merchantId]);
        list.splice(idx, 1);
        await saveCashiers(store.id, list);
        await writeCashierAudit(req, 'delete_cashier', id, { username: cashier.username, store_id: store.id });
      });
      res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '删除收银员失败，所有更改已回滚' }); }
  });

  app.post('/api/admin/reset-data', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!password || password.length > 128) return res.status(400).json({ error: '请输入有效的管理员密码' });
      const merchantId = Number(req.merchantId);
      const adminId = Number(req.adminId);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || !Number.isSafeInteger(adminId) || adminId <= 0) {
        return res.status(400).json({ error: '商户或管理员信息无效' });
      }

      const resetResult = await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const admin = await getAsync(
          'SELECT id, username, password_hash FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE',
          [adminId, merchantId]
        );
        if (!admin || !verifyPassword(password, admin.password_hash)) {
          throw Object.assign(new Error('密码错误，重置失败'), { status: 401 });
        }

        await runAsync('DELETE FROM refund_requests WHERE store_id IN (SELECT id FROM stores WHERE merchant_id=?)', [merchantId]);
        const deletedOrders = await runAsync('DELETE FROM orders WHERE merchant_id=?', [merchantId]);
        const deletedWaiterCalls = await runAsync('DELETE FROM waiter_calls WHERE merchant_id=?', [merchantId]);
        const deletedScanSessions = await runAsync('DELETE FROM scan_sessions WHERE merchant_id=?', [merchantId]);
        const deletedReservations = await runAsync('DELETE FROM reservations WHERE merchant_id=?', [merchantId]);
        await runAsync("UPDATE tables SET status='available' WHERE merchant_id=?", [merchantId]);
        await runAsync('UPDATE menus SET sales_count=0 WHERE merchant_id=?', [merchantId]);
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['merchant_admin', adminId, admin.username, 'reset_merchant_data', 'merchant', merchantId,
            JSON.stringify({
              deletedOrders: deletedOrders.affectedRows || 0,
              deletedWaiterCalls: deletedWaiterCalls.affectedRows || 0,
              deletedScanSessions: deletedScanSessions.affectedRows || 0,
              deletedReservations: deletedReservations.affectedRows || 0
            }), getClientIp(req), new Date().toISOString()]
        );
        return deletedOrders.affectedRows || 0;
      });
      res.json({ success: true, deletedOrders: resetResult, message: '订单数据已重置' });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : '重置订单数据失败，所有更改已回滚' });
    }
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
  app.get('/api/admin/khqr/info', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
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
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

  /* ===== 生成动态码 ===== */
  app.post('/api/cashier/khqr/generate', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      if (req.isCashier && !req.cashier?.permissions?.can_settle) return res.status(403).json({ error: '没有生成收款码权限' });
      if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_manage_order)) return res.status(403).json({ error: '没有订单收款权限' });
      if (req.isWaiter && !req.waiter?.can_order) return res.status(403).json({ error: '该服务员没有下单权限' });
      const { order_id } = req.body || {};
      const orderId = parsePositiveOrderId(order_id);
      if (orderId === null) return res.status(400).json({ error: '订单编号无效' });
      const { storeId: sid } = await resolveKhqrStore(req);

      const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [orderId, sid]);
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
      // orders.total is normalized to the merchant's USD base currency when the
      // order is created (each item's base_price is price / its menu currency rate).
      // Never infer the order-total currency from items[0].currency_code: that is
      // the menu's display currency, not the persisted order total currency.
      const baseUsdCents = toMoneyCents(order.total);
      if (baseUsdCents === null || baseUsdCents <= 0) {
        return res.status(400).json({ error: '订单金额无效，无法生成收款码' });
      }
      const baseUsdAmount = baseUsdCents / 100;

      let finalAmount = baseUsdAmount;
      if (targetCurrency === 'KHR') {
        const merchantId = Number(req.merchantId);
        if (!Number.isSafeInteger(merchantId) || merchantId <= 0) {
          return res.status(403).json({ error: '商户信息无效，无法计算收款金额' });
        }
        const rates = await allAsync('SELECT code, rate FROM currencies WHERE merchant_id=?', [merchantId]);
        const khrRateRow = rates.find(row => String(row.code).toUpperCase() === 'KHR');
        const khrRate = Number(khrRateRow && khrRateRow.rate);
        if (!Number.isFinite(khrRate) || khrRate <= 0) {
          return res.status(409).json({ error: '当前商户的 KHR 汇率缺失或无效，请先检查货币设置' });
        }
        finalAmount = convertUsdCentsToKhr(baseUsdCents, khrRate);
        if (finalAmount === null) {
          return res.status(409).json({ error: 'KHR 汇率精度或换算金额无效，请检查货币设置' });
        }
      }
      if (!Number.isFinite(finalAmount) || finalAmount <= 0 || finalAmount > 999999999 ||
          (targetCurrency === 'KHR' && !Number.isSafeInteger(finalAmount))) {
        return res.status(400).json({ error: '换算后的收款金额无效或超出允许范围' });
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
      const qrGenerationId = crypto.randomBytes(24).toString('hex');

      // Serialize QR generation on the order row. Without this lock, two concurrent
      // requests can each return a different valid QR while only the last payload is
      // persisted, making a payment to the first QR impossible to reconcile.
      await withTransaction(async () => {
        const lockedOrder = await getAsync(
          'SELECT status, total, awaiting_confirm, pay_khqr_ref, pay_expires_at, pay_qr_generation_id FROM orders WHERE id=? AND store_id=? FOR UPDATE',
          [order.id, sid]
        );
        const lockedTotalCents = lockedOrder ? toMoneyCents(lockedOrder.total) : null;
        if (!lockedOrder || lockedOrder.status !== 'pending' ||
            lockedTotalCents === null || lockedTotalCents !== baseUsdCents) {
          const error = new Error('订单状态或金额已变化，无法生成收款码');
          error.status = 409;
          throw error;
        }
        if (Number(lockedOrder.awaiting_confirm)) {
          const error = new Error('该订单已提交收款确认，请先处理当前确认请求');
          error.status = 409;
          throw error;
        }
        if (lockedOrder.pay_khqr_ref) {
          const existingExpiry = Date.parse(lockedOrder.pay_expires_at || '');
          // Treat an unknown expiry as active: replacing a QR whose validity cannot
          // be established could orphan a payment already made by the customer.
          if (!Number.isFinite(existingExpiry) || existingExpiry > Date.now()) {
            const error = new Error('该订单已有有效收款码，请先取消或等待收款码过期');
            error.status = 409;
            throw error;
          }
        }
        const qrUpdate = await runAsync(
          "UPDATE orders SET pay_method=?, pay_khqr_ref=?, pay_expires_at=?, pay_qr_generation_id=? WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=0",
          ['khqr', dynamicPayload, expiresAt, qrGenerationId, order.id, sid]
        );
        if (!qrUpdate.affectedRows) {
          const error = new Error('订单状态已变化，无法生成新的收款码');
          error.status = 409;
          throw error;
        }
      });
      res.json({
        qr_payload: dynamicPayload,
        qr_generation_id: qrGenerationId,
        qr_data_url: qrDataUrl,
        provider_id: provider.id,
        provider_label: provider.label,
        provider_bank: provider.bank,
        amount: finalAmount,
        original_amount: baseUsdAmount,
        original_currency: 'USD',
        currency,
        merchant_name: nameRow ? nameRow.value : '',
        order_no: orderNo,
        expires_at: expiresAt,
        expire_minutes: expireMin,
      });
    } catch (e) {
      console.error('[khqr/generate]', e);
      const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message });
    }
  });

  /* ===== 到账确认 ===== */
  app.post('/api/cashier/khqr/confirm', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      if (req.isCashier && !req.cashier?.permissions?.can_settle) return res.status(403).json({ error: '没有确认收款权限' });
      if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_manage_order)) return res.status(403).json({ error: '没有订单收款权限' });
      if (req.isWaiter && !req.waiter?.can_order) return res.status(403).json({ error: '该服务员没有提交收款确认权限' });
      const { order_id, pay_method, cash_received, cash_change, expected_qr_generation_id: expectedQrGenerationId } = req.body || {};
      const orderId = parsePositiveOrderId(order_id);
      if (orderId === null) return res.status(400).json({ error: '订单编号无效' });
      if (expectedQrGenerationId !== undefined && (typeof expectedQrGenerationId !== 'string' || !/^[a-f0-9]{48,64}$/.test(expectedQrGenerationId))) {
        return res.status(400).json({ error: '二维码生成标识无效' });
      }
      const { storeId: sid } = await resolveKhqrStore(req);

      const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [orderId, sid]);
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.status !== 'pending') return res.status(400).json({ error: '订单状态不允许确认' });
      if (!Number(order.awaiting_confirm) && !order.pay_khqr_ref) {
        return res.status(409).json({ error: '该订单尚未提交收款确认，也没有已生成的 KHQR 收款码' });
      }

      // A waiter may request cashier confirmation, but must not settle the order.
      // Keep the legacy endpoint consistent with /api/waiter/khqr/notify:
      // state and audit are atomic, retries are idempotent, and broadcast follows commit.
      if (req.waiter) {
        if (req.waiterStoreId !== sid && req.waiter.store_id !== sid) {
          return res.status(403).json({ error: '不能操作其他门店的订单' });
        }
        const paymentMethod = typeof pay_method === 'string' && pay_method.trim()
          ? pay_method.trim().slice(0, 40)
          : String(order.pay_method || 'khqr').trim().slice(0, 40);
        const receivedCents = cash_received === undefined ? null : toMoneyCents(cash_received);
        const changeCents = cash_change === undefined ? null : toMoneyCents(cash_change);
        if ((cash_received !== undefined && (receivedCents === null || receivedCents < 0)) ||
            (cash_change !== undefined && (changeCents === null || changeCents < 0))) {
          return res.status(400).json({ error: '收款金额或找零金额无效，最多只能有两位小数' });
        }
        const received = receivedCents === null ? 0 : receivedCents / 100;
        const change = changeCents === null ? 0 : changeCents / 100;

        let alreadyNotified = false;
        let notification = null;
        await withTransaction(async () => {
          const lockedOrder = await getAsync(
            'SELECT id, status, awaiting_confirm, pay_khqr_ref, pay_qr_generation_id, table_name, order_no, total FROM orders WHERE id=? AND store_id=? FOR UPDATE',
            [orderId, sid]
          );
          if (Boolean(lockedOrder?.pay_khqr_ref) !== Boolean(expectedQrGenerationId) ||
              (expectedQrGenerationId && lockedOrder?.pay_qr_generation_id !== expectedQrGenerationId)) {
            const error = new Error('二维码已变化或已失效，请刷新后重新确认');
            error.status = 409;
            throw error;
          }
          if (!lockedOrder || lockedOrder.status !== 'pending' ||
              (!Number(lockedOrder.awaiting_confirm) && !lockedOrder.pay_khqr_ref)) {
            const error = new Error('订单状态已变化或没有可确认的 KHQR 收款码');
            error.status = 409;
            throw error;
          }
          if (Number(lockedOrder.awaiting_confirm)) {
            alreadyNotified = true;
            return;
          }
          const result = await runAsync(
            "UPDATE orders SET awaiting_confirm=1, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=0",
            [paymentMethod, Number.isFinite(received) ? received : 0, Number.isFinite(change) ? change : 0, orderId, sid]
          );
          if (!result.affectedRows) {
            const error = new Error('订单状态已变化，请刷新后重试');
            error.status = 409;
            throw error;
          }
          await runAsync(
            'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['waiter', req.waiter.id || 0, req.waiter.display_name || req.waiter.username || 'waiter',
             'khqr_notify_awaiting', JSON.stringify({ order_id: orderId, table: lockedOrder.table_name }),
             getClientIp(req), new Date().toISOString()]
          );
          notification = {
            orderId: lockedOrder.id,
            table: lockedOrder.table_name,
            orderNo: lockedOrder.order_no,
            total: lockedOrder.total,
            storeId: sid
          };
        });
        if (notification) io.to('cashier-' + sid).emit('khqr:awaiting', notification);
        return res.json({ success: true, status: 'awaiting_confirm', ...(alreadyNotified ? { already: true } : {}) });
      }

      // 只有已认证的管理员/收银员可人工确认到账；表行先锁定，再锁订单，避免与转桌/改桌死锁。
      const settledAt = new Date().toISOString();
      await withTransaction(async () => {
        const lockedTable = await getAsync(
          'SELECT id FROM tables WHERE name=? AND store_id=? FOR UPDATE',
          [order.table_name, sid]
        );
        if (!lockedTable) {
          const error = new Error('订单关联桌台已变化，请刷新后重试');
          error.status = 409;
          throw error;
        }
        const lockedOrder = await getAsync(
          'SELECT * FROM orders WHERE id=? AND store_id=? FOR UPDATE',
          [orderId, sid]
        );
        if (Boolean(lockedOrder?.pay_khqr_ref) !== Boolean(expectedQrGenerationId) ||
              (expectedQrGenerationId && lockedOrder?.pay_qr_generation_id !== expectedQrGenerationId)) {
          const error = new Error('二维码已变化或已失效，拒绝使用旧确认请求结算');
          error.status = 409;
          throw error;
        }
        if (!lockedOrder || lockedOrder.status !== 'pending' ||
            lockedOrder.table_name !== order.table_name ||
            (!Number(lockedOrder.awaiting_confirm) && !lockedOrder.pay_khqr_ref)) {
          const error = new Error('订单状态或桌台已变化，请刷新后重试');
          error.status = 409;
          throw error;
        }

        const paymentMethod = String(lockedOrder.pay_method || 'khqr').trim().slice(0, 40);
        const orderTotalCents = toMoneyCents(lockedOrder.total);
        if (orderTotalCents === null || orderTotalCents <= 0) {
          const error = new Error('订单金额无效');
          error.status = 400;
          throw error;
        }
        const isCash = paymentMethod.toLowerCase() === 'cash';
        const rawCashReceived = req.body?.cash_received ?? lockedOrder.cash_received;
        const cashReceivedCents = isCash ? toMoneyCents(rawCashReceived) : 0;
        if (isCash && (cashReceivedCents === null || cashReceivedCents < orderTotalCents)) {
          const error = new Error('现金实收金额不足或格式无效，最多只能有两位小数');
          error.status = 400;
          throw error;
        }
        const cashChangeCents = isCash ? cashReceivedCents - orderTotalCents : 0;
        const cashReceived = isCash ? cashReceivedCents / 100 : 0;
        const cashChange = cashChangeCents / 100;

        const result = await runAsync(
          "UPDATE orders SET status='done', awaiting_confirm=0, pay_khqr_ref='', pay_expires_at='', pay_qr_generation_id='', pay_method=?, cash_received=?, cash_change=?, settled_at=?, paid_confirmed_by=? WHERE id=? AND store_id=? AND status='pending'",
          [paymentMethod, cashReceived, cashChange, settledAt, req.adminId || req.cashierId || 'unknown', orderId, sid]
        );
        if (!result.affectedRows) {
          const error = new Error('订单状态已变化，请刷新后重试');
          error.status = 409;
          throw error;
        }
        await syncTableStatus(lockedOrder.table_name, sid);
        const stillPending = await getAsync("SELECT COUNT(*) AS cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [lockedOrder.table_name, sid]);
        if (!stillPending || Number(stillPending.cnt) === 0) {
          await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=?', [lockedOrder.table_name, sid]);
        }
        await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [req.isCashier ? 'cashier' : 'admin', req.adminId || req.cashierId || 0, req.isCashier ? (req.cashier?.username || 'cashier') : 'admin', 'khqr_confirm', JSON.stringify({ order_id: orderId, pay_method: paymentMethod, cash_received: cashReceived, cash_change: cashChange }), getClientIp(req), settledAt]);
      });
      io.to('kitchen-' + sid).emit('order:settled', { orderId });
      io.to('waiter-' + sid).emit('order:settled', { orderId });
      io.to('cashier-' + sid).emit('order:settled', { orderId });
      io.to('public-table-' + sid + '-' + order.table_name).emit('order:settled', { orderId });
      res.json({ success: true, status: 'done' });
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });


  /* ===== 列出所有 KHQR provider ===== */
  app.get('/api/admin/khqr/providers', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const list = await loadKhqrProviders(sid);
      res.json({ providers: list });
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
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
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
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
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
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
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

  /* ===== 二维码图片（PNG） ===== */
  app.get('/api/cashier/khqr/qrimage', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      const { storeId: sid } = await resolveKhqrStore(req);
      const { order_id, size } = req.query;
      if (order_id === undefined || order_id === null || order_id === '') {
        return res.status(400).json({ error: '缺少订单 ID' });
      }
      const orderId = parsePositiveOrderId(order_id);
      if (orderId === null) return res.status(400).json({ error: '订单编号无效' });
      const requestedSize = size === undefined ? 240 : parsePositiveOrderId(size);
      if (requestedSize === null) return res.status(400).json({ error: '二维码尺寸无效' });

      const order = await getAsync('SELECT pay_khqr_ref FROM orders WHERE id=? AND store_id=?', [orderId, sid]);
      if (!order || !order.pay_khqr_ref) return res.status(404).json({ error: '未生成动态码' });

      const px = Math.max(120, Math.min(1024, requestedSize));
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
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

  /* ===== 服务员：通知收银员核实到账 ===== */
  app.post('/api/waiter/khqr/notify', requireAdminOrWaiter, async (req, res) => {
    try {
      if (req.waiter && !req.waiter.can_order) return res.status(403).json({ error: '该服务员没有提交收款确认权限' });
      if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_manage_order)) {
        return res.status(403).json({ error: '没有订单收款权限' });
      }
      const { order_id, pay_method, cash_received, cash_change, payment_channel, expected_qr_generation_id: expectedQrGenerationId } = req.body || {};
      const paymentChannel = payment_channel === undefined ? 'manual' : payment_channel;
      if (!['manual', 'khqr'].includes(paymentChannel)) return res.status(400).json({ error: '收款渠道无效' });
      const orderId = parsePositiveOrderId(order_id);
      if (orderId === null) return res.status(400).json({ error: '订单编号无效' });
      if (paymentChannel === 'khqr' && (typeof expectedQrGenerationId !== 'string' || !/^[a-f0-9]{48,64}$/.test(expectedQrGenerationId))) {
        return res.status(400).json({ error: '缺少有效的二维码生成标识，请刷新二维码后重试' });
      }

      let sid;
      let actorName = 'admin';
      if (req.isAdmin) {
        sid = req.storeId;
      } else if (req.waiter) {
        sid = req.waiterStoreId || req.waiter.store_id;
        actorName = req.waiter.display_name || req.waiter.username || 'waiter';
      }
      if (!sid) return res.status(400).json({ error: '未指定店铺' });

      const paymentMethod = typeof pay_method === 'string' ? pay_method.trim().slice(0, 40) : '';
      if (!paymentMethod) return res.status(400).json({ error: '请选择收款方式' });
      const receivedCents = cash_received === undefined ? null : toMoneyCents(cash_received);
      const changeCents = cash_change === undefined ? null : toMoneyCents(cash_change);
      if ((cash_received !== undefined && (receivedCents === null || receivedCents < 0)) ||
          (cash_change !== undefined && (changeCents === null || changeCents < 0))) {
        return res.status(400).json({ error: '收款金额或找零金额无效，最多只能有两位小数' });
      }
      const received = receivedCents === null ? 0 : receivedCents / 100;
      const change = changeCents === null ? 0 : changeCents / 100;

      let notification = null;
      let alreadyNotified = false;
      await withTransaction(async () => {
        const order = await getAsync(
          'SELECT id, status, awaiting_confirm, pay_khqr_ref, pay_qr_generation_id, table_name, order_no, total FROM orders WHERE id=? AND store_id=? FOR UPDATE',
          [orderId, sid]
        );
        if (!order) {
          const error = new Error('订单不存在');
          error.status = 404;
          throw error;
        }
        if (order.status !== 'pending') {
          const error = new Error('订单状态不允许通知');
          error.status = 409;
          throw error;
        }

        if (paymentChannel === 'khqr' && (!order.pay_khqr_ref || order.pay_qr_generation_id !== expectedQrGenerationId)) {
          const error = new Error('二维码已变化或已失效，请刷新后重新确认');
          error.status = 409;
          throw error;
        }

        // A retry after a committed notification is idempotent: do not duplicate
        // the audit entry or broadcast the same notification again.
        if (Number(order.awaiting_confirm)) {
          alreadyNotified = true;
          return;
        }

        // A waiter may only ask the cashier to verify a payment against a QR
        // that was actually issued for this order. Never create a payable state
        // from a bare notification request.
        const notified = await runAsync(
          "UPDATE orders SET awaiting_confirm=1, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=0",
          [paymentMethod, Number.isFinite(received) ? received : 0, Number.isFinite(change) ? change : 0, orderId, sid]
        );
        if (!notified.affectedRows) {
          const error = new Error('订单状态已变化或已提交收款确认，请刷新后重试');
          error.status = 409;
          throw error;
        }

        const now = new Date().toISOString();
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [req.isAdmin ? 'admin' : 'waiter',
           req.isAdmin ? (req.adminId || 0) : (req.waiter ? req.waiter.id : 0),
           actorName, 'khqr_notify_awaiting',
           JSON.stringify({ order_id: orderId, table: order.table_name }),
           getClientIp(req), now]
        );
        notification = {
          orderId: order.id,
          table: order.table_name,
          orderNo: order.order_no,
          total: order.total,
          storeId: sid
        };
      });

      if (notification) {
        io.to('cashier-' + sid).emit('khqr:awaiting', notification);
      }
      res.json({ success: true, status: 'awaiting_confirm', ...(alreadyNotified ? { already: true } : {}) });
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

  /* ===== 取消/退回待确认 ===== */
  app.post('/api/cashier/khqr/cancel', requireAdminOrCashierOrWaiter, async (req, res) => {
    try {
      if (req.isCashier && !req.cashier?.permissions?.can_settle) return res.status(403).json({ error: '没有取消收款确认权限' });
      if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_manage_order)) return res.status(403).json({ error: '没有取消收款确认权限' });
      if (req.isWaiter && !req.waiter?.can_order) return res.status(403).json({ error: '该服务员没有取消收款确认权限' });
      const { order_id } = req.body || {};
      const orderId = parsePositiveOrderId(order_id);
      if (orderId === null) return res.status(400).json({ error: '订单编号无效' });
      const expectedQrRef = req.body?.expected_qr_ref;
      const expectedQrGenerationId = req.body?.expected_qr_generation_id;
      if (expectedQrRef !== undefined &&
          (typeof expectedQrRef !== 'string' || expectedQrRef.length === 0 || expectedQrRef.length > 2048)) {
        return res.status(400).json({ error: '二维码引用无效' });
      }
      if (expectedQrGenerationId !== undefined &&
          (typeof expectedQrGenerationId !== 'string' || !/^[a-f0-9]{48,64}$/.test(expectedQrGenerationId))) {
        return res.status(400).json({ error: '二维码生成标识无效' });
      }
      const { storeId: sid } = await resolveKhqrStore(req);
      if (req.waiter && req.waiterStoreId !== sid && req.waiter.store_id !== sid) {
        return res.status(403).json({ error: '不能操作其他门店的订单' });
      }
      await withTransaction(async () => {
        const order = await getAsync(
          'SELECT id, status, awaiting_confirm, pay_khqr_ref, pay_expires_at, pay_qr_generation_id, table_name FROM orders WHERE id=? AND store_id=? FOR UPDATE',
          [orderId, sid]
        );
        if (!order || order.status !== 'pending' || (!Number(order.awaiting_confirm) && !order.pay_khqr_ref)) {
          const error = new Error('订单不存在或当前状态不允许取消待确认');
          error.status = 409;
          throw error;
        }
        if (req.waiter && Number(order.awaiting_confirm)) {
          const error = new Error('该订单已提交到账确认，只能由收银员或管理员取消');
          error.status = 403;
          throw error;
        }
        // Never let a close request without an ownership reference clear an
        // active QR: another terminal may have created it after this client
        // started its own generation request.
        if (order.pay_khqr_ref && expectedQrGenerationId === undefined) {
          const error = new Error('取消请求缺少二维码生成标识，请刷新后重试');
          error.status = 409;
          throw error;
        }
        // QR payloads can be deterministic for the same order and amount. Use a
        // random generation ID so an old response cannot cancel a later QR even
        // when both payload strings are identical.
        if (order.pay_khqr_ref && order.pay_qr_generation_id !== expectedQrGenerationId) {
          const error = new Error('二维码生成批次已变化，请刷新后重试');
          error.status = 409;
          throw error;
        }
        if (expectedQrRef !== undefined && order.pay_khqr_ref !== expectedQrRef) {
          const error = new Error('二维码已变化，请刷新后重试');
          error.status = 409;
          throw error;
        }
        const result = await runAsync(
          "UPDATE orders SET awaiting_confirm=0, pay_khqr_ref='', pay_expires_at='', pay_qr_generation_id='' WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=? AND pay_khqr_ref <=> ? AND COALESCE(pay_qr_generation_id, '') = ?",
          [orderId, sid, Number(order.awaiting_confirm) ? 1 : 0, order.pay_khqr_ref ?? null, order.pay_qr_generation_id || '']
        );
        if (!result.affectedRows) {
          const error = new Error('订单状态已变化，请刷新后重试');
          error.status = 409;
          throw error;
        }
        const actorType = req.waiter ? 'waiter' : req.isCashier ? 'cashier' : 'admin';
        const actorId = req.waiter ? (req.waiter.id || 0) : req.isCashier ? (req.cashier?.id || 0) : (req.adminId || 0);
        const actorUsername = req.waiter
          ? (req.waiter.display_name || req.waiter.username || 'waiter')
          : req.isCashier ? (req.cashier?.username || 'cashier') : (req.admin?.username || req.username || 'admin');
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [actorType, actorId, actorUsername, 'khqr_cancel',
           JSON.stringify({ order_id: orderId, table: order.table_name, was_awaiting_confirm: !!Number(order.awaiting_confirm), had_qr_reference: !!order.pay_khqr_ref }),
           getClientIp(req), new Date().toISOString()]
        );
      });
      res.json({ success: true });
    } catch (e) { const status = Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500;
      res.status(status).json({ error: status === 500 ? '请求失败，请稍后重试' : e.message }); }
  });

};
