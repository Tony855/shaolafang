/* ============================================================
   routes/stores.js — 门店管理
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

const { initStoreSettings } = require('../server/services/settings-init');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.get('/api/admin/stores', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    res.json(await allAsync('SELECT * FROM stores WHERE merchant_id=? ORDER BY id', [req.merchantId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/stores', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const { name, code, address } = req.body || {};
    const storeName = typeof name === 'string' ? name.trim() : '';
    const storeCode = typeof code === 'string' ? code.trim() : '';
    const storeAddress = typeof address === 'string' ? address.trim() : '';
    if (!storeName || storeName.length > 255) return res.status(400).json({ error: '店铺名称必填且不能超过 255 个字符' });
    if (storeCode.length > 50) return res.status(400).json({ error: '店铺编码不能超过 50 个字符' });
    if (storeAddress.length > 2000) return res.status(400).json({ error: '店铺地址不能超过 2000 个字符' });
    const merchantId = Number(req.merchantId || 1);
    if (!Number.isSafeInteger(merchantId) || merchantId <= 0) return res.status(403).json({ error: '商户信息无效' });

    let storeId;
    await withTransaction(async () => {
      // Serialize store creation for this merchant; a pre-transaction COUNT
      // allows concurrent requests to exceed max_stores.
      const merchant = await getAsync('SELECT id, max_stores, status FROM merchants WHERE id=? FOR UPDATE', [merchantId]);
      if (!merchant || Number(merchant.status) !== 1) {
        const error = new Error('商户不存在或已停用');
        error.statusCode = 403;
        throw error;
      }
      const storeCount = await getAsync('SELECT COUNT(*) AS count FROM stores WHERE merchant_id=?', [merchantId]);
      if (Number(storeCount?.count || 0) >= Number(merchant.max_stores)) {
        const error = new Error('已达到门店数量上限（' + merchant.max_stores + '家），请联系超级管理员升级');
        error.statusCode = 403;
        throw error;
      }
      const result = await runAsync(
        'INSERT INTO stores (name, code, address, active, merchant_id) VALUES (?, ?, ?, 1, ?)',
        [storeName, storeCode, storeAddress, merchantId]
      );
      storeId = result.lastID;
      await initStoreSettings(runAsync, storeId);
      await logAudit('merchant_admin', req.adminId, req.username || '', 'create_store', 'store', storeId,
        JSON.stringify({ name: storeName, code: storeCode }), getClientIp(req));
    });
    res.status(201).json(await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [storeId, merchantId]));
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '店铺编码已存在' });
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '创建店铺失败，所有更改已回滚' });
  }
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
    const id = Number(req.params.id);
    const merchantId = Number(req.merchantId || 1);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
      return res.status(400).json({ error: '门店编号无效' });
    }
    await withTransaction(async () => {
      const merchant = await getAsync('SELECT id FROM merchants WHERE id=? FOR UPDATE', [merchantId]);
      if (!merchant) throw Object.assign(new Error('商户不存在'), { statusCode: 404 });
      const current = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
      if (!current) throw Object.assign(new Error('店铺不存在'), { statusCode: 404 });
      const merchantStores = await allAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id FOR UPDATE', [merchantId]);
      if (merchantStores.length <= 1 || merchantStores[0]?.id === id) {
        throw Object.assign(new Error('商户默认总店或最后一家门店不能删除'), { statusCode: 409 });
      }

      // Do not orphan operational or financial records. Deletion is allowed
      // only after the store has been emptied through the supported workflows.
      const dependentTables = ['orders', 'tables', 'menus', 'menu_categories', 'waiters', 'printers', 'reservations', 'waiter_calls', 'scan_sessions'];
      for (const table of dependentTables) {
        const row = await getAsync(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE store_id=?`, [id]);
        if (Number(row?.count || 0) > 0) {
          throw Object.assign(new Error('门店仍有关联业务数据（' + table + '），请先处理数据后再删除'), { statusCode: 409 });
        }
      }

      const result = await runAsync('DELETE FROM stores WHERE id=? AND merchant_id=?', [id, merchantId]);
      if (!result.affectedRows) throw Object.assign(new Error('店铺不存在或已被删除'), { statusCode: 404 });
      await runAsync('DELETE FROM settings WHERE \`key\` LIKE ?', [`store_${id}_%`]);
      await runAsync('DELETE FROM settings WHERE \`key\` = ?', [`cashiers_${id}`]);
      await logAudit('merchant_admin', req.adminId, req.username || '', 'delete_store', 'store', id,
        JSON.stringify({ name: current.name, code: current.code }), getClientIp(req));
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '删除门店失败，所有更改已回滚' });
  }
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
        // Only copy a file whose resolved path remains inside UPLOAD_DIR.
        // Legacy rows may contain absolute paths or traversal segments.
        const uploadRoot = path.resolve(uploadDir);
        const imageName = path.basename(String(menu.image));
        const srcPath = path.resolve(uploadRoot, imageName);
        if (srcPath.startsWith(uploadRoot + path.sep) && fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
          const realRoot = fs.realpathSync(uploadRoot);
          const realSource = fs.realpathSync(srcPath);
          if (!realSource.startsWith(realRoot + path.sep)) continue;
          const ext = path.extname(imageName).toLowerCase();
          const newFilename = Date.now() + '_' + Math.random().toString(36).slice(2,6) + ext;
          const destPath = path.resolve(uploadRoot, newFilename);
          if (destPath.startsWith(uploadRoot + path.sep)) {
            fs.copyFileSync(srcPath, destPath);
            newImage = newFilename;
          }
        }
      }
      await runAsync(
        `INSERT INTO menus (name, emoji, price, category, \`desc\`, image, currency_code, name_en, desc_en, active, unit, show_dual, secondary_currency_code, store_id, merchant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          menu.name, menu.emoji, menu.price, menu.category, menu.desc,
          newImage,
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

};
