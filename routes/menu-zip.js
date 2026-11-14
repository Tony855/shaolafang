const { safeErrorMetadata } = require('../server/middleware/safe-error-metadata');
/* routes/menu-zip.js — 菜单 ZIP 打包导入导出 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { openZipArchive, readEntryBuffer, extractEntryToFile } = require('../server/services/safe-zip');
const { cleanupUnreferencedImages } = require('../server/services/menu-zip-image-cleanup');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, upload, UPLOAD_DIR } = deps;

  app.get('/api/admin/menu/export-zip', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
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
        const imageName = path.basename(String(m.image));
        const uploadRoot = path.resolve(UPLOAD_DIR);
        const fp = path.resolve(uploadRoot, imageName);
        if (fp.startsWith(uploadRoot + path.sep) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
          try {
            const realRoot = fs.realpathSync(uploadRoot);
            const realFile = fs.realpathSync(fp);
            if (realFile.startsWith(realRoot + path.sep)) zip.addLocalFile(realFile, 'images');
          } catch (_) {}
        }
      }
      const buf = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="menu-store' + storeId + '-' + new Date().toISOString().slice(0,10) + '.zip"');
      res.setHeader('Content-Length', buf.length);
      res.send(buf);
    } catch (e) {
      console.error('export-zip failed:', e);
      res.status(500).json({ error: '请求失败，请稍后重试' });
    }
  });

  app.post('/api/admin/menu/import-zip', requireAdminKey, requirePermission('can_manage_menu'), upload.single('file'), async (req, res) => {
    const createdImagePaths = new Set();
    const retainedImagePaths = new Set();
    try {
      if (!req.file) return res.status(400).json({ error: '请上传 ZIP 文件' });
      const zipPath = req.file.path;
      if (fs.statSync(zipPath).size > 50 * 1024 * 1024) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(413).json({ error: 'ZIP 文件超过 50MB 限制' });
      }
      let zip;
      try { zip = openZipArchive(zipPath, { maxEntries: 2000 }); }
      catch (e) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(e.status === 413 ? 413 : 400).json({ error: e.status === 413 ? 'ZIP 结构或条目数量超过资源限制' : 'ZIP 文件结构无效：' + e.message });
      }
      const zipEntries = zip.entries;
      if (zipEntries.length > 2000) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(413).json({ error: 'ZIP 文件条目数量超过 2000' });
      }
      let expandedBytes = 0;
      for (const entry of zipEntries) {
        const entrySize = Number(entry.header?.size || 0);
        if (entrySize > 20 * 1024 * 1024) {
          try { fs.unlinkSync(zipPath); } catch (_) {}
          return res.status(413).json({ error: 'ZIP 内单个文件超过 20MB 限制' });
        }
        expandedBytes += entrySize;
        if (expandedBytes > 100 * 1024 * 1024) {
          try { fs.unlinkSync(zipPath); } catch (_) {}
          return res.status(413).json({ error: 'ZIP 解压总量超过 100MB 限制' });
        }
      }

      const jsonEntry = zipEntries.find(entry => entry.entryName === 'menu.json');
      if (jsonEntry && Number(jsonEntry.header?.size || 0) > 5 * 1024 * 1024) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(413).json({ error: 'menu.json 超过 5MB 限制' });
      }
      if (!jsonEntry) { try { fs.unlinkSync(zipPath); } catch (_) {} return res.status(400).json({ error: 'ZIP 内缺少 menu.json' }); }
      let payload;
      let actualExpandedBytes = 0;
      try {
        const menuBuffer = await readEntryBuffer(zipPath, jsonEntry, 5 * 1024 * 1024);
        actualExpandedBytes += menuBuffer.length;
        if (actualExpandedBytes > 100 * 1024 * 1024) throw Object.assign(new Error('ZIP 解压总量超过 100MB 限制'), { status: 413 });
        payload = JSON.parse(menuBuffer.toString('utf8'));
      } catch (e) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(e.status === 413 ? 413 : 400).json({ error: e.status === 413 ? 'ZIP 解压总量超过 100MB 限制' : 'menu.json 解析失败或 CRC 校验失败' });
      }
      if (!payload || payload.format !== 'foodflow-menu' || payload.version !== 1) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(400).json({ error: '不支持的菜单 ZIP 格式或版本' });
      }
      const items = Array.isArray(payload.menus) ? payload.menus : [];
      if (items.length > 2000) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(413).json({ error: '单个 ZIP 最多导入 2000 个菜品' });
      }
      if (!items.length) { try { fs.unlinkSync(zipPath); } catch (_) {} return res.status(400).json({ error: 'ZIP 内没有菜品数据' }); }
      if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        try { fs.unlinkSync(zipPath); } catch (_) {}
        return res.status(400).json({ error: 'ZIP 菜单中存在无效菜品对象' });
      }

      const imageMap = {};
      const uploadsAbs = path.resolve(UPLOAD_DIR);
      for (const entry of zipEntries) {
        const normalizedName = String(entry.entryName || '').replace(/\\/g, '/');
        const segments = normalizedName.split('/');
        if (!normalizedName.startsWith('images/') || entry.isDirectory || segments.includes('..') || normalizedName.startsWith('/')) continue;
        const base = path.basename(normalizedName);
        if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(base)) continue;
        if (Number(entry.header?.size || 0) > 15 * 1024 * 1024) continue;
        const newName = 'zip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + path.extname(base).toLowerCase();
        const dest = path.resolve(uploadsAbs, newName);
        if (!dest.startsWith(uploadsAbs + path.sep)) continue;
        try {
          const extractedBytes = await extractEntryToFile(zipPath, entry, dest, 15 * 1024 * 1024);
          actualExpandedBytes += extractedBytes;
          if (actualExpandedBytes > 100 * 1024 * 1024) {
            try { fs.unlinkSync(dest); } catch (_) {}
            throw Object.assign(new Error('ZIP 解压总量超过 100MB 限制'), { status: 413 });
          }
          createdImagePaths.add(dest);
          imageMap[base] = newName;
        }
        catch (e) {
          if (e.status === 413) throw e;
          console.warn('[import-zip] 写图片失败:', base, e.message);
        }
      }

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
          const itemName = typeof it.name === 'string' ? it.name.trim() : '';
          const itemPrice = typeof it.price === 'number' || typeof it.price === 'string' ? Number(it.price) : NaN;
          const itemCurrency = String(it.currency_code || 'USD').trim().toUpperCase();
          if (!itemName || itemName.length > 120 || !Number.isFinite(itemPrice) || itemPrice <= 0 || itemPrice > 10000000) {
            failed++; errors.push('第 ' + (i+1) + ' 行：菜品名称或价格无效'); continue;
          }
          if (!itemCurrency || itemCurrency.length > 10) {
            failed++; errors.push('第 ' + (i+1) + ' 行：货币代码无效'); continue;
          }
          const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [itemCurrency, req.merchantId]);
          if (!currency) {
            failed++; errors.push('第 ' + (i+1) + ' 行：货币 ' + itemCurrency + ' 不存在'); continue;
          }
          let imageName = '';
          const rawImg = String(it.image || '').trim();
          if (rawImg) {
            const base = path.basename(rawImg.replace(/\\/g, '/'));
            if (imageMap[base]) {
              imageName = imageMap[base];
            } else {
              const uploadRoot = path.resolve(UPLOAD_DIR);
              const candidate = path.resolve(uploadRoot, base);
              if (candidate.startsWith(uploadRoot + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                try {
                  const realRoot = fs.realpathSync(uploadRoot);
                  const realCandidate = fs.realpathSync(candidate);
                  if (realCandidate.startsWith(realRoot + path.sep)) imageName = path.basename(realCandidate);
                } catch (_) {}
              }
            }
          }
          const ex = await getAsync('SELECT id FROM menus WHERE name=? AND store_id=?', [itemName, req.storeId || 1]);
          const base10 = [String(it.emoji || '🍽️').slice(0, 16), itemPrice, String(it.category || '其他').trim().slice(0, 80), String(it.desc || '').slice(0, 1000), itemCurrency, String(it.name_en || '').slice(0, 120), String(it.desc_en || '').slice(0, 1000), String(it.unit || '份').slice(0, 20), it.show_dual ? 1 : 0, String(it.secondary_currency_code || '').slice(0, 10)];
          const activeVal = it.active === 0 ? 0 : 1;
          if (ex) {
            if (imageName) {
              await runAsync('UPDATE menus SET emoji=?, price=?, category=?, `desc`=?, currency_code=?, name_en=?, desc_en=?, unit=?, show_dual=?, secondary_currency_code=?, active=?, image=? WHERE id=? AND store_id=?', [...base10, activeVal, imageName, ex.id, req.storeId || 1]);
            } else {
              await runAsync('UPDATE menus SET emoji=?, price=?, category=?, `desc`=?, currency_code=?, name_en=?, desc_en=?, unit=?, show_dual=?, secondary_currency_code=?, active=? WHERE id=? AND store_id=?', [...base10, activeVal, ex.id, req.storeId || 1]);
            }
          } else {
            await runAsync('INSERT INTO menus (emoji, price, category, `desc`, currency_code, name_en, desc_en, unit, show_dual, secondary_currency_code, active, image, name, store_id, merchant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...base10, activeVal, imageName, itemName, req.storeId || 1, req.merchantId]);
          }
          const importedImagePath = imageName ? path.resolve(uploadsAbs, imageName) : '';
          if (importedImagePath && createdImagePaths.has(importedImagePath)) {
            retainedImagePaths.add(importedImagePath);
          }
          success++;
        } catch (e) { failed++; errors.push('第 ' + (i+1) + ' 行：' + e.message); }
      }

      // Keep only newly extracted images referenced by rows that were actually saved.
      cleanupUnreferencedImages(createdImagePaths, retainedImagePaths);
      try { fs.unlinkSync(zipPath); } catch (_) {}
      res.json({ success, failed, errors, createdCategories, imagesImported: Object.keys(imageMap).length });
    } catch (e) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      // Preserve files already referenced by successfully committed menu rows;
      // remove every other extracted file when the import aborts unexpectedly.
      cleanupUnreferencedImages(createdImagePaths, retainedImagePaths);
      if (e.status === 413) {
        return res.status(413).json({ error: 'ZIP 解压内容超过资源限制' });
      }
      console.error('import-zip failed', safeErrorMetadata(e));
      res.status(500).json({ error: '请求失败，请稍后重试' });
    }
  });
};
