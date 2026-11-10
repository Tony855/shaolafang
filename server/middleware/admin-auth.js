/**
 * server/middleware/admin-auth.js
 * 管理员认证中间件（从 server.js 抽出）
 */
const { getAsync, runAsync, allAsync } = require('../db/helpers');
const { getActiveWaiter } = require('../services/waiter-auth');
const crypto = require('crypto');
const { parsePositiveRouteId } = require('../services/route-id');

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


// Keep cashier activation and permission parsing identical across auth paths.
// Legacy JSON may contain string values such as "false"; never rely on truthiness.
function cashierIsActive(cashier) {
  return !!cashier && (cashier.active === true || cashier.active === 1 ||
    cashier.active === '1' || cashier.active === 'true');
}

function normalizeCashierPermissions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    return value === true || value === 1 || value === '1' || value === 'true';
  };
  return {
    can_settle: enabled(source.can_settle, true),
    can_cancel: enabled(source.can_cancel, true),
    can_refund: enabled(source.can_refund, false),
    can_view_report: enabled(source.can_view_report, true)
  };
}

function respondAuthUnavailable(res, context) {
  // Do not expose database hosts, SQL, credentials, or driver messages to clients/logs.
  console.error('[auth] ' + context + ' failed; authentication storage is unavailable');
  if (res.headersSent) return;
  return res.status(503).json({ error: '认证服务暂时不可用，请稍后重试' });
}

