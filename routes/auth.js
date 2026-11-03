/* ============================================================
   routes/auth.js — 登录/登出
   ============================================================ */
const crypto = require('crypto');
const { hashPassword, needsRehash } = require('../server/middleware/password');

module.exports = function(app, deps) {
  const { getAsync, runAsync, isLoginLocked, recordLoginAttempt, resetLoginAttempts,
          verifyPassword, getClientIp, getLocationByIp, requireAdminKey } = deps;

  app.post('/api/admin/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'merchant_admin', '请输入用户名和密码']);
        return res.status(400).json({ error: '请输入用户名和密码' });
      }
      const lockStatus = await isLoginLocked(username, 'merchant_admin');
      if (lockStatus.locked) return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE username=? AND active=1', [username]);
      if (!admin) {
        await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'merchant_admin', '用户名不存在']);
        recordLoginAttempt(username, 'merchant_admin');
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      const isValid = verifyPassword(password, admin.password_hash);
      if (!isValid) {
        await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'merchant_admin', '密码错误']);
        recordLoginAttempt(username, 'merchant_admin');
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      const merchant = await getAsync('SELECT * FROM merchants WHERE id=?', [admin.merchant_id]);
      if (!merchant || merchant.status !== 1) return res.status(403).json({ error: '商户账号已被禁用，请联系超级管理员' });
      if (needsRehash(admin.password_hash)) {
        const upgradedHash = hashPassword(password);
        await runAsync('UPDATE merchant_admins SET password_hash=? WHERE id=? AND password_hash=?', [upgradedHash, admin.id, admin.password_hash]);
      }
      resetLoginAttempts(username, 'merchant_admin');
      await runAsync('UPDATE merchant_admins SET last_login_at=NOW() WHERE id=?', [admin.id]);
      const clientIp = getClientIp(req);
      const location = await getLocationByIp(clientIp);
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, location, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, location, admin.merchant_id, 'merchant_admin', '商户管理员登录成功: ' + username]);
      const token = crypto.randomBytes(32).toString('hex');
      const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
      const configuredTimeoutMinutes = Number.parseInt(timeoutSetting?.value || '30', 10);
      const timeoutMinutes = Number.isSafeInteger(configuredTimeoutMinutes) && configuredTimeoutMinutes > 0 ? Math.min(configuredTimeoutMinutes, 1440) : 30;
      const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
      await runAsync('INSERT INTO admin_sessions (admin_id, token, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [admin.id, token, expiresAt, new Date().toISOString(), clientIp, req.get('User-Agent') || '']);
      // 该商户的第一个店铺（供前端默认选中）
      const firstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
      const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
      const isPrimary = primaryAdmin && primaryAdmin.id === admin.id;
      res.json({ success: true, token, merchantId: admin.merchant_id, storeId: firstStore ? firstStore.id : null, merchantName: merchant.name, adminId: admin.id, username: admin.username, displayName: admin.display_name, isPrimary,
        permissions: {
          can_manage_menu: isPrimary || admin.can_manage_menu ? 1 : 0,
          can_manage_table: isPrimary || admin.can_manage_table ? 1 : 0,
          can_manage_order: isPrimary || admin.can_manage_order ? 1 : 0,
          can_delete_order: isPrimary || admin.can_delete_order ? 1 : 0,
          can_edit_order: isPrimary || admin.can_edit_order ? 1 : 0,
          can_manage_store: isPrimary || admin.can_manage_store ? 1 : 0,
          can_manage_waiter: isPrimary || admin.can_manage_waiter ? 1 : 0,
          can_manage_currency: isPrimary || admin.can_manage_currency ? 1 : 0,
          can_manage_printer: isPrimary || admin.can_manage_printer ? 1 : 0,
          can_manage_admin: isPrimary || admin.can_manage_admin ? 1 : 0,
          can_view_logs: isPrimary || admin.can_view_logs ? 1 : 0,
          can_manage_cashier: isPrimary || admin.can_manage_cashier ? 1 : 0
        }
      });
    } catch (e) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, message) VALUES (?, 0, ?, ?)', [new Date().toISOString(), getClientIp(req), e.message]).catch(() => {});
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/logout', requireAdminKey, async (req, res) => {
    try {
      if (req.adminSessionToken) {
        await runAsync('DELETE FROM admin_sessions WHERE token=?', [req.adminSessionToken]).catch(() => {});
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
