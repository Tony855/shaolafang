/* ============================================================
   routes/admin-menu.js — 菜品 CRUD + 公开菜单
   ============================================================ */
const path = require('path');
const fs = require('fs');

module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, upload, UPLOAD_DIR } = deps;

  app.get('/api/menu', async (req, res) => {
    try {
      const storeId = parseInt(req.query.store_id || '1', 10);
      const rows = await allAsync('SELECT * FROM menus WHERE active = 1 AND store_id = ? ORDER BY id', [storeId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/menu', requireAdminKey, async (req, res) => {
    try {
      const rows = await allAsync('SELECT * FROM menus WHERE store_id=? ORDER BY id', [req.storeId || 1]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/menu', requireAdminKey, requirePermission('can_manage_menu'), upload.single('image'), async (req, res) => {
    try {
      const { name, emoji, price, category, desc, name_en, desc_en, unit, show_dual, secondary_currency_code, currency_code = 'USD' } = req.body;
      if (!name || !price) return res.status(400).json({ error: '名称和价格必填' });
      const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [currency_code, req.merchantId]);
      if (!currency) return res.status(400).json({ error: '货币类型不存在' });
      const image = req.file ? req.file.filename : '';
      const result = await runAsync(
        'INSERT INTO menus (name, emoji, price, category, `desc`, image, currency_code, name_en, desc_en, unit, show_dual, secondary_currency_code, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, emoji || '🍽️', parseFloat(price), category || '其他', desc || '', image, currency_code, name_en || '', desc_en || '', unit || '份', show_dual ? 1 : 0, secondary_currency_code || '', req.storeId || 1]
      );
      const newItem = await getAsync('SELECT * FROM menus WHERE id = ?', [result.lastID]);
      res.status(201).json(newItem);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/menu/:id', requireAdminKey, requirePermission('can_manage_menu'), upload.single('image'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { name, emoji, price, category, desc, name_en, desc_en, unit, show_dual, secondary_currency_code, currency_code } = req.body;
      const current = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '菜品不存在' });
      const nextCurrency = currency_code || current.currency_code || 'USD';
      const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [nextCurrency, req.merchantId]);
      if (!currency) return res.status(400).json({ error: '货币类型不存在' });
      let image = req.file ? req.file.filename : current.image;
      if (req.file && current.image) {
        const oldPath = path.join(UPLOAD_DIR, current.image);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      await runAsync(
        'UPDATE menus SET name=?, emoji=?, price=?, category=?, `desc`=?, image=?, currency_code=?, name_en=?, desc_en=?, unit=?, show_dual=?, secondary_currency_code=? WHERE id=? AND store_id=?',
        [name || current.name, emoji || current.emoji, Number.isFinite(Number(price)) ? Number(price) : current.price, category || current.category, desc ?? current.desc, image, nextCurrency, name_en ?? current.name_en ?? '', desc_en ?? current.desc_en ?? '', unit || current.unit || '份', show_dual === undefined ? (current.show_dual || 0) : (show_dual ? 1 : 0), secondary_currency_code ?? current.secondary_currency_code ?? '', id, req.storeId]
      );
      const updated = await getAsync('SELECT * FROM menus WHERE id = ?', [id]);
      res.json(updated);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/menu/:id', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const item = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
      if (!item) return res.status(404).json({ error: '菜品不存在' });
      if (item.image) {
        const imgPath = path.join(UPLOAD_DIR, item.image);
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
      }
      await runAsync('DELETE FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/menu/:id/status', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const item = await getAsync('SELECT id FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
      if (!item) return res.status(404).json({ error: '菜品不存在' });
      const active = req.body.active ? 1 : 0;
      await runAsync('UPDATE menus SET active=? WHERE id=? AND store_id=?', [active, id, req.storeId]);
      res.json(await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
