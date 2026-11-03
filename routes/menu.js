/* ============================================================
   routes/menu.js — 菜品 + 分类
   ============================================================ */
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

  function resolveUploadFile(name) {
    const root = path.resolve(UPLOAD_DIR);
    const base = path.basename(String(name || '').split(String.fromCharCode(92)).join('/'));
    if (!base || base === '.' || base === '..') return null;
    const resolved = path.resolve(root, base);
    return resolved.startsWith(root + path.sep) ? resolved : null;
  }

app.get('/api/menu', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const rows = await allAsync('SELECT * FROM menus WHERE active = 1 AND store_id = ? ORDER BY id', [storeId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/menu', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
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
    let image = req.files && req.files.image ? req.files.image[0].filename : '';
    // 后端兜底压缩（前端已压过，这里是保护）
    if (image) {
      try {
        const cp = await compressImage(path.join(UPLOAD_DIR, image));
        if (!cp.skipped && cp.outPath) {
          image = path.basename(cp.outPath);
        }
      } catch (e) { console.warn('[POST /api/menu] 压缩失败:', e.message); }
    }
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
function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, d] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 0 && d === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && d === 100) ||
      (a === 203 && b === 0 && d === 113);
  }
  if (version === 6) {
    const ip = address.toLowerCase();
    if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice(7));
    return ip === '::' || ip === '::1' || ip.startsWith('fc') ||
      ip.startsWith('fd') || /^fe[89ab]/.test(ip) ||
      ip.startsWith('ff') || ip.startsWith('2001:db8:');
  }
  return true;
}

async function validateExternalImageUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || (parsed.port && parsed.port !== '443') ||
      parsed.username || parsed.password) {
    throw new Error('远程图片只允许 HTTPS 公网地址');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('禁止访问本地或内网地址');
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('远程图片地址解析到非公网 IP，已拒绝');
  }
  return parsed;
}

async function downloadImageToUploads(url) {
  try {
    let current = String(url);
    let response = null;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = await validateExternalImageUrl(current);
      response = await fetch(parsed, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('远程图片重定向次数过多或缺少目标地址');
        current = new URL(location, parsed).toString();
        continue;
      }
      break;
    }
    if (!response || !response.ok) throw new Error('HTTP ' + (response?.status || '请求失败'));
    const ct = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    if (!extMap[ct]) throw new Error('不支持的图片类型: ' + ct);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > 5 * 1024 * 1024) throw new Error('图片超过5MB');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('远程图片响应为空');
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 5 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('图片超过5MB');
      }
      chunks.push(Buffer.from(value));
    }
    if (!total) throw new Error('远程图片内容为空');
    const buf = Buffer.concat(chunks, total);
    const filename = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + extMap[ct];
    const uploadRoot = path.resolve(UPLOAD_DIR);
    await fs.promises.mkdir(uploadRoot, { recursive: true });
    const fullPath = path.resolve(uploadRoot, filename);
    if (!fullPath.startsWith(uploadRoot + path.sep)) throw new Error('图片保存路径无效');
    await fs.promises.writeFile(fullPath, buf, { flag: 'wx', mode: 0o640 });
    return filename;
  } catch (e) {
    console.warn('[batch] 下载图片失败:', String(url).slice(0, 200), e.message);
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
              const lp = resolveUploadFile(updImgRaw);
              if (lp && fs.existsSync(lp) && fs.statSync(lp).isFile()) updImage = path.basename(lp);
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
              const localPath = resolveUploadFile(rawImg);
              if (localPath && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) imageName = path.basename(localPath);
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
    // 新上传的图片兜底压缩
    if (req.files && req.files.image) {
      try {
        const cp = await compressImage(path.join(UPLOAD_DIR, image));
        if (!cp.skipped && cp.outPath) {
          image = path.basename(cp.outPath);
        }
      } catch (e) { console.warn('[PUT /api/menu/:id] 压缩失败:', e.message); }
    }
    if (req.files && req.files.image && current.image) {
      const oldPath = resolveUploadFile(current.image);
      if (oldPath && fs.existsSync(oldPath) && fs.statSync(oldPath).isFile()) fs.unlinkSync(oldPath);
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
      const imgPath = resolveUploadFile(item.image);
      if (imgPath && fs.existsSync(imgPath) && fs.statSync(imgPath).isFile()) fs.unlinkSync(imgPath);
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

};