async function getWaiterFromRequest(req) {
  const token = req.get('X-Waiter-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token_hash=?', [hashSessionToken(token)]);
  if (!session || !Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return await getAsync(
    'SELECT w.* FROM waiters w JOIN stores s ON s.id=w.store_id AND s.merchant_id=w.merchant_id AND s.active=1 JOIN merchants m ON m.id=w.merchant_id AND m.status=1 WHERE w.id=? AND w.active=1',
    [session.waiter_id]
  );
}

async function getCashierFromRequest(req) {
  const token = req.get('X-Cashier-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getAsync('SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token_hash=?', [hashSessionToken(token)]);
  if (!session || !Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) return null;
  const activeStore = await getAsync(
    'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1',
    [session.store_id, session.merchant_id]
  );
  if (!activeStore) return null;
  const cashiersData = await getAsync('SELECT value FROM settings WHERE `key` = ?', ['cashiers_' + session.store_id]);
  if (!cashiersData) return null;
  let cashiers = [];
  try { cashiers = JSON.parse(cashiersData.value); } catch (e) { return null; }
  if (!Array.isArray(cashiers)) return null;
  const cashier = cashiers.find(c => String(c.id) === String(session.cashier_id) && cashierIsActive(c));
  if (!cashier) return null;
  return {
    ...cashier,
    active: true,
    permissions: normalizeCashierPermissions(cashier.permissions),
    store_id: session.store_id,
    merchant_id: session.merchant_id
  };
}

async function authenticateAdmin(req) {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token) {
    const session = await getAsync('SELECT * FROM admin_sessions WHERE token_hash=?', [hashSessionToken(token)]);
    if (session) {
      if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) {
        await runAsync('DELETE FROM admin_sessions WHERE token_hash=?', [hashSessionToken(token)]).catch(() => {});
        return { error: '登录已过期，请重新登录' };
      }
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [session.admin_id]);
      if (admin) {
        const merchant = await getAsync('SELECT * FROM merchants WHERE id=? AND status=1', [admin.merchant_id]);
        if (merchant) {
          const rawRequestedStoreId = req.get('X-Store-Id');
          const requestedStoreId = rawRequestedStoreId === undefined || rawRequestedStoreId === null || rawRequestedStoreId === ''
            ? 0
            : parsePositiveRouteId(rawRequestedStoreId);
          let validStoreId = null;
          if (rawRequestedStoreId !== undefined && rawRequestedStoreId !== null && rawRequestedStoreId !== '' &&
              requestedStoreId === null) {
            return { error: '指定的门店编号无效', code: 'INVALID_STORE_ID' };
          }
          if (requestedStoreId > 0) {
            const _storeCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1', [requestedStoreId, admin.merchant_id]);
            if (!_storeCheck) {
              const _validStores = await allAsync('SELECT id, name FROM stores WHERE merchant_id=? ORDER BY id ASC', [admin.merchant_id]);
              return {
                error: '指定的门店不存在或不属于当前商户',
                code: 'STORE_NOT_IN_MERCHANT',
                requestedStoreId: requestedStoreId,
                validStores: _validStores,
                merchantId: admin.merchant_id
              };
            }
            validStoreId = Number(_storeCheck.id);
          } else {
            // Default to this merchant's first store, never global store_id=1.
            const firstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? AND active=1 ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
            validStoreId = firstStore ? Number(firstStore.id) : -1;
          }
          const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
          const configuredTimeoutMinutes = Number(timeoutSetting?.value ?? 30);
          const timeoutMinutes = Number.isSafeInteger(configuredTimeoutMinutes) && configuredTimeoutMinutes > 0 ? Math.min(configuredTimeoutMinutes, 1440) : 30;
          const newExpires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
          runAsync('UPDATE admin_sessions SET expires_at=? WHERE token_hash=?', [newExpires, hashSessionToken(token)]).catch(() => {});
          return { adminId: admin.id, merchantId: admin.merchant_id, storeId: validStoreId, sessionToken: token };
        }
      }
    }

  }
  const providedKey = req.get('X-Admin-Key');
  const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_access_key'");
  if (providedKey && setting && setting.value) {
    const supplied = Buffer.from(String(providedKey));
    const expected = Buffer.from(String(setting.value));
    if (supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
      // The legacy key is a single integration credential, not a global
      // super-admin credential. Bind it to one configured store so changing
      // X-Store-Id cannot turn it into a cross-merchant access key.
      const scopeSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_access_key_store_id'");
      const scopedStoreId = parsePositiveRouteId(String(scopeSetting?.value ?? '1'));
      if (scopedStoreId === null) {
        return { error: '管理员 API 密钥门店绑定配置无效', code: 'INVALID_API_KEY_STORE_SCOPE' };
      }
      const rawStoreId = req.get('X-Store-Id');
      const requestedStoreId = rawStoreId === undefined || rawStoreId === null || rawStoreId === ''
        ? scopedStoreId
        : parsePositiveRouteId(rawStoreId);
      if (requestedStoreId === null) {
        return { error: '指定的店铺编号无效', code: 'INVALID_STORE_ID' };
      }
      if (requestedStoreId !== scopedStoreId) {
        return { error: '管理员 API 密钥未授权访问该门店', code: 'STORE_NOT_IN_API_KEY_SCOPE' };
      }
      const store = await getAsync('SELECT s.id, s.merchant_id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1', [scopedStoreId]);
      if (!store) return { error: '指定的店铺不存在或已停用', code: 'STORE_NOT_ACTIVE' };
      return { storeId: Number(store.id), merchantId: store.merchant_id, legacyApiKey: true };
    }
  }
  return null;
}


async function requireAdminKey(req, res, next) {
  try {
    const result = await authenticateAdmin(req);
    if (result && result.error) return res.status(401).json(result);
    if (result) {
      req.adminId = result.adminId;
      req.merchantId = result.merchantId;
      req.adminSessionToken = result.sessionToken;
      req.storeId = Number.isSafeInteger(Number(result.storeId)) && Number(result.storeId) !== 0
        ? Number(result.storeId) : -1;
      // Legacy API-key auth has no individual admin identity; it does not receive
      // a synthetic primary-admin role or inherited fine-grained permissions.
      if (result.adminId) {
        const admin = await getAsync(
          'SELECT * FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',
          [result.adminId, result.merchantId]
        );
        if (!admin) return res.status(401).json({ error: '管理员账号已停用或不存在' });
        const primaryAdmin = await getAsync(
          'SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1',
          [result.merchantId]
        );
        req.isPrimaryAdmin = Boolean(primaryAdmin && String(primaryAdmin.id) === String(admin.id));
        req.adminPermissions = buildAdminPermissions(admin, req.isPrimaryAdmin);
      }
      return next();
    }
    return res.status(401).json({ error: '未登录或登录已过期' });
  } catch (_) {
    return respondAuthUnavailable(res, 'requireAdminKey');
  }
}

