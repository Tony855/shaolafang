/* ============================================================
   routes/admin-tables.js — 桌台 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, createTableToken } = deps;

  app.get('/api/tables', async (req, res) => {
    try {
      const storeId = parseInt(req.query.store_id || req.get('X-Store-Id') || '1', 10);
      const rows = await allAsync('SELECT * FROM tables WHERE store_id=? ORDER BY id', [storeId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/tables', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
    try {
      const { name, status } = req.body;
      if (!name) return res.status(400).json({ error: '桌号名称必填' });
      const result = await runAsync('INSERT INTO tables (name, status, store_id) VALUES (?, ?, ?)', [name, status || 'available', req.storeId || 1]);
      await runAsync('UPDATE tables SET qr_token=? WHERE id=?', [createTableToken(), result.lastID]);
      const newTable = await getAsync('SELECT * FROM tables WHERE id = ?', [result.lastID]);
      res.status(201).json(newTable);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/tables/:id', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
    try {
      const id = req.params.id;
      const existing = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
      if (!existing) return res.status(404).json({ error: '桌号不存在' });
      const newName = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
      const newStatus = req.body.status || existing.status;
      if (!newName) return res.status(400).json({ error: '桌号名称不能为空' });
      if (!['available', 'occupied', 'reserved'].includes(newStatus)) {
        return res.status(400).json({ error: '无效的桌号状态' });
      }
      try {
        await runAsync('UPDATE tables SET name=?, status=? WHERE id=? AND store_id=?', [newName, newStatus, id, req.storeId]);
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该桌号名称已存在，请换一个' });
        throw e;
      }
      if (newName !== existing.name) {
        await runAsync("UPDATE orders SET table_name=? WHERE table_name=? AND store_id=? AND status=\"pending\"", [newName, existing.name, req.storeId]);
      }
      const updated = await getAsync('SELECT * FROM tables WHERE id = ?', [id]);
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/tables/:id', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
    try {
      const id = req.params.id;
      const existing = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
      if (!existing) return res.status(404).json({ error: '桌号不存在' });
      const orderCount = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name = ? AND store_id = ? AND status != 'canceled'", [existing.name, req.storeId]);
      if (orderCount.count > 0) return res.status(409).json({ error: '该桌仍有未完成订单，不能删除' });
      await runAsync('DELETE FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
