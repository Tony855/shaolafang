/**
 * server/middleware/auth.js
 * 精简版：只保留被 server.js 引用的 requireSuperAdmin 和 requireCashier。
 */
const { getAsync, runAsync } = require('../db/helpers');
const { hashSessionToken } = require('../services/session-token');

function isPermissionEnabled(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function buildAdminPermissions(admin, isPrimaryAdmin) {
  const keys = [
    'can_manage_menu', 'can_manage_table', 'can_manage_order', 'can_delete_order',
    'can_edit_order', 'can_manage_store', 'can_manage_waiter', 'can_manage_currency',
    'can_manage_printer', 'can_manage_admin', 'can_view_logs', 'can_manage_cashier'
  ];
  return Object.fromEntries(keys.map(key => [key, isPrimaryAdmin || isPermissionEnabled(admin[key]) ? 1 : 0]));
}

function normalizeCashierPermissions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = (value, fallback) => value === undefined || value === null ? fallback : isPermissionEnabled(value);
  return {
    can_settle: enabled(source.can_settle, true),
    can_cancel: enabled(source.can_cancel, true),
    can_refund: enabled(source.can_refund, false),
    can_view_report: enabled(source.can_view_report, true)
  };
}


async function requireSuperAdmin(req, res, next) {
  try {
    let token = '';
    const auth = req.headers['authorization'] || '';
    if (auth) token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token && req.headers['x-super-token']) token = String(req.headers['x-super-token']).trim();
    if (!token) return res.status(401).json({ error: '未登录' });
    const session = await getAsync('SELECT * FROM super_sessions WHERE token_hash=?', [hashSessionToken(token)]);
    if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
    if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) {
      await runAsync('DELETE FROM super_sessions WHERE token_hash=?', [hashSessionToken(token)]).catch(() => {});
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'super_idle_timeout'");
    const configuredTimeoutMinutes = Number(timeoutSetting?.value ?? 60);
    const timeoutMinutes = Number.isSafeInteger(configuredTimeoutMinutes) && configuredTimeoutMinutes > 0 ? Math.min(configuredTimeoutMinutes, 1440) : 60;
    const newExpires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    runAsync('UPDATE super_sessions SET expires_at=? WHERE token_hash=?', [newExpires, token]).catch(() => {});
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
    const session = await getAsync('SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token_hash=?', [hashSessionToken(token)]);
    if (!session || !Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    const store = await getAsync(
      'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1',
      [session.store_id, session.merchant_id]
    );
    if (!store || !Number.isSafeInteger(Number(session.store_id)) || Number(session.store_id) <= 0) {
      return res.status(401).json({ error: '门店或商户已停用' });
    }
    const cashiersData = await getAsync('SELECT value FROM settings WHERE `key` = ?', ['cashiers_' + session.store_id]);
    if (!cashiersData) return res.status(401).json({ error: '账号不存在' });
    let cashiers = [];
    try { cashiers = JSON.parse(cashiersData.value); } catch (e) { return res.status(401).json({ error: '账号数据异常' }); }
    const cashier = Array.isArray(cashiers) ? cashiers.find(c => c && String(c.id) === String(session.cashier_id) && (c.active === true || c.active === 1 || c.active === '1' || c.active === 'true')) : null;
    if (!cashier) return res.status(401).json({ error: '账号不存在或已停用' });
    req.cashier = { ...cashier, active: true, permissions: normalizeCashierPermissions(cashier.permissions), store_id: session.store_id, merchant_id: session.merchant_id };
    req.storeId = Number(session.store_id);
    req.merchantId = Number(session.merchant_id);
    next();
  } catch (e) {
    console.error('Cashier authentication failed:', e.message);
    res.status(500).json({ error: '认证服务暂时不可用' });
  }
}


function respondAuthUnavailable(res, context) {
  // Do not expose database hosts, SQL, credentials, or driver messages to clients/logs.
  console.error('[auth] ' + context + ' failed; authentication storage is unavailable');
  if (res.headersSent) return;
  return res.status(503).json({ error: '认证服务暂时不可用，请稍后重试' });
}

