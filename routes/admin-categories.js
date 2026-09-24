/* ============================================================
   routes/admin-categories.js — 菜品分类 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, withTransaction, requireAdminKey, requirePermission } = deps;

  app.get('/api/menu-categories', requireAdminKey, async (req, res) => {
    try {
      const rows = await allAsync('SELECT * FROM menu_categories WHERE store_id=? ORDER BY sort, id', [req.storeId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/menu-categories', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '分类名称必填' });
      const maxSort = await getAsync('SELECT MAX(sort) as max FROM menu_categories WHERE store_id=?', [req.storeId]);
      const nextSort = (maxSort && maxSort.max !== null) ? maxSort.max + 1 : 0;
      const result = await runAsync('INSERT INTO menu_categories (name, sort, store_id) VALUES (?, ?, ?)', [name, nextSort, req.storeId]);
      const row = await getAsync('SELECT * FROM menu_categories WHERE id = ? AND store_id = ?', [result.lastID, req.storeId]);
      res.status(201).json(row);
    } catch (e) {
      if (String(e.message).includes('Duplicate entry')) return res.status(409).json({ error: '分类已存在' });
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/menu-categories/:id', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '分类名称必填' });
      const current = await getAsync('SELECT name FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '分类不存在' });
      await withTransaction(async () => {
        await runAsync('UPDATE menu_categories SET name=? WHERE id=? AND store_id=?', [name, id, req.storeId]);
        await runAsync('UPDATE menus SET category=? WHERE category=? AND store_id=?', [name, current.name, req.storeId]);
      });
      res.json(await getAsync('SELECT * FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]));
    } catch (e) {
      if (String(e.message).includes('Duplicate entry')) return res.status(409).json({ error: '分类已存在' });
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/menu-categories/:id', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT name FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '分类不存在' });
      const remaining = await getAsync("SELECT name FROM menu_categories WHERE id != ? AND store_id = ? ORDER BY sort, id LIMIT 1", [id, req.storeId]);
      const fallback = remaining ? remaining.name : '其他';
      await withTransaction(async () => {
        if (!remaining) await runAsync("INSERT IGNORE INTO menu_categories (name, sort, store_id) VALUES ('其他', 0, ?)", [req.storeId]);
        await runAsync('DELETE FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]);
        await runAsync('UPDATE menus SET category=? WHERE category=? AND store_id=?', [fallback, current.name, req.storeId]);
      });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
