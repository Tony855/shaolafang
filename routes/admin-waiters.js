/* ============================================================
   routes/admin-waiters.js — 服务员 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, hashPassword } = deps;

  app.get('/api/admin/waiters', requireAdminKey, async (req, res) => {
    try {
      const rows = await allAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE store_id=? ORDER BY id', [req.storeId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/waiters', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
    try {
      const { username, password, display_name, can_order, can_mark_item, can_complete_order, store_id } = req.body || {};
      if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写服务员资料' });
      const targetStoreId = store_id || req.storeId || 1;
      const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
      if (!store) return res.status(400).json({ error: '店铺不存在' });
      const result = await runAsync(
        'INSERT INTO waiters (username, password_hash, display_name, can_order, can_mark_item, can_complete_order, store_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [String(username).trim(), hashPassword(password), display_name, can_order ? 1 : 0, can_mark_item ? 1 : 0, can_complete_order ? 1 : 0, targetStoreId]
      );
      res.status(201).json(await getAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=?', [result.lastID]));
    } catch (e) {
      if (String(e.message).includes('Duplicate entry')) return res.status(409).json({ error: '服务员账号已存在' });
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT * FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '服务员不存在' });
      const next = { ...current, ...req.body };
      await runAsync(
        'UPDATE waiters SET username=?, display_name=?, can_order=?, can_mark_item=?, can_complete_order=?, active=? WHERE id=? AND store_id=?',
        [String(next.username||current.username).trim(), next.display_name||current.display_name, next.can_order?1:0, next.can_mark_item?1:0, next.can_complete_order?1:0, next.active?1:0, id, req.storeId]
      );
      if (req.body.password) await runAsync('UPDATE waiters SET password_hash=? WHERE id=? AND store_id=?', [hashPassword(req.body.password), id, req.storeId]);
      res.json(await getAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT id FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '服务员不存在' });
      await runAsync('DELETE FROM waiters WHERE id=? AND store_id=?', [id, req.storeId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