async function requireAdminOrCashier(req, res, next) {
  try {
    const { authenticateAdmin } = require('./admin-auth');
    const adminResult = await authenticateAdmin(req);
    if (adminResult && adminResult.error) return res.status(401).json(adminResult);
    if (adminResult) {
      req.adminId = adminResult.adminId;
      req.merchantId = adminResult.merchantId;
      req.adminSessionToken = adminResult.sessionToken;
      req.storeId = Number.isSafeInteger(Number(adminResult.storeId)) && Number(adminResult.storeId) !== 0
        ? Number(adminResult.storeId) : -1;
      req.isAdmin = true;
      if (adminResult.adminId && adminResult.merchantId) {
        const admin = await getAsync(
          'SELECT * FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',
          [adminResult.adminId, adminResult.merchantId]
        );
        if (!admin) return res.status(401).json({ error: '管理员账号已停用或不存在' });
        const primaryAdmin = await getAsync(
          'SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1',
          [adminResult.merchantId]
        );
        req.isPrimaryAdmin = Boolean(primaryAdmin && String(primaryAdmin.id) === String(admin.id));
        req.adminPermissions = buildAdminPermissions(admin, req.isPrimaryAdmin);
      }
      return next();
    }

    const token = req.get('X-Cashier-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: '未登录' });
    const session = await getAsync(
      'SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token_hash=?',
      [hashSessionToken(token)]
    );
    if (!session || !Number.isFinite(new Date(session.expires_at).getTime()) ||
        new Date(session.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    const cashierStore = await getAsync(
      'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1',
      [session.store_id, session.merchant_id]
    );
    if (!cashierStore || !Number.isSafeInteger(Number(session.store_id)) || Number(session.store_id) <= 0) {
      return res.status(401).json({ error: '门店或商户已停用' });
    }
    const cashiersData = await getAsync('SELECT value FROM settings WHERE `key`=?', ['cashiers_' + session.store_id]);
    if (!cashiersData) return res.status(401).json({ error: '账号不存在' });
    let list = [];
    try { list = JSON.parse(cashiersData.value); }
    catch (_) { return res.status(401).json({ error: '账号数据异常' }); }
    const cashier = Array.isArray(list)
      ? list.find(c => c && String(c.id) === String(session.cashier_id) &&
        (c.active === true || c.active === 1 || c.active === '1' || c.active === 'true'))
      : null;
    if (!cashier) return res.status(401).json({ error: '账号不存在或已停用' });
    req.cashier = {
      ...cashier, active: true,
      permissions: normalizeCashierPermissions(cashier.permissions),
      store_id: session.store_id, merchant_id: session.merchant_id
    };
    req.cashierId = cashier.id;
    req.storeId = session.store_id;
    req.merchantId = session.merchant_id;
    req.isCashier = true;
    return next();
  } catch (_) {
    return respondAuthUnavailable(res, 'requireAdminOrCashier');
  }
}

async function requireAdminOrCashierOrWaiter(req, res, next) {
  try {
    const { authenticateAdmin } = require('./admin-auth');
    const adminResult = await authenticateAdmin(req);
    if (adminResult && adminResult.error) return res.status(401).json(adminResult);
    if (adminResult) {
      req.adminId = adminResult.adminId;
      req.merchantId = adminResult.merchantId;
      req.adminSessionToken = adminResult.sessionToken;
      req.storeId = Number.isSafeInteger(Number(adminResult.storeId)) && Number(adminResult.storeId) !== 0
        ? Number(adminResult.storeId) : -1;
      req.isAdmin = true;
      if (adminResult.adminId && adminResult.merchantId) {
        const admin = await getAsync(
          'SELECT * FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',
          [adminResult.adminId, adminResult.merchantId]
        );
        if (!admin) return res.status(401).json({ error: '管理员账号已停用或不存在' });
        const primaryAdmin = await getAsync(
          'SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1',
          [adminResult.merchantId]
        );
        req.isPrimaryAdmin = Boolean(primaryAdmin && String(primaryAdmin.id) === String(admin.id));
        req.adminPermissions = buildAdminPermissions(admin, req.isPrimaryAdmin);
      }
      return next();
    }

    // Database failures must not be swallowed as an anonymous waiter fallback.
    const cashierToken = req.get('X-Cashier-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (cashierToken) {
      const session = await getAsync(
        'SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token_hash=?',
        [cashierToken]
      );
      if (session && Number.isFinite(new Date(session.expires_at).getTime()) &&
          new Date(session.expires_at).getTime() > Date.now()) {
        const storeId = Number(session.store_id);
        if (!Number.isSafeInteger(storeId) || storeId <= 0) {
          return res.status(401).json({ error: '门店或商户已停用' });
        }
        const cashierStore = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1',
          [session.store_id, session.merchant_id]
        );
        if (!cashierStore) return res.status(401).json({ error: '门店或商户已停用' });
        const cashiersData = await getAsync('SELECT value FROM settings WHERE `key`=?', ['cashiers_' + session.store_id]);
        if (cashiersData) {
          let list = [];
          try { list = JSON.parse(cashiersData.value); } catch (_) { list = []; }
          const cashier = Array.isArray(list)
            ? list.find(c => c && String(c.id) === String(session.cashier_id) &&
              (c.active === true || c.active === 1 || c.active === '1' || c.active === 'true'))
            : null;
          if (cashier) {
            req.cashier = {
              ...cashier, active: true,
              permissions: normalizeCashierPermissions(cashier.permissions),
              store_id: session.store_id, merchant_id: session.merchant_id
            };
            req.cashierId = cashier.id;
            req.storeId = session.store_id;
            req.merchantId = session.merchant_id;
            req.isCashier = true;
            return next();
          }
        }
      }
    }

    const waiterToken = req.get('X-Waiter-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (waiterToken) {
      const session = await getAsync(
        'SELECT waiter_id, expires_at FROM waiter_sessions WHERE token_hash=?',
        [waiterToken]
      );
      if (session && Number.isFinite(new Date(session.expires_at).getTime()) &&
          new Date(session.expires_at).getTime() > Date.now()) {
        const waiter = await getAsync(
          'SELECT w.*, s.merchant_id AS merchant_id FROM waiters w JOIN stores s ON s.id=w.store_id AND s.active=1 JOIN merchants m ON m.id=s.merchant_id AND m.status=1 WHERE w.id=? AND w.active=1',
          [session.waiter_id]
        );
        if (waiter && Number.isSafeInteger(Number(waiter.store_id)) && Number(waiter.store_id) > 0) {
          req.waiter = waiter;
          req.waiterStoreId = Number(waiter.store_id);
          req.storeId = Number(waiter.store_id);
          req.merchantId = Number(waiter.merchant_id);
          req.isWaiter = true;
          req.isAdmin = false;
          return next();
        }
      }
    }
    return res.status(401).json({ error: '未登录或登录已过期' });
  } catch (_) {
    return respondAuthUnavailable(res, 'requireAdminOrCashierOrWaiter');
  }
}

module.exports = { requireSuperAdmin, requireCashier, requireAdminOrCashier, requireAdminOrCashierOrWaiter };
