/* ============================================================
   routes/admin-printers.js — 打印机 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission } = deps;

  app.get('/api/admin/printers', requireAdminKey, async (req, res) => {
    try {
      const rows = await allAsync('SELECT * FROM printers WHERE store_id=? ORDER BY id', [req.storeId || 1]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/printers', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const { name, type, ip_address, port, paper_width, brand, is_default } = req.body || {};
      if (!name) return res.status(400).json({ error: '打印机名称必填' });
      if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [req.storeId || 1]);
      const result = await runAsync(
        'INSERT INTO printers (name, type, ip_address, port, paper_width, brand, is_default, active, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
        [name, type || 'network', ip_address || '', port || 9100, paper_width || 58, brand || 'generic', is_default ? 1 : 0, req.storeId || 1]
      );
      res.status(201).json(await getAsync('SELECT * FROM printers WHERE id=?', [result.lastID]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '打印机不存在' });
      const { name, type, ip_address, port, paper_width, brand, is_default, active } = req.body || {};
      if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [current.store_id]);
      await runAsync(
        'UPDATE printers SET name=?, type=?, ip_address=?, port=?, paper_width=?, brand=?, is_default=?, active=? WHERE id=? AND store_id=?',
        [name || current.name, type || current.type, ip_address ?? current.ip_address, port || current.port, paper_width || current.paper_width, brand || current.brand, is_default !== undefined ? (is_default ? 1 : 0) : current.is_default, active !== undefined ? (active ? 1 : 0) : current.active, id, req.storeId]
      );
      res.json(await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT id FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '打印机不存在' });
      await runAsync('DELETE FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
