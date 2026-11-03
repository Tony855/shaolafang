/**
 * server/middleware/auth.js
 * 精简版：只保留被 server.js 引用的 requireSuperAdmin 和 requireCashier。
 */
const { getAsync, runAsync } = require('../db/helpers');

async function requireSuperAdmin(req, res, next) {
  try {
    let token = '';
    const auth = req.headers['authorization'] || '';
    if (auth) token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token && req.headers['x-super-token']) token = String(req.headers['x-super-token']).trim();
    if (!token) return res.status(401).json({ error: '未登录' });
    const session = await getAsync('SELECT * FROM super_sessions WHERE token=?', [token]);
    if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
    if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) {
      await runAsync('DELETE FROM super_sessions WHERE token=?', [token]).catch(() => {});
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'super_idle_timeout'");
    const timeoutMinutes = parseInt(timeoutSetting?.value || '60', 10);
    const newExpires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    runAsync('UPDATE super_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(() => {});
    const superAdmin = await getAsync('SELECT * FROM super_admins WHERE id=?', [session.super_admin_id]);
    if (!superAdmin) return res.status(401).json({ error: '登录已过期' });
    req.superAdmin = superAdmin;
    req.superSessionToken = token;
    next();
  } catch (e) {
    console.error('requireSuperAdmin 认证异常:', e.message);
    res.status(401).json({ error: '认证失败' });
  }
}

