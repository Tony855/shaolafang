/* routes/menu-zip.js — 菜单 ZIP 打包导入导出 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, upload, UPLOAD_DIR } = deps;

  app.get('/api/admin/menu/export-zip', requireAdminKey, async (req, res) => {
    try {
      const storeId = req.storeId || 1;
      const menus = await allAsync('SELECT * FROM menus WHERE store_id=? ORDER BY id', [storeId]);
      const categories = await allAsync('SELECT name, sort FROM menu_categories WHERE store_id=? ORDER BY sort, id', [storeId]);
      const zip = new AdmZip();
      const payload = {
        format: 'foodflow-menu', version: 1,
        exportedAt: new Date().toISOString(), storeId,
        categories: categories.map(c => c.name),
        menus: menus.map(m => ({
          name: m.name, name_en: m.name_en || '', emoji: m.emoji || '',
          price: Number(m.price), category: m.category || '',
          desc: m.desc || '', desc_en: m.desc_en || '', unit: m.unit || '份',
          currency_code: m.currency_code || 'USD',
          show_dual: m.show_dual || 0,
          secondary_currency_code: m.secondary_currency_code || '',
          active: m.active, image: m.image || ''
        }))
      };
      zip.addFile('menu.json', Buffer.from(JSON.stringify(payload, null, 2), 'utf8'));
      for (const m of menus) {
        if (!m.image) continue;
        const fp = path.join(UPLOAD_DIR, m.image);
        if (fs.existsSync(fp)) zip.addLocalFile(fp, 'images');
      }
      const buf = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="menu-store' + storeId + '-' + new Date().toISOString().slice(0,10) + '.zip"');
      res.setHeader('Content-Length', buf.length);
      res.send(buf);
    } catch (e) {
      console.error('export-zip failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/admin/menu/import-zip', requireAdminKey, requirePermission('can_manage_menu'), upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: '请上传 ZIP 文件' });
      const zipPath = req.file.path;
      let zip;
      try { zip = new AdmZip(zipPath); }
      catch (e) { try { fs.unlinkSync(zipPath); } catch (_) {} return res.status(400).json({ error: 'ZIP 解压失败：' + e.message }); }

      const jsonEntry = zip.getEntry('menu.json');
      if (!jsonEntry) { try { fs.unlinkSync(zipPath); } catch (_) {} return res.status(400).json({ error: 'ZIP 内缺少 menu.json' }); }
      let payload;
      try { payload = JSON.parse(jsonEntry.getData().toString('utf8')); }
      catch (e) { try { fs.unlinkSync(zipPath); } catch (_) {} return res.status(400).json({ error: 'menu.json 解析失败：' + e.message }); }
      const items = Array.isArray(payload.menus) ? payload.menus : [];
      if (!items.length) { try { fs.unlinkSync(zipPath); } catch (_) {} return res.status(400).json({ error: 'ZIP 内没有菜品数据' }); }

      const imageMap = {};
      const uploadsAbs = path.resolve(UPLOAD_DIR);
      zip.getEntries().forEach(entry => {
        const name = entry.entryName;
        if (!name.startsWith('images/') || entry.isDirectory) return;
        const base = path.basename(name);
        if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(base)) return;
        const newName = 'zip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + path.extname(base).toLowerCase();
        const dest = path.join(uploadsAbs, newName);
        if (!path.resolve(dest).startsWith(uploadsAbs)) return;
        try { fs.writeFileSync(dest, entry.getData()); imageMap[base] = newName; }
        catch (e) { console.warn('[import-zip] 写图片失败:', base, e.message); }
      });

      const cats = [...new Set(items.map(it => String(it.category || '').trim()).filter(Boolean))];
      const createdCategories = [];
      for (const cat of cats) {
        const exists = await getAsync('SELECT id FROM menu_categories WHERE name=? AND store_id=?', [cat, req.storeId || 1]);
        if (!exists) {
          const mx = await getAsync('SELECT MAX(sort) as max FROM menu_categories WHERE store_id=?', [req.storeId || 1]);
          const nextSort = (mx && mx.max !== null) ? mx.max + 1 : 0;
          try { await runAsync('INSERT INTO menu_categories (name, sort, store_id, merchant_id) VALUES (?, ?, ?, ?)', [cat, nextSort, req.storeId || 1, req.merchantId]); createdCategories.push(cat); } catch (e) {}
        }
      }

      let success = 0, failed = 0;
      const errors = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        try {
          if (!it.name || it.price === undefined) { failed++; errors.push('第 ' + (i+1) + ' 行：name/price 必填'); continue; }
          let imageName = '';
          const rawImg = String(it.image || '').trim();
          if (rawImg) {
            const base = path.basename(rawImg);
            imageName = imageMap[base] || (fs.existsSync(path.join(UPLOAD_DIR, base)) ? base : '');
          }
          const ex = await getAsync('SELECT id FROM menus WHERE name=? AND store_id=?', [it.name, req.storeId || 1]);
          const base10 = [it.emoji || '🍽️', parseFloat(it.price), it.category || '其他', it.desc || '', it.currency_code || 'USD', it.name_en || '', it.desc_en || '', it.unit || '份', it.show_dual ? 1 : 0, it.secondary_currency_code || ''];
          const activeVal = it.active === 0 ? 0 : 1;
          if (ex) {
            if (imageName) {
              await runAsync('UPDATE menus SET emoji=?, price=?, category=?, `desc`=?, currency_code=?, name_en=?, desc_en=?, unit=?, show_dual=?, secondary_currency_code=?, active=?, image=? WHERE id=? AND store_id=?', [...base10, activeVal, imageName, ex.id, req.storeId || 1]);
            } else {
              await runAsync('UPDATE menus SET emoji=?, price=?, category=?, `desc`=?, currency_code=?, name_en=?, desc_en=?, unit=?, show_dual=?, secondary_currency_code=?, active=? WHERE id=? AND store_id=?', [...base10, activeVal, ex.id, req.storeId || 1]);
            }
          } else {
            await runAsync('INSERT INTO menus (emoji, price, category, `desc`, currency_code, name_en, desc_en, unit, show_dual, secondary_currency_code, active, image, name, store_id, merchant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...base10, activeVal, imageName, it.name, req.storeId || 1, req.merchantId]);
          }
          success++;
        } catch (e) { failed++; errors.push('第 ' + (i+1) + ' 行：' + e.message); }
      }

      try { fs.unlinkSync(zipPath); } catch (_) {}
      res.json({ success, failed, errors, createdCategories, imagesImported: Object.keys(imageMap).length });
    } catch (e) {
      console.error('import-zip failed:', e);
      res.status(500).json({ error: e.message });
    }
  });
};
