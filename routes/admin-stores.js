/* ============================================================
   routes/admin-stores.js — 店铺 CRUD + 复制菜单
   ============================================================ */
const path = require('path');
const fs = require('fs');

module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, UPLOAD_DIR } = deps;

  app.get('/api/admin/stores', requireAdminKey, async (req, res) => {
    try {
      res.json(await allAsync('SELECT * FROM stores WHERE merchant_id=? ORDER BY id', [req.merchantId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/stores', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const { name, code, address } = req.body || {};
      if (!name) return res.status(400).json({ error: '店铺名称必填' });
      const merchantId = req.merchantId || 1;
      const merchant = await getAsync('SELECT * FROM merchants WHERE id=?', [merchantId]);
      const storeCount = await getAsync('SELECT COUNT(*) as count FROM stores WHERE merchant_id=?', [merchantId]);
      if (merchant && storeCount.count >= merchant.max_stores) {
        return res.status(403).json({ error: '已达到门店数量上限（' + merchant.max_stores + '家），请联系超级管理员升级' });
      }
      const result = await runAsync('INSERT INTO stores (name, code, address, active, merchant_id) VALUES (?, ?, ?, 1, ?)', [name, code || '', address || '', merchantId]);
      res.status(201).json(await getAsync('SELECT * FROM stores WHERE id=?', [result.lastID]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/stores/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]);
      if (!current) return res.status(404).json({ error: '店铺不存在' });
      const qrLanguages = req.body.qr_languages !== undefined ? (req.body.qr_languages || null) : current.qr_languages;
      await runAsync('UPDATE stores SET name=?, code=?, address=?, active=?, qr_languages=? WHERE id=? AND merchant_id=?', [req.body.name || current.name, req.body.code || current.code, req.body.address ?? current.address, req.body.active === undefined ? current.active : (req.body.active ? 1 : 0), qrLanguages, id, req.merchantId]);
      res.json(await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/stores/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]);
      if (!current) return res.status(404).json({ error: '店铺不存在' });
      if (id === 1) return res.status(400).json({ error: '默认总店不能删除' });
      await runAsync('DELETE FROM stores WHERE id=? AND merchant_id=?', [id, req.merchantId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/stores/:id/copy-menu', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const targetStoreId = parseInt(req.params.id);
      const targetStore = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
      if (!targetStore) return res.status(404).json({ error: '店铺不存在' });
      const sourceStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [req.merchantId]);
      if (!sourceStore) return res.status(400).json({ error: '未找到源店铺' });
      const sourceStoreId = sourceStore.id;
      if (targetStoreId === sourceStoreId) return res.status(400).json({ error: '总店无需复制自身' });
      const sourceMenus = await allAsync('SELECT * FROM menus WHERE store_id = ? AND merchant_id=?', [sourceStoreId, req.merchantId]);
      if (sourceMenus.length === 0) return res.status(404).json({ error: '总店暂无菜品可复制' });
      const existingMenus = await allAsync('SELECT name FROM menus WHERE store_id = ?', [targetStoreId]);
      const existingNames = new Set(existingMenus.map(m => m.name));
      const menusToCopy = sourceMenus.filter(menu => !existingNames.has(menu.name));
      if (menusToCopy.length === 0) return res.json({ success: true, copied: 0, message: '目标店铺已包含全部菜品，无需复制' });
      let copiedCount = 0;
      for (const menu of menusToCopy) {
        let newImage = '';
        if (menu.image) {
          const srcPath = path.join(UPLOAD_DIR, menu.image);
          if (fs.existsSync(srcPath)) {
            const ext = path.extname(menu.image);
            const newFilename = Date.now() + '_' + Math.random().toString(36).slice(2,6) + ext;
            const destPath = path.join(UPLOAD_DIR, newFilename);
            fs.copyFileSync(srcPath, destPath);
            newImage = newFilename;
          }
        }
        await runAsync(
          `INSERT INTO menus (name, emoji, price, category, \`desc\`, image, currency_code, name_en, desc_en, active, unit, show_dual, secondary_currency_code, store_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [menu.name, menu.emoji, menu.price, menu.category, menu.desc, newImage || menu.image,
           menu.currency_code || 'USD', menu.name_en || '', menu.desc_en || '',
           menu.active !== undefined ? menu.active : 1, menu.unit || '份',
           menu.show_dual || 0, menu.secondary_currency_code || '', targetStoreId]
        );
        copiedCount++;
      }
      res.json({ success: true, copied: copiedCount, skipped: sourceMenus.length - copiedCount, message: `成功复制 ${copiedCount} 道菜品` });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
