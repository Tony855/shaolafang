const { parsePositiveRouteId } = require('../server/services/route-id');
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
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

app.post('/api/admin/stores', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const { name, code, address } = req.body || {};
    const storeName = typeof name === 'string' ? name.trim() : '';
    const requestedStoreCode = typeof code === 'string' ? code.trim() : '';
    const storeCode = requestedStoreCode || ('m' + String(req.merchantId || 1) + '-' + crypto.randomBytes(6).toString('hex'));
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
      const actor = req.adminId
        ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId])
        : null;
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId || null, actor?.username || '', 'create_store', 'store', storeId,
          JSON.stringify({ name: storeName, code: storeCode }), getClientIp(req), new Date().toISOString()]
      );
    });
    res.status(201).json(await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [storeId, merchantId]));
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '店铺编码已存在' });
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '创建店铺失败，所有更改已回滚' });
  }
});

app.put('/api/admin/stores/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parsePositiveRouteId(req.params.id);
    const merchantId = Number(req.merchantId || 1);
    const body = req.body || {};
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
      return res.status(400).json({ error: '门店编号无效' });
    }
    const nextName = body.name === undefined ? undefined : (typeof body.name === 'string' ? body.name.trim() : null);
    const nextCode = body.code === undefined ? undefined : (typeof body.code === 'string' ? body.code.trim() : null);
    const nextAddress = body.address === undefined ? undefined : (typeof body.address === 'string' ? body.address.trim() : null);
    if (nextName === null || nextName === '' || (nextName && nextName.length > 255)) {
      return res.status(400).json({ error: '店铺名称必须为 1 至 255 个字符' });
    }
    if (nextCode === null || (nextCode !== undefined && nextCode.length > 50)) {
      return res.status(400).json({ error: '店铺编码不能超过 50 个字符' });
    }
    if (nextAddress === null || (nextAddress !== undefined && nextAddress.length > 2000)) {
      return res.status(400).json({ error: '店铺地址格式无效或超过 2000 个字符' });
    }
    let nextActive;
    if (body.active !== undefined) {
      if (![true, false, 0, 1, '0', '1'].includes(body.active)) {
        return res.status(400).json({ error: '门店状态必须为启用或停用' });
      }
      nextActive = body.active === true || body.active === 1 || body.active === '1' ? 1 : 0;
    }
    let nextQrLanguages;
    if (body.qr_languages !== undefined) {
      if (body.qr_languages === null || body.qr_languages === '') nextQrLanguages = null;
      else if (typeof body.qr_languages === 'string') nextQrLanguages = body.qr_languages;
      else if (Array.isArray(body.qr_languages)) nextQrLanguages = JSON.stringify(body.qr_languages);
      else return res.status(400).json({ error: '扫码语言配置格式无效' });
      if (nextQrLanguages && nextQrLanguages.length > 50) return res.status(400).json({ error: '扫码语言配置不能超过 50 个字符' });
    }

    let updatedStore;
    await withTransaction(async () => {
      const merchant = await getAsync('SELECT id FROM merchants WHERE id=? FOR UPDATE', [merchantId]);
      if (!merchant) throw Object.assign(new Error('商户不存在'), { statusCode: 404 });
      const current = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
      if (!current) throw Object.assign(new Error('店铺不存在'), { statusCode: 404 });

      const name = nextName === undefined ? current.name : nextName;
      const code = nextCode === undefined || nextCode === '' ? current.code : nextCode;
      const address = nextAddress === undefined ? current.address : nextAddress;
      const active = nextActive === undefined ? current.active : nextActive;
      const qrLanguages = nextQrLanguages === undefined ? current.qr_languages : nextQrLanguages;
      if (code !== current.code) {
        const duplicate = await getAsync('SELECT id FROM stores WHERE code=? AND id<>?', [code, id]);
        if (duplicate) throw Object.assign(new Error('店铺编码已存在'), { statusCode: 409 });
      }
      await runAsync(
        'UPDATE stores SET name=?, code=?, address=?, active=?, qr_languages=? WHERE id=? AND merchant_id=?',
        [name, code, address, active, qrLanguages, id, merchantId]
      );
      const actor = req.adminId
        ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId])
        : null;
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId || null, actor?.username || '', 'update_store', 'store', id,
          JSON.stringify({ before: { name: current.name, code: current.code, active: current.active }, after: { name, code, active } }),
          getClientIp(req), new Date().toISOString()]
      );
      updatedStore = await getAsync('SELECT * FROM stores WHERE id=? AND merchant_id=?', [id, merchantId]);
    });
    res.json(updatedStore);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '店铺编码已存在' });
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '更新门店失败，所有更改已回滚' });
  }
});

