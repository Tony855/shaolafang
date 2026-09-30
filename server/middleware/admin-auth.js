/**
 * server/middleware/admin-auth.js
 * 管理员认证中间件（从 server.js 抽出）
 */
const { getAsync, runAsync } = require('../db/helpers');

async function getWaiterFromRequest(req) {
  const token = req.get('X-Waiter-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token=?', [token]);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [session.waiter_id]);
}

async function getCashierFromRequest(req) {
  const token = req.get('X-Cashier-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getAsync('SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token=?', [token]);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  const cashiersData = await getAsync('SELECT value FROM settings WHERE `key` = ?', ['cashiers_' + session.store_id]);
  if (!cashiersData) return null;
  let cashiers = [];
  try { cashiers = JSON.parse(cashiersData.value); } catch (e) { return null; }
  const cashier = cashiers.find(c => String(c.id) === String(session.cashier_id) && c.active);
  if (!cashier) return null;
  return { ...cashier, store_id: session.store_id, merchant_id: session.merchant_id };
}

async function authenticateAdmin(req) {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token) {
    const session = await getAsync('SELECT * FROM admin_sessions WHERE token=?', [token]);
    if (session) {
      if (new Date(session.expires_at).getTime() <= Date.now()) {
        await runAsync('DELETE FROM admin_sessions WHERE token=?', [token]).catch(() => {});
        return { error: '登录已过期，请重新登录' };
      }
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [session.admin_id]);
      if (admin) {
        const merchant = await getAsync('SELECT * FROM merchants WHERE id=? AND status=1', [admin.merchant_id]);
        if (merchant) {
          const requestedStoreId = parseInt(req.get('X-Store-Id') || '0', 10);
          let validStoreId = null;
          if (requestedStoreId > 0) {
            const _storeCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [requestedStoreId, admin.merchant_id]);
            if (!_storeCheck) {
              return { error: '指定的门店不存在或不属于当前商户' };
            }
            validStoreId = requestedStoreId;
          }
          const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
          const timeoutMinutes = parseInt(timeoutSetting?.value || '30', 10);
          const newExpires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
          runAsync('UPDATE admin_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(() => {});
          return { adminId: admin.id, merchantId: admin.merchant_id, storeId: validStoreId, sessionToken: token };
        }
      }
    }
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64').toString());
      if (payload.adminId) {
        const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [payload.adminId]);
        if (admin) {
          const merchant = await getAsync('SELECT * FROM merchants WHERE id=? AND status=1', [admin.merchant_id]);
          if (merchant) {
            const legacyStoreId = parseInt(req.get('X-Store-Id') || '0', 10);
            let legacyValidStoreId = null;
            if (legacyStoreId > 0) {
              const _legacyStoreCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [legacyStoreId, admin.merchant_id]);
              if (!_legacyStoreCheck) {
                return { error: '指定的门店不存在或不属于当前商户' };
              }
              legacyValidStoreId = legacyStoreId;
            }
            return { adminId: admin.id, merchantId: admin.merchant_id, storeId: legacyValidStoreId };
          }
        }
      }
    } catch (e) { }
  }
  const providedKey = req.get('X-Admin-Key');
  const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_access_key'");
  if (providedKey && setting && providedKey === setting.value) {
    return { storeId: parseInt(req.get('X-Store-Id') || '1', 10) };
  }
  return null;
}

async function requireAdminKey(req, res, next) {
  const result = await authenticateAdmin(req);
  if (result && result.error) return res.status(401).json({ error: result.error });
  if (result) {
    req.adminId = result.adminId;
    req.merchantId = result.merchantId;
    req.adminSessionToken = result.sessionToken;
    req.storeId = result.storeId || 0;
    // 未选店铺时 storeId = 0，业务层自己处理（查询返回空数据）
    // 只要 X-Store-Id 存在但无效，authenticateAdmin 已经返回 error，不会走到这里
    try {
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=?', [result.adminId]);
      if (admin) {
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [result.merchantId]);
        req.isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
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
    } catch (e) { console.warn('加载管理员权限失败:', e.message); }
    return next();
  }
  return res.status(401).json({ error: '未登录或登录已过期' });
}

function requirePermission(permKey) {
  return function(req, res, next) {
    if (req.isPrimaryAdmin || (req.adminPermissions && req.adminPermissions[permKey])) {
      return next();
    }
    return res.status(403).json({ error: '没有操作权限' });
  };
}

async function logAudit(actorType, actorId, actorUsername, action, targetType, targetId, details, ip) {
  try {
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [actorType, actorId || null, actorUsername || '', action, targetType || null, targetId || null, details || '', ip || '', new Date().toISOString()]);
  } catch (e) { console.warn('审计日志记录失败:', e.message); }
}

async function requireAdminOrWaiter(req, res, next) {
  const adminResult = await authenticateAdmin(req);
  if (adminResult && adminResult.error) return res.status(401).json({ error: adminResult.error });
  if (adminResult) {
    req.adminId = adminResult.adminId;
    req.merchantId = adminResult.merchantId;
    req.isAdmin = true;
    req.adminSessionToken = adminResult.sessionToken;
    req.storeId = adminResult.storeId;
    try {
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=?', [adminResult.adminId]);
      if (admin) {
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [adminResult.merchantId]);
        req.isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
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
    } catch (e) { console.warn('加载管理员权限失败:', e.message); }
    return next();
  }
  const authHeader = req.get('Authorization') || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
  const token = req.get('X-Waiter-Token') || bearerToken;
  if (token) {
    const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token=?', [token]);
    if (session && new Date(session.expires_at).getTime() > Date.now()) {
      const waiter = await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [session.waiter_id]);
      if (waiter) {
        req.waiter = waiter;
        req.waiterStoreId = waiter.store_id || 1;
        req.isAdmin = false;
        const expiresTime = new Date(session.expires_at).getTime();
        if (expiresTime - Date.now() < 60 * 60 * 1000) {
          const wTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
          const wTimeoutHours = parseInt(wTimeoutSetting?.value || '12', 10);
          const newExpires = new Date(Date.now() + wTimeoutHours * 60 * 60 * 1000).toISOString();
          runAsync('UPDATE waiter_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(()=>{});
        }
        return next();
      }
    }
  }
  return res.status(401).json({ error: '无操作权限' });
}

module.exports = {
  getWaiterFromRequest,
  getCashierFromRequest,
  authenticateAdmin,
  requireAdminKey,
  requirePermission,
  logAudit,
  requireAdminOrWaiter,
};
