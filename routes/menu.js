/* ============================================================
   routes/menu.js — 菜品 + 分类
   ============================================================ */
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const http = require("http");
const https = require("https");
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
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const numericPrice = typeof price === 'number' || typeof price === 'string' ? Number(price) : NaN;
    const currencyCode = String(currency_code || 'USD').trim().toUpperCase();
    if (!cleanName || cleanName.length > 120 || !Number.isFinite(numericPrice) || numericPrice <= 0 || numericPrice > 10000000) {
      return res.status(400).json({ error: '菜品名称无效或价格必须是大于 0 的有效数字' });
    }
    const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [currencyCode, req.merchantId]);
    if (!currencyCode || currencyCode.length > 10) return res.status(400).json({ error: '货币代码无效' });
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
      [cleanName, emoji || '🍽️', numericPrice, category || '其他', desc || '', image, video || '', currencyCode, name_en || '', desc_en || '', unit || '份', show_dual ? 1 : 0, secondary_currency_code || '', req.storeId || 1, req.merchantId]
    );
    const newItem = await getAsync('SELECT * FROM menus WHERE id = ?', [result.lastID]);
    res.status(201).json(newItem);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 批量导入菜品：只允许公网 HTTP(S) 图片，逐跳校验重定向并限制响应体大小。
const blockedImageTargets = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blockedImageTargets.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blockedImageTargets.addSubnet(address, prefix, 'ipv6');
const globalIpv6Targets = new net.BlockList();
globalIpv6Targets.addSubnet('2000::', 3, 'ipv6');

async function validatePublicImageUrl(value) {
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      (target.port && !((target.protocol === 'http:' && target.port === '80') || (target.protocol === 'https:' && target.port === '443')))) {
    throw new Error('图片地址只允许无凭据的公网 HTTP(S) URL');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|lan|home\.arpa|internal|intranet|corp|test|example|invalid)$/.test(hostname)) {
    throw new Error('禁止访问本地或保留域名');
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => {
    const type = family === 6 ? 'ipv6' : 'ipv4';
    return (family === 6 && !globalIpv6Targets.check(address, type)) ||
      blockedImageTargets.check(address, type);
  })) {
    throw new Error('图片域名解析到非公网地址，已拒绝');
  }
  // Pin the validated DNS answer so a rebinding response cannot redirect the
  // actual HTTP connection to loopback, private networks, or cloud metadata.
  return { target, address: addresses[0] };
}

function requestPublicImage(resolved) {
  const { target, address } = resolved;
  const hostname = target.hostname.replace(/^\\[|\\]$/g, '');
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif' },
      lookup: (_host, options, callback) => {
        if (options && options.all) return callback(null, [address]);
        callback(null, address.address, address.family);
      },
      ...(target.protocol === 'https:' && !net.isIP(hostname) ? { servername: hostname } : {})
    }, response => resolve(response));
    request.setTimeout(15000, () => request.destroy(new Error('图片请求超时')));
    request.on('error', reject);
    request.end();
  });
}

async function downloadImageToUploads(url) {
  try {
    let resolved = await validatePublicImageUrl(url);
    let res;
    for (let redirects = 0; redirects <= 4; redirects++) {
      res = await requestPublicImage(resolved);
      if (![301, 302, 303, 307, 308].includes(res.statusCode)) break;
      const location = res.headers.location;
      res.destroy();
      if (!location || redirects === 4) throw new Error('图片重定向次数超限或目标无效');
      resolved = await validatePublicImageUrl(new URL(location, resolved.target).toString());
    }
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error('图片服务器返回 HTTP ' + (res?.statusCode || 0));
    }
    const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    const ext = extMap[ct];
    if (!ext) {
      res.destroy();
      throw new Error('不支持的图片格式: ' + (ct || 'unknown'));
    }
    const maxBytes = 5 * 1024 * 1024;
    const declaredLength = Number(res.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      res.destroy();
      throw new Error('图片超过5MB');
    }
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of res) {
      const part = Buffer.from(chunk);
      totalBytes += part.length;
      if (totalBytes > maxBytes) {
        res.destroy();
        throw new Error('图片超过5MB');
      }
      chunks.push(part);
    }
    if (!totalBytes) throw new Error('图片响应为空');
    const filename = 'batch_' + crypto.randomBytes(12).toString('hex') + ext;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), Buffer.concat(chunks, totalBytes), { flag: 'wx', mode: 0o640 });
    return filename;
  } catch (e) {
    console.warn('[batch] 图片下载失败:', e.message);
    return null;
  }
}

app.post('/api/menu/batch', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '导入数据不能为空' });
    if (items.length > 500) return res.status(400).json({ error: '单次最多导入 500 道菜品' });
    if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      return res.status(400).json({ error: '导入数据中存在无效菜品对象' });
    }

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
        const itemName = typeof item.name === 'string' ? item.name.trim() : '';
        const itemPrice = typeof item.price === 'number' || typeof item.price === 'string' ? Number(item.price) : NaN;
        const itemCurrency = String(item.currency_code || 'USD').trim().toUpperCase();
        if (!itemName || itemName.length > 120 || !Number.isFinite(itemPrice) || itemPrice <= 0 || itemPrice > 10000000) {
          failed++;
          errors.push(`第 ${i+1} 行：菜品名称无效或价格必须是大于 0 的有效数字`);
          continue;
        }
        if (!itemCurrency || itemCurrency.length > 10) {
          failed++;
          errors.push(`第 ${i+1} 行：货币代码无效`);
          continue;
        }
        const currency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [itemCurrency, req.merchantId]);
        if (!currency) {
          failed++;
          errors.push(`第 ${i+1} 行：货币 ${itemCurrency} 不存在`);
          continue;
        }
        const existing = await getAsync('SELECT id FROM menus WHERE name = ? AND store_id = ?', [itemName, req.storeId || 1]);
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
                itemPrice,
                item.category || '其他',
                item.desc || '',
                itemCurrency,
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
                itemPrice,
                item.category || '其他',
                item.desc || '',
                itemCurrency,
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
              itemName,
              item.emoji || '🍽️',
              itemPrice,
              item.category || '其他',
              item.desc || '',
              imageName,
              itemCurrency,
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
    const nextCurrency = String(currency_code || current.currency_code || 'USD').trim().toUpperCase();
    const nextName = name === undefined ? current.name : (typeof name === 'string' ? name.trim() : '');
    const nextPrice = price === undefined ? Number(current.price) : (typeof price === 'number' || typeof price === 'string' ? Number(price) : NaN);
    if (!nextName || nextName.length > 120 || !Number.isFinite(nextPrice) || nextPrice <= 0 || nextPrice > 10000000) {
      return res.status(400).json({ error: '菜品名称无效或价格必须是大于 0 的有效数字' });
    }
    if (!nextCurrency || nextCurrency.length > 10) return res.status(400).json({ error: '货币代码无效' });
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
      [nextName, emoji || current.emoji, nextPrice, category || current.category, desc ?? current.desc, image, video, nextCurrency, name_en ?? current.name_en ?? '', desc_en ?? current.desc_en ?? '', unit || current.unit || '份', show_dual === undefined ? (current.show_dual || 0) : (show_dual ? 1 : 0), secondary_currency_code ?? current.secondary_currency_code ?? '', id, req.storeId]
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
app.get('/api/menu-categories', requireAdminKey, requirePermission('can_manage_menu'), async (req, res) => {
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
