/* ============================================================
   routes/admin-system.js — 系统日志 + 改密码
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, withTransaction, requireAdminKey, requirePermission, verifyPassword, hashPassword, logAudit, getClientIp } = deps;

  app.get('/api/admin/login-logs', requireAdminKey, requirePermission('can_view_logs'), async (req, res) => {
    try {
      const merchantId = req.merchantId || 1;
      const rows = await allAsync('SELECT * FROM login_logs WHERE merchant_id = ? ORDER BY id DESC LIMIT 200', [merchantId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.get('/api/admin/audit-logs', requireAdminKey, requirePermission('can_view_logs'), async (req, res) => {
    try {
      const rows = await allAsync(
        "SELECT id, actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at FROM audit_logs WHERE actor_type='merchant_admin' AND actor_id IN (SELECT id FROM merchant_admins WHERE merchant_id=?) ORDER BY id DESC LIMIT 200",
        [req.merchantId]
      );
      res.json(rows);
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/admin/change-password', requireAdminKey, async (req, res) => {
    try {
      const oldPassword = typeof req.body?.oldPassword === 'string' ? req.body.oldPassword : '';
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      const adminId = Number(req.adminId);
      const merchantId = Number(req.merchantId);
      if (!oldPassword || newPassword.length < 12 || newPassword.length > 128) {
        return res.status(400).json({ error: '请提供旧密码和新密码（新密码长度为 12 至 128 个字符）' });
      }
      if (!Number.isSafeInteger(adminId) || adminId <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '管理员或商户信息无效' });
      }
      await withTransaction(async () => {
        const admin = await getAsync(
          'SELECT id, username, password_hash FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE',
          [adminId, merchantId]
        );
        if (!admin || !verifyPassword(oldPassword, admin.password_hash)) {
          throw Object.assign(new Error('旧密码错误或管理员账号已停用'), { status: 401 });
        }
        await runAsync('UPDATE merchant_admins SET password_hash=? WHERE id=? AND merchant_id=?', [hashPassword(newPassword), adminId, merchantId]);
        await runAsync('DELETE FROM admin_sessions WHERE admin_id=? AND token<>?', [adminId, req.adminSessionToken || '']);
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['merchant_admin', adminId, admin.username, 'change_password', 'merchant_admin', adminId,
            '修改管理员密码', getClientIp(req), new Date().toISOString()]
        );
      });
      res.json({ success: true, message: '密码已更新' });
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '修改密码失败，所有更改已回滚' }); }
  });
};
