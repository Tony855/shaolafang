/* ============================================================
   routes/admin-system.js — 系统日志 + 改密码
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, verifyPassword, hashPassword, logAudit, getClientIp } = deps;

  app.post('/api/admin/logout', requireAdminKey, async (req, res) => {
    try {
      if (req.adminSessionToken) {
        await runAsync('DELETE FROM admin_sessions WHERE token=?', [req.adminSessionToken]).catch(() => {});
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/login-logs', requireAdminKey, async (req, res) => {
    try {
      const merchantId = req.merchantId || 1;
      const rows = await allAsync('SELECT * FROM login_logs WHERE merchant_id = ? ORDER BY id DESC LIMIT 200', [merchantId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/audit-logs', requireAdminKey, requirePermission('can_view_logs'), async (req, res) => {
    try {
      const rows = await allAsync(
        "SELECT id, actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at FROM audit_logs WHERE actor_type='merchant_admin' AND actor_id IN (SELECT id FROM merchant_admins WHERE merchant_id=?) ORDER BY id DESC LIMIT 200",
        [req.merchantId]
      );
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/change-password', requireAdminKey, async (req, res) => {
    try {
      const { oldPassword, newPassword } = req.body;
      if (!oldPassword || !newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: '请提供旧密码和新密码（新密码至少6位）' });
      }
      const admin = await getAsync('SELECT id, username, password_hash FROM merchant_admins WHERE id=?', [req.adminId]);
      if (!admin) return res.status(401).json({ error: '管理员不存在' });
      if (!verifyPassword(oldPassword, admin.password_hash)) return res.status(401).json({ error: '旧密码错误' });
      const hash = hashPassword(newPassword);
      await runAsync('UPDATE merchant_admins SET password_hash=? WHERE id=?', [hash, req.adminId]);
      await logAudit('merchant_admin', req.adminId, admin.username, 'change_password', 'merchant_admin', req.adminId, '修改管理员密码', getClientIp(req));
      res.json({ success: true, message: '密码已更新' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