app.delete('/api/admin/stores/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parsePositiveRouteId(req.params.id);
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
      if (merchantStores.length <= 1 || Number(merchantStores[0]?.id) === id) {
        throw Object.assign(new Error('商户默认总店或最后一家门店不能删除'), { statusCode: 409 });
      }

      // Do not orphan operational or financial records. Deletion is allowed
      // only after the store has been emptied through the supported workflows.
      const dependentTables = ['orders', 'refund_requests', 'tables', 'menus', 'menu_categories', 'waiters', 'printers', 'reservations', 'waiter_calls', 'scan_sessions', 'cashier_sessions'];
      for (const table of dependentTables) {
        const row = await getAsync(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE store_id=?`, [id]);
        if (Number(row?.count || 0) > 0) {
          throw Object.assign(new Error('门店仍有关联业务数据（' + table + '），请先处理数据后再删除'), { statusCode: 409 });
        }
      }

      const result = await runAsync('DELETE FROM stores WHERE id=? AND merchant_id=?', [id, merchantId]);
      if (!result.affectedRows) throw Object.assign(new Error('店铺不存在或已被删除'), { statusCode: 404 });
      const storeSettingsPrefix = `store_${id}_`;
      await runAsync('DELETE FROM settings WHERE LEFT(`key`, CHAR_LENGTH(?)) = ?', [storeSettingsPrefix, storeSettingsPrefix]);
      await runAsync('DELETE FROM settings WHERE \`key\` = ?', [`cashiers_${id}`]);
      const actor = req.adminId
        ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId])
        : null;
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId || null, actor?.username || '', 'delete_store', 'store', id,
          JSON.stringify({ name: current.name, code: current.code }), getClientIp(req), new Date().toISOString()]
      );
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '删除门店失败，所有更改已回滚' });
  }
});

app.post('/api/admin/stores/:id/copy-menu', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  const copiedFiles = [];
  try {
    const targetStoreId = parsePositiveRouteId(req.params.id);
    const merchantId = Number(req.merchantId || 1);
    if (!Number.isSafeInteger(targetStoreId) || targetStoreId <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
      return res.status(400).json({ error: '门店编号无效' });
    }
    const uploadRoot = path.resolve(UPLOAD_DIR);
    let result;
    await withTransaction(async () => {
      const merchant = await getAsync('SELECT id FROM merchants WHERE id=? FOR UPDATE', [merchantId]);
      if (!merchant) throw Object.assign(new Error('商户不存在'), { statusCode: 404 });
      const targetStore = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? FOR UPDATE', [targetStoreId, merchantId]);
      if (!targetStore) throw Object.assign(new Error('店铺不存在'), { statusCode: 404 });
      const sourceStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1 FOR UPDATE', [merchantId]);
      if (!sourceStore) throw Object.assign(new Error('未找到源店铺'), { statusCode: 400 });
      const sourceStoreId = Number(sourceStore.id);
      if (targetStoreId === sourceStoreId) throw Object.assign(new Error('总店无需复制自身'), { statusCode: 400 });

      const sourceMenus = await allAsync(
        'SELECT * FROM menus WHERE store_id=? AND merchant_id=? ORDER BY id FOR UPDATE',
        [sourceStoreId, merchantId]
      );
      if (sourceMenus.length === 0) throw Object.assign(new Error('总店暂无菜品可复制'), { statusCode: 404 });
      const existingMenus = await allAsync('SELECT name FROM menus WHERE store_id=? FOR UPDATE', [targetStoreId]);
      const existingNames = new Set(existingMenus.map(menu => menu.name));
      const menusToCopy = sourceMenus.filter(menu => !existingNames.has(menu.name));
      if (menusToCopy.length === 0) {
        result = { copied: 0, skipped: sourceMenus.length };
        return;
      }

      for (const menu of menusToCopy) {
        let newImage = '';
        if (menu.image) {
          const imageName = path.basename(String(menu.image));
          const sourcePath = path.resolve(uploadRoot, imageName);
          if (sourcePath.startsWith(uploadRoot + path.sep) && fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
            const realRoot = fs.realpathSync(uploadRoot);
            const realSource = fs.realpathSync(sourcePath);
            if (realSource.startsWith(realRoot + path.sep)) {
              const ext = path.extname(imageName).toLowerCase();
              const newFilename = Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
              const destinationPath = path.resolve(uploadRoot, newFilename);
              if (destinationPath.startsWith(uploadRoot + path.sep)) {
                fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
                copiedFiles.push(destinationPath);
                newImage = newFilename;
              }
            }
          }
        }
        await runAsync(
          `INSERT INTO menus (name, emoji, price, category, \`desc\`, image, currency_code, name_en, desc_en, active, unit, show_dual, secondary_currency_code, store_id, merchant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            menu.name, menu.emoji, menu.price, menu.category, menu.desc, newImage,
            menu.currency_code || 'USD', menu.name_en || '', menu.desc_en || '',
            menu.active !== undefined ? menu.active : 1, menu.unit || '份',
            menu.show_dual || 0, menu.secondary_currency_code || '', targetStoreId, merchantId
          ]
        );
      }

      const actor = req.adminId
        ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId])
        : null;
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId || null, actor?.username || '', 'copy_store_menu', 'store', targetStoreId,
          JSON.stringify({ sourceStoreId, copied: menusToCopy.length, skipped: sourceMenus.length - menusToCopy.length }),
          getClientIp(req), new Date().toISOString()]
      );
      result = { copied: menusToCopy.length, skipped: sourceMenus.length - menusToCopy.length };
    });
    res.json({ success: true, ...result, message: `成功复制 ${result.copied} 道菜品` });
  } catch (e) {
    for (const file of copiedFiles) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '目标门店存在同名菜品，请刷新后重试' });
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '复制菜单失败，所有更改已回滚' });
  }
});

// ----- 菜单 -----

};