function requirePermission(permKey) {
  return function(req, res, next) {
    if (req.isPrimaryAdmin || (req.adminPermissions && req.adminPermissions[permKey])) {
      return next();
    }
    return res.status(403).json({ error: '没有操作权限' });
  };
}

async function logAuditStrict(actorType, actorId, actorUsername, action, targetType, targetId, details, ip) {
  await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [actorType, actorId || null, actorUsername || '', action, targetType || null, targetId || null, details || '', ip || '', new Date().toISOString()]);
}

// Best-effort audit for non-transactional, informational events. Destructive
// workflows must use logAuditStrict so an audit write failure can abort them.
async function logAudit(...args) {
  try { await logAuditStrict(...args); }
  catch (e) { console.warn('审计日志记录失败:', e.message); }
}


async function requireAdminOrWaiter(req, res, next) {
  try {
    const adminResult = await authenticateAdmin(req);
    if (adminResult && adminResult.error) return res.status(401).json(adminResult);
    if (adminResult) {
      req.adminId = adminResult.adminId;
      req.merchantId = adminResult.merchantId;
      req.isAdmin = true;
      req.adminSessionToken = adminResult.sessionToken;
      req.storeId = Number.isSafeInteger(Number(adminResult.storeId)) && Number(adminResult.storeId) !== 0
        ? Number(adminResult.storeId) : -1;
      if (adminResult.adminId) {
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

    const authHeader = req.get('Authorization') || '';
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
    const token = req.get('X-Waiter-Token') || bearerToken;
    if (token) {
      const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token_hash=?', [hashSessionToken(token)]);
      if (session && Number.isFinite(new Date(session.expires_at).getTime()) &&
          new Date(session.expires_at).getTime() > Date.now()) {
        const waiter = await getActiveWaiter(getAsync, session.waiter_id);
        if (waiter) {
          req.waiter = waiter;
          req.waiterStoreId = Number(waiter.store_id);
          req.storeId = Number(waiter.store_id);
          req.merchantId = Number(waiter.merchant_id);
          req.isWaiter = true;
          req.isAdmin = false;
          const expiresTime = new Date(session.expires_at).getTime();
          if (expiresTime - Date.now() < 60 * 60 * 1000) {
            const wTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
            const configuredWaiterTimeoutHours = Number(wTimeoutSetting?.value ?? 12);
            const wTimeoutHours = Number.isSafeInteger(configuredWaiterTimeoutHours) && configuredWaiterTimeoutHours > 0
              ? Math.min(configuredWaiterTimeoutHours, 720) : 12;
            const newExpires = new Date(Date.now() + wTimeoutHours * 60 * 60 * 1000).toISOString();
            runAsync('UPDATE waiter_sessions SET expires_at=? WHERE token_hash=?', [newExpires, token]).catch(() => {});
          }
          return next();
        }
      }
    }
    return res.status(401).json({ error: '无操作权限' });
  } catch (_) {
    return respondAuthUnavailable(res, 'requireAdminOrWaiter');
  }
}

module.exports = {
  getWaiterFromRequest,
  getCashierFromRequest,
  authenticateAdmin,
  requireAdminKey,
  requirePermission,
  logAudit,
  logAuditStrict,
  requireAdminOrWaiter,
};