async function requireCashier(req, res, next) {
  try {
    const token = req.get('X-Cashier-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: '请先登录收银员账号' });
    const session = await getAsync('SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token=?', [token]);
    if (!session || !Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    const cashiersData = await getAsync('SELECT value FROM settings WHERE `key` = ?', ['cashiers_' + session.store_id]);
    if (!cashiersData) return res.status(401).json({ error: '账号不存在' });
    let cashiers = [];
    try { cashiers = JSON.parse(cashiersData.value); } catch (e) { return res.status(401).json({ error: '账号数据异常' }); }
    const cashier = cashiers.find(c => String(c.id) === String(session.cashier_id) && c.active);
    if (!cashier) return res.status(401).json({ error: '账号不存在或已停用' });
    req.cashier = { ...cashier, store_id: session.store_id, merchant_id: session.merchant_id };
    req.storeId = session.store_id || 1;
    req.merchantId = session.merchant_id || 1;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function requireAdminOrCashier(req, res, next) {
  // 先试管理员
  const { authenticateAdmin } = require('./admin-auth');
  const adminResult = await authenticateAdmin(req);
  if (adminResult && !adminResult.error) {
    req.adminId = adminResult.adminId;
    req.merchantId = adminResult.merchantId;
    req.adminSessionToken = adminResult.sessionToken;
    req.storeId = adminResult.storeId || parseInt(req.get('X-Store-Id') || '0', 10);
    req.isAdmin = true;
    if (adminResult.adminId && adminResult.merchantId) {
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1', [adminResult.adminId, adminResult.merchantId]);
      if (!admin) return res.status(401).json({ error: '管理员账号已停用或不存在' });
      const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [adminResult.merchantId]);
      req.isPrimaryAdmin = Boolean(primaryAdmin && String(primaryAdmin.id) === String(admin.id));
      req.adminPermissions = {
        can_manage_menu: req.isPrimaryAdmin || admin.can_manage_menu ? 1 : 0,
        can_manage_table: req.isPrimaryAdmin || admin.can_manage_table ? 1 : 0,
        can_manage_order: req.isPrimaryAdmin || admin.can_manage_order ? 1 : 0,
        can_delete_order: req.isPrimaryAdmin || admin.can_delete_order ? 1 : 0,
        can_edit_order: req.isPrimaryAdmin || admin.can_edit_order ? 1 : 0,
        can_manage_store: req.isPrimaryAdmin || admin.can_manage_store ? 1 : 0,
        can_manage_waiter: req.isPrimaryAdmin || admin.can_manage_waiter ? 1 : 0,
        can_manage_currency: req.isPrimaryAdmin || admin.can_manage_currency ? 1 : 0,
        can_manage_printer: req.isPrimaryAdmin || admin.can_manage_printer ? 1 : 0,
        can_manage_admin: req.isPrimaryAdmin || admin.can_manage_admin ? 1 : 0,
        can_view_logs: req.isPrimaryAdmin || admin.can_view_logs ? 1 : 0
      };
    }
    return next();
  }
  // 再试收银员
  try {
    const token = req.get('X-Cashier-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: '未登录' });
    const session = await getAsync('SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token=?', [token]);
    if (!session || !Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    const cashiersData = await getAsync('SELECT value FROM settings WHERE `key`=?', ['cashiers_' + session.store_id]);
    if (!cashiersData) return res.status(401).json({ error: '账号不存在' });
    let list = [];
    try { list = JSON.parse(cashiersData.value); } catch (e) { return res.status(401).json({ error: '账号数据异常' }); }
    const cashier = list.find(c => String(c.id) === String(session.cashier_id) && c.active);
    if (!cashier) return res.status(401).json({ error: '账号不存在或已停用' });
    req.cashier = { ...cashier, store_id: session.store_id, merchant_id: session.merchant_id };
    req.cashierId = cashier.id;
    req.storeId = session.store_id;
    req.merchantId = session.merchant_id;
    req.isCashier = true;
    return next();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function requireAdminOrCashierOrWaiter(req, res, next) {
  // 1) 先试管理员 / 收银员（复用现有逻辑）
  const { authenticateAdmin } = require('./admin-auth');
  const adminResult = await authenticateAdmin(req);
  if (adminResult && !adminResult.error) {
    req.adminId = adminResult.adminId;
    req.merchantId = adminResult.merchantId;
    req.adminSessionToken = adminResult.sessionToken;
    req.storeId = adminResult.storeId || parseInt(req.get('X-Store-Id') || '0', 10);
    req.isAdmin = true;
    return next();
  }
  // 2) 试收银员
  try {
    const cashierToken = req.get('X-Cashier-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (cashierToken) {
      const session = await getAsync('SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token=?', [cashierToken]);
      if (session && Number.isFinite(new Date(session.expires_at).getTime()) && new Date(session.expires_at).getTime() > Date.now()) {
        const cashiersData = await getAsync('SELECT value FROM settings WHERE `key`=?', ['cashiers_' + session.store_id]);
        if (cashiersData) {
          let list = [];
          try { list = JSON.parse(cashiersData.value); } catch (e) {}
          const cashier = list.find(c => String(c.id) === String(session.cashier_id) && c.active);
          if (cashier) {
            req.cashier = { ...cashier, store_id: session.store_id, merchant_id: session.merchant_id };
            req.cashierId = cashier.id;
            req.storeId = session.store_id;
            req.merchantId = session.merchant_id;
            req.isCashier = true;
            return next();
          }
        }
      }
    }
  } catch (e) { /* 继续试 waiter */ }
  // 3) 试服务员
  try {
    const waiterToken = req.get('X-Waiter-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (waiterToken) {
      const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token=?', [waiterToken]);
      if (session && Number.isFinite(new Date(session.expires_at).getTime()) && new Date(session.expires_at).getTime() > Date.now()) {
        const waiter = await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [session.waiter_id]);
        if (waiter) {
          req.waiter = waiter;
          req.waiterStoreId = waiter.store_id || 1;
          req.storeId = waiter.store_id || 1;
          req.merchantId = waiter.merchant_id || 1;
          req.isWaiter = true;
          req.isAdmin = false;
          return next();
        }
      }
    }
  } catch (e) { /* 落到 401 */ }
  return res.status(401).json({ error: '未登录或登录已过期' });
}

module.exports = { requireSuperAdmin, requireCashier, requireAdminOrCashier, requireAdminOrCashierOrWaiter };
