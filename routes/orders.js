/* ============================================================
   routes/orders.js — 订单核心路由
   ============================================================ */
const crypto = require('crypto');
const fs = require('fs');
const { hashPassword, verifyPassword } = require('../server/middleware/password');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.get('/api/waiter/overview', async (req, res) => {
  try {
    const waiter = await getWaiterFromRequest(req);
    if (!waiter) return res.status(401).json({ error: '请先登录服务员账号' });
    const storeId = waiter.store_id || 1;
    const store = await getAsync('SELECT name FROM stores WHERE id=?', [storeId]);
    const tables = await allAsync('SELECT * FROM tables WHERE store_id=? ORDER BY id', [storeId]);
    const rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND status != 'canceled' ORDER BY createdAt DESC", [storeId]);
    res.json({ waiter, storeName: store?.name || '', tables, orders: rows.map(formatOrder) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 服务员管理 -----

async function cashierUsernameExists(username) {
  const rows = await allAsync("SELECT `key`, value FROM settings WHERE `key` LIKE 'cashiers_%'");
  for (const row of rows) {
    try {
      const list = JSON.parse(row.value);
      if (list.find(c => c.username === username)) return true;
    } catch (e) {}
  }
  return false;
}

app.get('/api/admin/waiters', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync(
      `SELECT w.id, w.username, w.display_name, w.can_order, w.can_mark_item, w.can_complete_order, w.active, w.store_id, s.name AS store_name
       FROM waiters w
       LEFT JOIN stores s ON s.id = w.store_id
       WHERE w.merchant_id = ?
       ORDER BY w.store_id, w.id`,
      [req.merchantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/waiters', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const { username, password, display_name, can_order, can_mark_item, can_complete_order, store_id } = req.body || {};
    if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写服务员资料' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    const targetStoreId = store_id || req.storeId || 1;
    const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
    if (!store) return res.status(400).json({ error: '店铺不存在' });
    if (await cashierUsernameExists(String(username).trim())) return res.status(409).json({ error: '该用户名已被收银员账号使用，请换一个' });
    const result = await runAsync(
      'INSERT INTO waiters (username, password_hash, display_name, can_order, can_mark_item, can_complete_order, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [String(username).trim(), hashPassword(password), display_name, can_order ? 1 : 0, can_mark_item ? 1 : 0, can_complete_order ? 1 : 0, targetStoreId, req.merchantId]
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
    const current = await getAsync(
      'SELECT w.* FROM waiters w JOIN stores s ON s.id = w.store_id WHERE w.id=? AND s.merchant_id=?',
      [id, req.merchantId]
    );
    if (!current) return res.status(404).json({ error: '服务员不存在' });

    const targetStoreId = parseInt(req.body.store_id, 10) || current.store_id;
    const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [targetStoreId, req.merchantId]);
    if (!store) return res.status(400).json({ error: '目标店铺不存在或不属于当前商户' });

    const next = { ...current, ...req.body };
    await runAsync(
      'UPDATE waiters SET username=?, display_name=?, can_order=?, can_mark_item=?, can_complete_order=?, active=?, store_id=? WHERE id=?',
      [String(next.username||current.username).trim(), next.display_name||current.display_name, next.can_order?1:0, next.can_mark_item?1:0, next.can_complete_order?1:0, next.active?1:0, targetStoreId, id]
    );
    if (req.body.password) {
      if (req.body.password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      await runAsync('UPDATE waiters SET password_hash=? WHERE id=?', [hashPassword(req.body.password), id]);
    }
    res.json(await getAsync('SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync(
      'SELECT w.* FROM waiters w JOIN stores s ON s.id = w.store_id WHERE w.id=? AND s.merchant_id=?',
      [id, req.merchantId]
    );
    if (!current) return res.status(404).json({ error: '服务员不存在' });
    await runAsync('DELETE FROM waiters WHERE id=?', [id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 店铺管理 -----
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
    const uploadDir = UPLOAD_DIR;
    let copiedCount = 0;
    for (const menu of menusToCopy) {
      let newImage = '';
      if (menu.image) {
        const srcPath = path.join(uploadDir, menu.image);
        if (fs.existsSync(srcPath)) {
          const ext = path.extname(menu.image);
          const newFilename = Date.now() + '_' + Math.random().toString(36).slice(2,6) + ext;
          const destPath = path.join(uploadDir, newFilename);
          fs.copyFileSync(srcPath, destPath);
          newImage = newFilename;
        }
      }
      await runAsync(
        `INSERT INTO menus (name, emoji, price, category, \`desc\`, image, currency_code, name_en, desc_en, active, unit, show_dual, secondary_currency_code, store_id, merchant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          menu.name, menu.emoji, menu.price, menu.category, menu.desc,
          newImage || menu.image,
          menu.currency_code || 'USD',
          menu.name_en || '', menu.desc_en || '',
          menu.active !== undefined ? menu.active : 1,
          menu.unit || '份',
          menu.show_dual || 0,
          menu.secondary_currency_code || '',
          targetStoreId,
          req.merchantId
        ]
      );
      copiedCount++;
    }
    res.json({ success: true, copied: copiedCount, skipped: sourceMenus.length - copiedCount, message: `成功复制 ${copiedCount} 道菜品` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 菜单 -----
app.get('/api/menu', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const rows = await allAsync('SELECT * FROM menus WHERE active = 1 AND store_id = ? ORDER BY id', [storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/menu', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM menus WHERE store_id=? ORDER BY id', [req.storeId || 1]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menu', requireAdminKey, requirePermission('can_manage_menu'), upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  try {
    const { name, emoji, price, category, desc, name_en, desc_en, unit, show_dual, secondary_currency_code, currency_code = 'USD' } = req.body;
    const video = req.files && req.files.video ? req.files.video[0].filename : '';
    if (!name || !price) return res.status(400).json({ error: '名称和价格必填' });
    const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [currency_code, req.merchantId]);
    if (!currency) return res.status(400).json({ error: '货币类型不存在' });
    const image = req.files && req.files.image ? req.files.image[0].filename : '';
    const result = await runAsync(
      'INSERT INTO menus (name, emoji, price, category, `desc`, image, video, currency_code, name_en, desc_en, unit, show_dual, secondary_currency_code, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name, emoji || '🍽️', parseFloat(price), category || '其他', desc || '', image, video || '', currency_code, name_en || '', desc_en || '', unit || '份', show_dual ? 1 : 0, secondary_currency_code || '', req.storeId || 1, req.merchantId]
    );
    const newItem = await getAsync('SELECT * FROM menus WHERE id = ?', [result.lastID]);
    res.status(201).json(newItem);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 批量导入菜品
async function downloadImageToUploads(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//.test(ct)) throw new Error('非图片: ' + ct);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('图片超过5MB');
    const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    const ext = extMap[ct] || '.jpg';
    const filename = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
    const fullPath = path.join(UPLOAD_DIR, filename);
    await fs.promises.writeFile(fullPath, buf);
    return filename;
  } catch (e) {
    console.warn('[batch] 下载图片失败:', url, e.message);
    return null;
  }
}

app.post('/api/menu/batch', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const items = req.body.items;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '导入数据不能为空' });
    
    let success = 0;
    let failed = 0;
    const errors = [];
    const createdCategories = [];

    // 自动创建 CSV 里出现但数据库没有的分类
    const csvCategories = [...new Set(items.map(it => String(it.category || '').trim()).filter(Boolean))];
    for (const cat of csvCategories) {
      const exists = await getAsync('SELECT id FROM menu_categories WHERE name=? AND store_id=?', [cat, req.storeId || 1]);
      if (!exists) {
        const maxSort = await getAsync('SELECT MAX(sort) as max FROM menu_categories WHERE store_id=?', [req.storeId || 1]);
        const nextSort = (maxSort && maxSort.max !== null) ? maxSort.max + 1 : 0;
        try {
          await runAsync('INSERT INTO menu_categories (name, sort, store_id, merchant_id) VALUES (?, ?, ?, ?)', [cat, nextSort, req.storeId || 1, req.merchantId]);
          createdCategories.push(cat);
        } catch (e) { /* 并发重复忽略 */ }
      }
    }
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        if (!item.name || !item.price) {
          failed++;
          errors.push(`第 ${i+1} 行：名称和价格必填`);
          continue;
        }
        const existing = await getAsync('SELECT id FROM menus WHERE name = ? AND store_id = ?', [item.name, req.storeId || 1]);
        if (existing) {
          let updImage = null;
          const updImgRaw = String(item.image || '').trim();
          if (updImgRaw) {
            if (/^https?:\/\//i.test(updImgRaw)) {
              updImage = await downloadImageToUploads(updImgRaw);
            } else {
              const lp = path.join(UPLOAD_DIR, updImgRaw);
              if (fs.existsSync(lp)) updImage = updImgRaw;
            }
          }
          if (updImage) {
            await runAsync(
              'UPDATE menus SET emoji = ?, price = ?, category = ?, `desc` = ?, currency_code = ?, name_en = ?, desc_en = ?, unit = ?, show_dual = ?, secondary_currency_code = ?, image = ? WHERE id = ? AND store_id = ?',
              [
                item.emoji || '🍽️',
                parseFloat(item.price),
                item.category || '其他',
                item.desc || '',
                item.currency_code || 'USD',
                item.name_en || '',
                item.desc_en || '',
                item.unit || '份',
                item.show_dual ? 1 : 0,
                item.secondary_currency_code || '',
                updImage,
                existing.id,
                req.storeId || 1
              ]
            );
          } else {
            await runAsync(
              'UPDATE menus SET emoji = ?, price = ?, category = ?, `desc` = ?, currency_code = ?, name_en = ?, desc_en = ?, unit = ?, show_dual = ?, secondary_currency_code = ? WHERE id = ? AND store_id = ?',
              [
                item.emoji || '🍽️',
                parseFloat(item.price),
                item.category || '其他',
                item.desc || '',
                item.currency_code || 'USD',
                item.name_en || '',
                item.desc_en || '',
                item.unit || '份',
                item.show_dual ? 1 : 0,
                item.secondary_currency_code || '',
                existing.id,
                req.storeId || 1
              ]
            );
          }
        } else {
          // 处理图片：http(s) URL → 下载到 uploads/；否则按已有文件名处理
          let imageName = '';
          const rawImg = String(item.image || '').trim();
          if (rawImg) {
            if (/^https?:\/\//i.test(rawImg)) {
              imageName = await downloadImageToUploads(rawImg) || '';
            } else {
              const localPath = path.join(UPLOAD_DIR, rawImg);
              if (fs.existsSync(localPath)) imageName = rawImg;
            }
          }
          await runAsync(
            'INSERT INTO menus (name, emoji, price, category, `desc`, image, currency_code, name_en, desc_en, unit, show_dual, secondary_currency_code, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              item.name,
              item.emoji || '🍽️',
              parseFloat(item.price),
              item.category || '其他',
              item.desc || '',
              imageName,
              item.currency_code || 'USD',
              item.name_en || '',
              item.desc_en || '',
              item.unit || '份',
              item.show_dual ? 1 : 0,
              item.secondary_currency_code || '',
              req.storeId || 1,
              req.merchantId
            ]
          );
        }
        success++;
      } catch (e) {
        failed++;
        errors.push(`第 ${i+1} 行：${e.message}`);
      }
    }
    
    res.json({ success, failed, errors, createdCategories });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/menu/:id', requireAdminKey, requirePermission('can_manage_menu'), upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, emoji, price, category, desc, name_en, desc_en, unit, show_dual, secondary_currency_code, currency_code } = req.body;
    const current = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '菜品不存在' });
    const nextCurrency = currency_code || current.currency_code || 'USD';
    const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [nextCurrency, req.merchantId]);
    if (!currency) return res.status(400).json({ error: '货币类型不存在' });
    let image = (req.files && req.files.image) ? req.files.image[0].filename : current.image;
    let video = (req.files && req.files.video) ? req.files.video[0].filename : (current.video || '');
    if (req.files && req.files.image && current.image) {
      const oldPath = path.join(UPLOAD_DIR, current.image);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await runAsync(
      'UPDATE menus SET name=?, emoji=?, price=?, category=?, `desc`=?, image=?, video=?, currency_code=?, name_en=?, desc_en=?, unit=?, show_dual=?, secondary_currency_code=? WHERE id=? AND store_id=?',
      [name || current.name, emoji || current.emoji, Number.isFinite(Number(price)) ? Number(price) : current.price, category || current.category, desc ?? current.desc, image, video, nextCurrency, name_en ?? current.name_en ?? '', desc_en ?? current.desc_en ?? '', unit || current.unit || '份', show_dual === undefined ? (current.show_dual || 0) : (show_dual ? 1 : 0), secondary_currency_code ?? current.secondary_currency_code ?? '', id, req.storeId]
    );
    const updated = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/menu/:id/status', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = await getAsync('SELECT id FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!item) return res.status(404).json({ error: '菜品不存在' });
    const active = req.body.active ? 1 : 0;
    await runAsync('UPDATE menus SET active=? WHERE id=? AND store_id=?', [active, id, req.storeId]);
    res.json(await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [id, req.storeId]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 菜品分类 -----
app.get('/api/menu-categories', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM menu_categories WHERE store_id=? ORDER BY sort, id', [req.storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menu-categories', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: '分类名称必填' });
    const maxSort = await getAsync('SELECT MAX(sort) as max FROM menu_categories WHERE store_id=?', [req.storeId]);
    const nextSort = (maxSort && maxSort.max !== null) ? maxSort.max + 1 : 0;
    const result = await runAsync('INSERT INTO menu_categories (name, sort, store_id, merchant_id) VALUES (?, ?, ?, ?)', [name, nextSort, req.storeId, req.merchantId]);
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
    let fallback = remaining ? remaining.name : '其他';
    await withTransaction(async () => {
      if (!remaining) await runAsync("INSERT IGNORE INTO menu_categories (name, sort, store_id) VALUES ('其他', 0, ?)", [req.storeId]);
      await runAsync('DELETE FROM menu_categories WHERE id = ? AND store_id = ?', [id, req.storeId]);
      await runAsync('UPDATE menus SET category=? WHERE category=? AND store_id=?', [fallback, current.name, req.storeId]);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menu-categories/sort', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array' });
    await withTransaction(async () => {
      for (let i = 0; i < ids.length; i++) {
        await runAsync('UPDATE menu_categories SET sort = ? WHERE id = ? AND store_id = ?', [i, ids[i], req.storeId]);
      }
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 桌号 -----
app.get('/api/tables', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || req.get('X-Store-Id') || '1', 10);
    const rows = await allAsync('SELECT * FROM tables WHERE store_id=? ORDER BY id', [storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tables', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
  try {
    const { name, status } = req.body;
    if (!name) return res.status(400).json({ error: '桌号名称必填' });
    const result = await runAsync(
      'INSERT INTO tables (name, status, store_id, merchant_id) VALUES (?, ?, ?, ?)',
      [name, status || 'available', req.storeId || 1, req.merchantId]
    );
    await runAsync('UPDATE tables SET qr_token=? WHERE id=?', [createTableToken(), result.lastID]);
    const newTable = await getAsync('SELECT * FROM tables WHERE id = ?', [result.lastID]);
    res.status(201).json(newTable);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 整桌转移：把整个桌的所有未结算订单转到目标桌 -----
app.post('/api/tables/move', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const fromTable = (req.body?.from_table || '').trim();
    const targetTable = (req.body?.target_table || '').trim();
    if (!fromTable || !targetTable) return res.status(400).json({ error: '请选择源桌和目标桌' });
    if (fromTable === targetTable) return res.status(400).json({ error: '目标桌与当前桌相同' });

    const target = await getAsync('SELECT * FROM tables WHERE name=? AND store_id=?', [targetTable, storeId]);
    if (!target) return res.status(404).json({ error: '目标桌不存在' });

    const nowIso = new Date().toISOString();
    // 查目标桌的有效 session
    const targetSession = await getAsync(
      "SELECT token FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      [targetTable, storeId, nowIso]
    );
    let newToken;
    if (targetSession) {
      newToken = targetSession.token;
    } else {
      newToken = 'auto_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const exp = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      await runAsync(
        'INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
        [targetTable, newToken, exp, nowIso, storeId, storeId]
      );
    }

    // 一次性把所有未结算订单的 table_name 和 session_token 都改过来
    const result = await runAsync(
      "UPDATE orders SET table_name=?, session_token=? WHERE table_name=? AND store_id=? AND status='pending'",
      [targetTable, newToken, fromTable, storeId]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ error: '当前桌没有未结算订单可以转移' });
    }

    // 删除源桌的旧 session
    await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at > ?', [fromTable, storeId, nowIso]);

    await syncTableStatus(fromTable, storeId);
    await syncTableStatus(targetTable, storeId);

    io.to('waiter-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: result.affectedRows });
    io.to('kitchen-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: result.affectedRows });
    io.to('cashier-' + storeId).emit('table:moved', { from: fromTable, to: targetTable, count: result.affectedRows });

    res.json({ success: true, from: fromTable, to: targetTable, count: result.affectedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 转移订单 -----
app.post('/api/orders/:id/transfer', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const orderId = parseInt(req.params.id, 10);
    const targetTable = (req.body?.target_table || '').trim();
    if (!targetTable) return res.status(400).json({ error: '请选择目标桌号' });
    const order = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [orderId, storeId]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'pending') return res.status(400).json({ error: '仅未结算订单可转移' });
    if (order.table_name === targetTable) return res.status(400).json({ error: '目标桌与当前桌相同' });
    const target = await getAsync('SELECT * FROM tables WHERE name=? AND store_id=?', [targetTable, storeId]);
    if (!target) return res.status(404).json({ error: '目标桌不存在' });
    const oldTable = order.table_name;
    const targetPending = await getAsync("SELECT COUNT(*) as cnt FROM orders WHERE table_name=? AND store_id=? AND status='pending'", [targetTable, storeId]);
    const nowIso = new Date().toISOString();
    const targetSession = await getAsync(
      "SELECT token FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      [targetTable, storeId, nowIso]
    );
    let newToken;
    if (targetSession) {
      newToken = targetSession.token;
    } else {
      newToken = 'auto_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const exp = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      await runAsync(
        'INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
        [targetTable, newToken, exp, nowIso, storeId, storeId]
      );
    }
    await runAsync('UPDATE orders SET table_name=?, session_token=? WHERE id=? AND store_id=?', [targetTable, newToken, orderId, storeId]);
    await syncTableStatus(oldTable, storeId);
    await syncTableStatus(targetTable, storeId);
    await runAsync('DELETE FROM scan_sessions WHERE table_name=? AND store_id=? AND expires_at > ?', [oldTable, storeId, new Date().toISOString()]);
    const actorType = req.waiter ? 'waiter' : 'admin';
    const actorName = req.waiter ? req.waiter.display_name : 'admin';
    const logParams = [actorType, 0, actorName, 'transfer_order', JSON.stringify({ order_id: orderId, from: oldTable, to: targetTable }), getClientIp(req) || 'unknown', new Date().toISOString()];
    console.log('[TRANSFER LOG]', JSON.stringify(logParams));
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', logParams);
    io.to('waiter-' + storeId).emit('order:transfer', { orderId, from: oldTable, to: targetTable });
    io.to('kitchen-' + storeId).emit('order:transfer', { orderId, from: oldTable, to: targetTable });
    io.to('cashier-' + storeId).emit('order:transfer', { orderId, from: oldTable, to: targetTable });
    res.json({ success: true, from: oldTable, to: targetTable, targetHasOrders: targetPending ? targetPending.cnt > 0 : false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.put('/api/orders/:id/items/:index', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const index = parseInt(req.params.index);
    const orderStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    if (!req.isAdmin && req.waiter && !req.waiter.can_mark_item) return res.status(403).json({ error: '该服务员没有标记菜品权限' });
    if (row.status === 'done') return res.status(409).json({ error: '已结算订单不能修改菜品状态' });
    let items = row.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch (e) { console.error(`订单 ${id} 的 items 解析失败:`, items, e); items = []; }
    } else if (!Array.isArray(items)) {
      items = [];
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: `该订单暂无菜品，无法切换状态（订单ID: ${id}）` });
    }
    if (index < 0 || index >= items.length) {
      return res.status(400).json({ error: `菜品序号无效，当前共 ${items.length} 道菜品，请求序号 ${index}（从0开始）` });
    }
    if (req.body.returnQty !== undefined && req.body.returnQty !== null) {
      const returnQty = parseInt(req.body.returnQty) || 0;
      const qty = Number(items[index].quantity) || 1;
      if (returnQty < 0 || returnQty > qty) {
        return res.status(400).json({ error: '退回数量无效' });
      }
      items[index].returnedQty = returnQty;
      if (items[index].id) {
        await runAsync('UPDATE menus SET sales_count = GREATEST(0, sales_count - ?) WHERE id = ? AND store_id = ?', [returnQty, items[index].id, orderStoreId]);
      }
      const newTotal = items.reduce((sum, it) => {
        const price = Number(it.base_price || it.price) || 0;
        const q = Number(it.quantity) || 0;
        const rq = Number(it.returnedQty) || 0;
        return sum + price * (q - rq);
      }, 0);
      await runAsync('UPDATE orders SET items=?, total=? WHERE id=? AND store_id=?', [JSON.stringify(items), newTotal, id, orderStoreId]);
      const updatedRow = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
      return res.json(formatOrder(updatedRow));
    }
    if (items[index].itemStatus === 'done' && req.body.itemStatus !== 'done') {
      return res.status(409).json({ error: '已完成菜品不能改回制作中' });
    }
    const nextStatus = req.body.itemStatus === 'done' ? 'done' : 'pending';
    items[index].itemStatus = nextStatus;
    await runAsync('UPDATE orders SET items=? WHERE id=? AND store_id=?', [JSON.stringify(items), id, orderStoreId]);
    const updatedRow = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
    const updatedOrder = formatOrder(updatedRow);
    io.to('kitchen-' + (updatedRow.store_id || 1)).emit('item:updated', { orderId: id, order: updatedOrder });
    io.to('waiter-' + (updatedRow.store_id || 1)).emit('item:updated', { orderId: id, order: updatedOrder });
    io.to('cashier-' + (updatedRow.store_id || 1)).emit('item:updated', { orderId: id, order: updatedOrder });
    io.to('public-store-' + (updatedRow.store_id || 1)).emit('item:updated', { orderId: id, order: updatedOrder });
    res.json(updatedOrder);
  } catch (e) {
    console.error('切换菜品状态失败:', e);
    res.status(500).json({ error: e.message });
  }
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
      if (e && e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: '该桌号名称已存在，请换一个' });
      }
      throw e;
    }
    if (newName !== existing.name) {
      await runAsync("UPDATE orders SET table_name=? WHERE table_name=? AND store_id=? AND status=\"pending\"", [newName, existing.name, req.storeId]);
    }
    const updated = await getAsync('SELECT * FROM tables WHERE id = ? AND store_id = ?', [id, req.storeId]);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 订单列表 -----
app.get('/api/orders', requireAdminOrWaiter, async (req, res) => {
  try {
    let storeId;
    if (req.isAdmin) {
      storeId = req.storeId || 1;
    } else {
      storeId = req.waiterStoreId || 1;
    }
    const status = req.query.status;
    let sql = 'SELECT * FROM orders WHERE store_id=?';
    const params = [storeId];
    if (status) {
      sql += ' AND status=?';
      params.push(status);
    }
    sql += ' ORDER BY createdAt DESC';
    const rows = await allAsync(sql, params);
    const formatted = rows.map(formatOrder);
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:id(\\d+)', requireAdminOrWaiter, async (req, res) => {
  try {
    const orderStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [req.params.id, orderStoreId]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    res.json(formatOrder(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  POST /api/orders（事务包裹 + 订单号序列化 + 结构化错误码）
// ============================================================
app.post('/api/orders', async (req, res) => {
  try {
    // ---------- 1. 认证 ----------
    const adminAuth = await authenticateAdmin(req);
    const adminKey = req.get('X-Admin-Key');
    const keySetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_access_key'");
    const isAdmin = Boolean((adminAuth && !adminAuth.error) || (adminKey && keySetting && adminKey === keySetting.value));
    if (adminAuth && !adminAuth.error) {
      req.adminId = adminAuth.adminId;
      req.merchantId = adminAuth.merchantId;
      req.storeId = adminAuth.storeId;
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, req.merchantId]);
      if (admin) {
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [req.merchantId]);
        const isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
        if (!isPrimaryAdmin && !admin.can_manage_order) {
          return res.status(403).json({ error: '没有下单权限' });
        }
      }
    }
    const waiter = await getWaiterFromRequest(req);
    const isWaiter = Boolean(waiter && waiter.can_order);
    if (waiter && !waiter.can_order) return res.status(403).json({ error: '该服务员没有下单权限' });

    // ---------- 2. 会话/桌号校验 ----------
    let sessionToken = null;
    let customerToken = '';
    let sessionStoreId = null;
    let table;
    if (!isAdmin && !isWaiter) {
      const token = req.body.sessionToken || null;
      customerToken = req.body.customerToken || '';
      if (!token) return res.status(401).json({ error: '请重新扫码后再下单' });
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [token]);
      if (!session) return res.status(401).json({ error: '请重新扫码后再下单' });
      if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '二维码已过期，请重新扫码' });
      table = await assertTableExists(req.body.table, session.store_id || 1);
      if (session.table_name !== table) return res.status(403).json({ error: '扫码桌号与下单桌号不一致' });
      sessionStoreId = session.store_id || 1;
      sessionToken = token;
    } else {
      table = await assertTableExists(req.body.table, req.storeId || 1);
    }
    const tableStore = await getAsync('SELECT store_id FROM tables WHERE name=? AND store_id=?', [table, sessionStoreId || req.storeId || 1]);
    const storeId = tableStore?.store_id || sessionStoreId || req.storeId || 1;
    if (isWaiter && waiter.store_id !== storeId) return res.status(403).json({ error: '不能为其他店铺的桌号下单' });
    const finalStoreId = sessionStoreId || storeId;

    // ---------- 3. 冷却检查 ----------
    const cooldownKey = sessionToken || table;
    const cooldownMs = await getOrderCooldownMs();
    const canSubmit = await checkAndSetCooldown(cooldownKey, cooldownMs || 3000);
    if (!canSubmit) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }

    // ---------- 4. 菜品规范化与上限校验 ----------
    const items = await normalizeOrderItems(req.body.items, finalStoreId);

    const maxItemsRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_items'");
    const maxItems = parseInt(maxItemsRow?.value || '50', 10);
    if (items.length > maxItems) {
      return res.status(400).json({
        error: `单次下单菜品数量不能超过${maxItems}种`,
        code: 'ORDER_ITEM_TYPES_EXCEEDED',
        limit: maxItems,
        actual: items.length,
      });
    }

    const maxQtyRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_item_quantity'");
    const maxQty = parseInt(maxQtyRow?.value || '100', 10);
    for (const item of items) {
      if (Number(item.quantity) > maxQty) {
        return res.status(400).json({
          error: `单个菜品数量不能超过${maxQty}份`,
          code: 'ITEM_QTY_EXCEEDED',
          limit: maxQty,
          actual: Number(item.quantity),
          itemId: item.id,
          itemName: item.name,
        });
      }
    }

    const rawTotal = items.reduce((sum, item) => sum + (Number(item.base_price) || Number(item.price)) * item.quantity, 0);
    const calculatedTotal = Math.round(rawTotal * 100) / 100;   // 强制保留 2 位小数
    const itemsJson = JSON.stringify(items);
    const createdAt = new Date().toISOString();

    // ---------- 5. 备注处理 ----------
    let note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
    const maxNoteRow = await getAsync("SELECT value FROM settings WHERE `key` = 'max_order_note_length'");
    const maxNoteLen = parseInt(maxNoteRow?.value || '200', 10);
    if (note.length > maxNoteLen) note = note.slice(0, maxNoteLen);

    // ---------- 6. 计算订单号前缀 ----------
    const _midRow = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [finalStoreId]);
    const _mid = _midRow?.merchant_id || 1;
    const prefixRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${_mid}_order_prefix_normal`])
                   || await getAsync("SELECT value FROM settings WHERE `key` = 'order_prefix_normal'");
    const orderPrefix = (prefixRow?.value || '11').padStart(2, '0').slice(-2);
    const yyddmm = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const todayPrefix = orderPrefix + yyddmm;
    const resetRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${_mid}_order_no_reset_period`])
                  || await getAsync("SELECT value FROM settings WHERE `key` = 'order_no_reset_period'");
    const resetPeriod = resetRow?.value || 'never';
    let seqPrefix = todayPrefix;
    if (resetPeriod === 'monthly') seqPrefix = orderPrefix + yyddmm.slice(0, 4);
    else if (resetPeriod === 'yearly') seqPrefix = orderPrefix + yyddmm.slice(0, 2);
    else if (resetPeriod === 'never') seqPrefix = orderPrefix + 'GL';

    // ---------- 7. 事务：分配订单号 + 写订单 + 更新销量 + 更新桌台 + 重置会话 ----------
    let createdOrder;
    try {
      createdOrder = await withTransaction(async () => {
        const orderNo = await allocateOrderNo(seqPrefix);
        const result = await runAsync(
          'INSERT INTO orders (order_no, table_name, items, total, status, createdAt, session_token, customer_token, store_id, note, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
          [orderNo, table, itemsJson, calculatedTotal, 'pending', createdAt, sessionToken, customerToken, finalStoreId, note, finalStoreId]
        );
        for (const item of items) {
          if (item.id) {
            await runAsync(
              'UPDATE menus SET sales_count = sales_count + ? WHERE id = ? AND store_id = ?',
              [Number(item.quantity) || 1, item.id, finalStoreId]
            );
          }
        }
        await syncTableStatus(table, finalStoreId);
        if (sessionToken) {
          const qrTimeoutRow = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
          const qrTimeoutMins = parseInt(qrTimeoutRow?.value || '45', 10);
          if (qrTimeoutMins > 0) {
            const newExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
            await runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newExpires, sessionToken]);
          }
        }
        return { orderId: result.lastID, orderNo };
      });
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY' && String(e.message).includes('idx_order_no')) {
        console.error('[order] order_no 唯一约束冲突，可能序列化表被手动修改:', e.message);
        return res.status(409).json({ error: '订单号冲突，请重试', code: 'ORDER_NO_CONFLICT' });
      }
      throw e;
    }

    // ---------- 8. 事务外：查询 + 打印 + Socket ----------
    const newRow = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [createdOrder.orderId, finalStoreId]);

    try {
      // ===== 后厨自动打印（读数据库开关，默认关闭）=====
      const autoPrintRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`auto_print_kitchen_${finalStoreId}`]);
      const autoPrintEnabled = autoPrintRow && (autoPrintRow.value === '1' || autoPrintRow.value === 'true');
      if (autoPrintEnabled) {
        const storeInfo = await getAsync('SELECT * FROM stores WHERE id=?', [finalStoreId]);
        const result = await dispatchPrint({
          order: formatOrder(newRow),
          type: 'kitchen',
          store: storeInfo,
          getAsync,
        });
        if (result.printed) {
          console.log(`[AutoPrint] 后厨单已打印 order #${newRow.id} → ${result.printer}`);
        } else if (result.error) {
          console.error(`[AutoPrint] 打印失败 order #${newRow.id}:`, result.error);
        }
      }
    } catch (autoPrintErr) {
      console.error('[AutoPrint] Error:', autoPrintErr.message);
    }

    const orderData = formatOrder(newRow);
    io.to('kitchen-' + (newRow.store_id || 1)).emit('order:new', orderData);
    io.to('waiter-' + (newRow.store_id || 1)).emit('order:new', orderData);
    io.to('cashier-' + (newRow.store_id || 1)).emit('order:new', orderData);
    io.to('public-store-' + (newRow.store_id || 1)).emit('order:new', orderData);

    const responseData = {
      success: true,
      orderId: newRow.id,
      orderNo: newRow.order_no || '',
      order: orderData
    };
    if (sessionToken) {
      const updatedSession = await getAsync('SELECT expires_at FROM scan_sessions WHERE token=?', [sessionToken]);
      if (updatedSession) responseData.newExpiresAt = updatedSession.expires_at;
    }
    res.status(201).json(responseData);
  } catch (e) {
    console.error('[POST /api/orders] 错误:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/orders/:id(\\d+)', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const { table, items, status, note, pay_method } = req.body;
    const orderStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const existing = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
    if (!existing) return res.status(404).json({ error: '订单不存在' });
    if (existing.status === 'done') return res.status(409).json({ error: '已完成订单不能编辑' });
    if (req.isAdmin && !req.isPrimaryAdmin && !(req.adminPermissions && req.adminPermissions.can_edit_order)) {
      return res.status(403).json({ error: '无权修改订单' });
    }
    let currentItems = existing.items;
    if (typeof currentItems === 'string') {
      try { currentItems = JSON.parse(currentItems); } catch (_) { currentItems = []; }
    } else if (!Array.isArray(currentItems)) {
      currentItems = [];
    }
    let newItems = [];
    if (items === undefined || items === null) {
      newItems = currentItems;
    } else {
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'items 必须是数组' });
      }
      if (items.length === 0) {
        newItems = [];
      } else {
        newItems = await normalizeOrderItems(items, orderStoreId);
        for (let i = 0; i < newItems.length; i++) {
          if (items[i] && (items[i].itemStatus === 'done' || items[i].itemStatus === 'pending')) {
            newItems[i].itemStatus = items[i].itemStatus;
          }
        }
      }
    }
    const calculatedTotal = newItems.reduce((sum, item) => sum + (Number(item.base_price) || Number(item.price)) * item.quantity, 0);
    if (status === 'done') {
      if (!req.isAdmin && req.waiter && !req.waiter.can_complete_order) {
        return res.status(403).json({ error: '该服务员没有结算订单权限' });
      }
      if (newItems.some(item => item.itemStatus !== 'done')) {
        return res.status(409).json({ error: '存在未完成菜品，请先完成或删除该菜品后再结算订单' });
      }
    }
    const nextTable = table === undefined ? existing.table_name : await assertTableExists(table, orderStoreId);
    const itemsJson = JSON.stringify(newItems);
    let nextNote = existing.note || '';
    if (typeof note === 'string') {
      nextNote = note.trim().slice(0, 200);
    }
    if (status === 'done' && typeof pay_method === 'string') {
      const cashReceived = Number(req.body.cash_received) || 0;
      const cashChange = Number(req.body.cash_change) || 0;
      await runAsync(
        'UPDATE orders SET table_name=?, items=?, total=?, status=?, note=?, pay_method=?, cash_received=?, cash_change=? WHERE id=? AND store_id=?',
        [nextTable, itemsJson, calculatedTotal, status, nextNote, pay_method.slice(0, 20), cashReceived, cashChange, id, orderStoreId]
      );
    } else {
      await runAsync(
        'UPDATE orders SET table_name=?, items=?, total=?, status=?, note=? WHERE id=? AND store_id=?',
        [nextTable, itemsJson, calculatedTotal, status || existing.status, nextNote, id, orderStoreId]
      );
    }
    const updatedRow = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, orderStoreId]);
    await syncTableStatus(nextTable, orderStoreId);
    if (nextTable !== existing.table_name) await syncTableStatus(existing.table_name, orderStoreId);
    res.json(formatOrder(updatedRow));
  } catch (e) {
    console.error('更新订单失败:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/orders/:id(\\d+)', requireAdminKey, requirePermission('can_delete_order'), async (req, res) => {
  try {
    const id = req.params.id;
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: '请输入管理员密码' });
    }
    const currentAdmin = await getAsync('SELECT password_hash FROM merchant_admins WHERE id=?', [req.adminId]);
    if (!currentAdmin || !verifyPassword(password, currentAdmin.password_hash)) {
      return res.status(401).json({ error: '密码错误' });
    }
    const existing = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (!existing) return res.status(404).json({ error: '订单不存在' });
    const result = await runAsync('DELETE FROM orders WHERE id = ? AND store_id = ?', [id, req.storeId]);
    if (result.changes === 0) return res.status(404).json({ error: '订单不存在' });
    if (existing) await syncTableStatus(existing.table_name, existing.store_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 呼叫服务员 -----
app.post('/api/public/call-waiter', async (req, res) => {
  try {
    const { table, sessionToken } = req.body || {};
    if (!table) return res.status(400).json({ error: '桌号不能为空' });
    let callStoreId = req.storeId || 1;
    if (sessionToken) {
      const session = await getAsync('SELECT store_id FROM scan_sessions WHERE token=?', [sessionToken]);
      if (session) callStoreId = session.store_id || 1;
    }
    const tableRow = await getAsync('SELECT id, store_id FROM tables WHERE name=? AND store_id=?', [table, callStoreId]);
    if (!tableRow) return res.status(404).json({ error: '桌号不存在' });
    const limitRows = await allAsync("SELECT `key`, value FROM settings WHERE `key` IN ('call_limit_enabled','call_limit_max','call_limit_window_minutes','call_limit_cooldown_minutes')");
    const limitCfg = {};
    limitRows.forEach(r => { limitCfg[r.key] = r.value; });
    const limitEnabled = (limitCfg.call_limit_enabled || '1') !== '0';
    const maxCalls = parseInt(limitCfg.call_limit_max || '3', 10);
    const windowMinutes = parseInt(limitCfg.call_limit_window_minutes || '5', 10);
    const cooldownMinutes = parseInt(limitCfg.call_limit_cooldown_minutes || '10', 10);
    if (limitEnabled) {
      const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
      const countRow = await getAsync(
        "SELECT COUNT(*) AS cnt FROM waiter_calls WHERE table_name=? AND store_id=? AND (type='call' OR type='' OR type IS NULL) AND created_at >= ?",
        [table, tableRow.store_id, windowStart]
      );
      const callCount = countRow?.cnt || 0;
      if (callCount >= maxCalls) {
        const lastCall = await getAsync(
          "SELECT created_at FROM waiter_calls WHERE table_name=? AND store_id=? AND (type='call' OR type='' OR type IS NULL) ORDER BY created_at DESC LIMIT 1",
          [table, tableRow.store_id]
        );
        let cooldownRemaining = cooldownMinutes;
        if (lastCall) {
          const elapsed = (Date.now() - new Date(lastCall.created_at).getTime()) / 60000;
          cooldownRemaining = Math.max(0, Math.ceil(cooldownMinutes - elapsed));
        }
        return res.status(429).json({ error: '呼叫过于频繁', cooldownMinutes: cooldownRemaining });
      }
    }
    const callId = crypto.randomBytes(8).toString('hex');
    await runAsync(
      'INSERT INTO waiter_calls (id, table_name, store_id, session_token, status, type, created_at, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
      [callId, table, tableRow.store_id, sessionToken || '', 'pending', 'call', new Date().toISOString(), tableRow.store_id]
    );
    res.json({ success: true, callId, message: '已通知服务员' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/waiter-calls', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const rows = await allAsync(
      'SELECT * FROM waiter_calls WHERE store_id=? AND status="pending" ORDER BY created_at DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/waiter-calls/:id/handle', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const existing = await getAsync('SELECT * FROM waiter_calls WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ error: '呼叫记录不存在' });
    const handler = req.isAdmin ? 'admin' : (req.waiter?.display_name || 'waiter');
    await runAsync(
      'UPDATE waiter_calls SET status=?, handled_by=?, handled_at=? WHERE id=? AND store_id=?',
      ['handled', handler, new Date().toISOString(), id, storeId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/reservations', requireAdminKey, async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const rows = await allAsync(
      'SELECT * FROM reservations WHERE store_id=? ORDER BY reservation_time DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/reservations/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body || {};
    const reservation = await getAsync('SELECT * FROM reservations WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!reservation) return res.status(404).json({ error: '预约不存在' });
    if (!['pending', 'confirmed', 'canceled', 'completed'].includes(status)) {
      return res.status(400).json({ error: '无效的预约状态' });
    }
    await runAsync('UPDATE reservations SET status=? WHERE id=? AND store_id=?', [status, id, req.storeId]);
    if (status === 'canceled' || status === 'completed') {
      const table = await getAsync('SELECT id, status FROM tables WHERE name=? AND store_id=?', [reservation.table_name, req.storeId]);
      if (table && table.status === 'reserved') {
        const active = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name=? AND store_id=? AND status=\"pending\"", [reservation.table_name, req.storeId]);
        if (active.count === 0) await runAsync('UPDATE tables SET status=? WHERE id=? AND store_id=?', ['available', table.id, req.storeId]);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 订单打印 -----
};