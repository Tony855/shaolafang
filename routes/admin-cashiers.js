/* ============================================================
   routes/admin-cashiers.js — 收银员 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, runAsync, requireAdminKey, hashPassword, logAudit, getClientIp } = deps;

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

  app.get('/api/admin/cashiers', requireAdminKey, async (req, res) => {
    try {
      const cashiers = await getCashiers(req.storeId);
      const safe = cashiers.map(c => ({ id: c.id, username: c.username, display_name: c.display_name, active: c.active, permissions: c.permissions, created_at: c.created_at }));
      res.json({ cashiers: safe });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/cashiers', requireAdminKey, async (req, res) => {
    try {
      const { username, password, display_name, permissions, active } = req.body || {};
      if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写收银员资料' });
      if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      const cashiers = await getCashiers(req.storeId);
      if (cashiers.find(c => c.username === String(username).trim())) return res.status(400).json({ error: '用户名已存在' });
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
      await saveCashiers(req.storeId, cashiers);
      await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'create_cashier', 'cashier', newCashier.id, '创建收银员: ' + username, getClientIp(req));
      res.status(201).json({ success: true, cashier: { id: newCashier.id, username: newCashier.username, display_name: newCashier.display_name, active: newCashier.active, permissions: newCashier.permissions, created_at: newCashier.created_at } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/cashiers/:id', requireAdminKey, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { display_name, password, permissions, active } = req.body || {};
      const cashiers = await getCashiers(req.storeId);
      const idx = cashiers.findIndex(c => c.id === id);
      if (idx === -1) return res.status(404).json({ error: '收银员不存在' });
      if (display_name !== undefined) cashiers[idx].display_name = display_name;
      if (active !== undefined) cashiers[idx].active = active !== false;
      if (password) {
        if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
        cashiers[idx].password_hash = hashPassword(password);
      }
      if (permissions && typeof permissions === 'object') {
        if (permissions.can_settle !== undefined) cashiers[idx].permissions.can_settle = permissions.can_settle !== false;
        if (permissions.can_cancel !== undefined) cashiers[idx].permissions.can_cancel = permissions.can_cancel !== false;
        if (permissions.can_refund !== undefined) cashiers[idx].permissions.can_refund = permissions.can_refund === true;
        if (permissions.can_view_report !== undefined) cashiers[idx].permissions.can_view_report = permissions.can_view_report !== false;
      }
      await saveCashiers(req.storeId, cashiers);
      await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'update_cashier', 'cashier', id, '更新收银员: ' + cashiers[idx].username, getClientIp(req));
      res.json({ success: true, cashier: { id: cashiers[idx].id, username: cashiers[idx].username, display_name: cashiers[idx].display_name, active: cashiers[idx].active, permissions: cashiers[idx].permissions, created_at: cashiers[idx].created_at } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/cashiers/:id', requireAdminKey, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const cashiers = await getCashiers(req.storeId);
      const idx = cashiers.findIndex(c => c.id === id);
      if (idx === -1) return res.status(404).json({ error: '收银员不存在' });
      const username = cashiers[idx].username;
      cashiers.splice(idx, 1);
      await saveCashiers(req.storeId, cashiers);
      await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'delete_cashier', 'cashier', id, '删除收银员: ' + username, getClientIp(req));
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
