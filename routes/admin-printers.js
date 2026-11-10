const { parsePositiveRouteId } = require('../server/services/route-id');
/* ============================================================
   routes/admin-printers.js — 打印机 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, withTransaction, requireAdminKey, requirePermission, requireAdminOrWaiter, formatOrder, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, EscPosBuilder, formatGlobalDateTime, getClientIp } = deps;

  // Customer/session bearer credentials are needed only for server-side
  // authorization and must never leave the order service in print payloads.
  function formatPrintOrder(row) {
    const order = formatPrintOrder(row);
    if (!order || typeof order !== 'object') return order;
    delete order.sessionToken;
    delete order.customerToken;
    return order;
  }

  app.get('/api/admin/printers', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const rows = await allAsync(
        `SELECT p.*, s.name AS store_name
         FROM printers p
         LEFT JOIN stores s ON s.id = p.store_id
         WHERE p.store_id = ?
         ORDER BY p.id`,
        [req.storeId || 1]
      );
      res.json(rows);
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  async function writePrinterAudit(req, action, printerId, details) {
    const actor = req.adminId
      ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, req.merchantId])
      : null;
    await runAsync(
      'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['merchant_admin', req.adminId || null, actor?.username || '', action, 'printer', printerId || null,
        JSON.stringify(details), getClientIp(req), new Date().toISOString()]
    );
  }

  function printerFlag(value, fallback, field) {
    if (value === undefined) return fallback;
    if ([true, 1, '1'].includes(value)) return 1;
    if ([false, 0, '0'].includes(value)) return 0;
    throw Object.assign(new Error(field + ' 参数无效'), { status: 400 });
  }

  function normalizePrinterFields(body, current = {}) {
    const name = body.name === undefined ? current.name : (typeof body.name === 'string' ? body.name.trim() : '');
    const type = body.type === undefined ? (current.type || 'network') : (typeof body.type === 'string' ? body.type.trim() : '');
    const ipAddress = body.ip_address === undefined ? (current.ip_address || '') : (typeof body.ip_address === 'string' ? body.ip_address.trim() : null);
    const port = body.port === undefined ? Number(current.port || 9100) : Number(body.port);
    const paperWidth = body.paper_width === undefined ? Number(current.paper_width || 58) : Number(body.paper_width);
    const brand = body.brand === undefined ? (current.brand || 'generic') : (typeof body.brand === 'string' ? body.brand.trim() : '');
    if (!name || name.length > 100) throw Object.assign(new Error('打印机名称必须为 1 至 100 个字符'), { status: 400 });
    if (!type || type.length > 20) throw Object.assign(new Error('打印机类型无效'), { status: 400 });
    if (ipAddress === null || ipAddress.length > 50) throw Object.assign(new Error('打印机地址不能超过 50 个字符'), { status: 400 });
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('打印机端口必须为 1 至 65535'), { status: 400 });
    if (![58, 80].includes(paperWidth)) throw Object.assign(new Error('纸张宽度仅支持 58 或 80 毫米'), { status: 400 });
    if (!brand || brand.length > 50) throw Object.assign(new Error('打印机品牌无效'), { status: 400 });
    return { name, type, ipAddress, port, paperWidth, brand };
  }

  app.post('/api/admin/printers', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const body = req.body || {};
      const storeId = Number(req.storeId || 1);
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(storeId) || storeId <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '商户或门店编号无效' });
      }
      const fields = normalizePrinterFields(body);
      let isDefault = printerFlag(body.is_default, 0, 'is_default');
      let createdPrinter;
      await withTransaction(async () => {
        const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [storeId, merchantId]);
        if (!store) throw Object.assign(new Error('门店不存在或已停用'), { status: 404 });
        const count = await getAsync('SELECT COUNT(*) AS count FROM printers WHERE store_id=?', [storeId]);
        if (Number(count?.count || 0) === 0) isDefault = 1;
        if (isDefault) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [storeId]);
        const result = await runAsync(
          'INSERT INTO printers (name, type, ip_address, port, paper_width, brand, is_default, active, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
          [fields.name, fields.type, fields.ipAddress, fields.port, fields.paperWidth, fields.brand, isDefault, storeId, merchantId]
        );
        await writePrinterAudit(req, 'create_printer', result.lastID, { ...fields, is_default: isDefault, store_id: storeId });
        createdPrinter = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [result.lastID, storeId]);
      });
      res.status(201).json(createdPrinter);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.status ? e.message : '创建打印机失败，所有更改已回滚' });
    }
  });

  app.put('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
      const storeId = Number(req.storeId);
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(storeId) || storeId <= 0 ||
          !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '打印机、门店或商户编号无效' });
      }
      const body = req.body || {};
      let updatedPrinter;
      await withTransaction(async () => {
        const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [storeId, merchantId]);
        if (!store) throw Object.assign(new Error('门店不存在或已停用'), { status: 404 });
        const current = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=? AND merchant_id=? FOR UPDATE', [id, storeId, merchantId]);
        if (!current) throw Object.assign(new Error('打印机不存在'), { status: 404 });
        const fields = normalizePrinterFields(body, current);
        const active = printerFlag(body.active, Number(current.active), 'active');
        const isDefault = printerFlag(body.is_default, Number(current.is_default), 'is_default');

        if (isDefault === 1 && active === 0) {
          if (Number(current.is_default) === 1 && body.is_default === undefined) {
            throw Object.assign(new Error('不能停用当前默认打印机，请先切换默认设备'), { status: 409 });
          }
          throw Object.assign(new Error('停用的打印机不能设为默认打印机'), { status: 400 });
        }
        if (isDefault === 0 && Number(current.is_default) === 1) {
          const replacement = await getAsync(
            'SELECT id FROM printers WHERE store_id=? AND merchant_id=? AND id<>? AND active=1 ORDER BY id LIMIT 1 FOR UPDATE',
            [storeId, merchantId, id]
          );
          if (!replacement) throw Object.assign(new Error('至少保留一个启用的默认打印机'), { status: 409 });
          await runAsync('UPDATE printers SET is_default=0 WHERE store_id=? AND merchant_id=?', [storeId, merchantId]);
          await runAsync('UPDATE printers SET is_default=1 WHERE id=? AND store_id=? AND merchant_id=?', [replacement.id, storeId, merchantId]);
        } else if (isDefault === 1) {
          await runAsync('UPDATE printers SET is_default=0 WHERE store_id=? AND merchant_id=?', [storeId, merchantId]);
        }
        await runAsync(
          'UPDATE printers SET name=?, type=?, ip_address=?, port=?, paper_width=?, brand=?, is_default=?, active=? WHERE id=? AND store_id=? AND merchant_id=?',
          [fields.name, fields.type, fields.ipAddress, fields.port, fields.paperWidth, fields.brand,
            isDefault === 1 && active === 1 ? 1 : (isDefault === 0 ? 0 : Number(current.is_default)),
            active, id, storeId, merchantId]
        );
        await writePrinterAudit(req, 'update_printer', id, { ...fields, is_default: isDefault, active });
        updatedPrinter = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, storeId]);
      });
      res.json(updatedPrinter);
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '更新打印机失败，所有更改已回滚' }); }
  });

  app.delete('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
      const storeId = Number(req.storeId);
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(storeId) || storeId <= 0 ||
          !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '打印机、门店或商户编号无效' });
      }
      await withTransaction(async () => {
        const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [storeId, merchantId]);
        if (!store) throw Object.assign(new Error('门店不存在或已停用'), { status: 404 });
        const current = await getAsync('SELECT id, name, is_default FROM printers WHERE id=? AND store_id=? AND merchant_id=? FOR UPDATE', [id, storeId, merchantId]);
        if (!current) throw Object.assign(new Error('打印机不存在'), { status: 404 });
        if (Number(current.is_default) === 1) {
          const replacement = await getAsync(
            'SELECT id FROM printers WHERE store_id=? AND merchant_id=? AND id<>? AND active=1 ORDER BY id LIMIT 1 FOR UPDATE',
            [storeId, merchantId, id]
          );
          if (replacement) {
            await runAsync('UPDATE printers SET is_default=0 WHERE store_id=? AND merchant_id=?', [storeId, merchantId]);
            await runAsync('UPDATE printers SET is_default=1 WHERE id=? AND store_id=? AND merchant_id=?', [replacement.id, storeId, merchantId]);
          }
        }
        await runAsync('DELETE FROM printers WHERE id=? AND store_id=? AND merchant_id=?', [id, storeId, merchantId]);
        await writePrinterAudit(req, 'delete_printer', id, { name: current.name, was_default: Number(current.is_default) === 1 });
      });
      res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '删除打印机失败，所有更改已回滚' }); }
  });

  app.get('/api/orders/:id(\\d+)/print', requireAdminOrWaiter, async (req, res) => {
    try {
      const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
      const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [req.params.id, printStoreId]);
      if (!row) return res.status(404).json({ error: '订单不存在' });
      const order = formatOrder(row);
      const store = await getAsync('SELECT name, address FROM stores WHERE id=?', [row.store_id || 1]);
      res.json({ order, store: store || { name: 'FoodFlow', address: '' }, printedAt: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/orders/:id(\\d+)/print', requireAdminOrWaiter, async (req, res) => {
    try {
      const id = req.params.id;
      const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
      const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, printStoreId]);
      if (!row) return res.status(404).json({ error: '订单不存在' });
      const order = formatOrder(row);
      const store = await getAsync('SELECT name, address, phone FROM stores WHERE id=?', [row.store_id || 1]);

      // 可选：指定打印机
      let printer = null;
      const printerId = req.body?.printer_id;
      if (printerId) {
        printer = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=? AND active=1', [printerId, row.store_id]);
      }

      const result = await dispatchPrint({
        order, type: 'receipt', store, printer, getAsync,
      });
      res.json(result);
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/orders/:id(\\d+)/print-kitchen', requireAdminOrWaiter, async (req, res) => {
    try {
      const id = req.params.id;
      const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
      const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, printStoreId]);
      if (!row) return res.status(404).json({ error: '订单不存在' });
      const order = formatOrder(row);
      const store = await getAsync('SELECT name, address, phone FROM stores WHERE id=?', [row.store_id || 1]);

      const result = await dispatchPrint({
        order, type: 'kitchen', store, getAsync,
      });
      res.json(result);
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.get('/api/admin/settings/auto-print', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const storeId = req.storeId || 1;
      const type = req.query.type || 'kitchen';
      const key = type === 'kitchen' ? `auto_print_kitchen_${storeId}` : `auto_print_receipt_${storeId}`;
      const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [key]);
      const enabled = row ? (row.value === '1' || row.value === 'true') : false;
      res.json({ enabled });
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.get('/api/admin/order-prefixes', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const mid = req.merchantId || 1;
      const shortKeys = ['order_prefix_normal', 'order_prefix_refund', 'order_prefix_discount', 'order_prefix_vip', 'order_no_reset_period'];
      const fullKeys = shortKeys.map(k => `merchant_${mid}_${k}`);
      const placeholders = fullKeys.map(() => "?").join(",");
      const rows = await allAsync("SELECT `key`, value FROM settings WHERE `key` IN (" + placeholders + ")", fullKeys);
      const result = {};
      for (const r of rows) {
        result[String(r.key).replace(`merchant_${mid}_`, '')] = r.value;
      }
      result.order_prefix_normal = result.order_prefix_normal || '11';
      result.order_prefix_refund = result.order_prefix_refund || '01';
      result.order_prefix_discount = result.order_prefix_discount || '21';
      result.order_prefix_vip = result.order_prefix_vip || '61';
      result.order_no_reset_period = result.order_no_reset_period || 'never';
      res.json(result);
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/admin/order-prefixes', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const mid = req.merchantId || 1;
      const { normal, refund, discount, vip, daily_reset } = req.body || {};
      const pairs = [
        [`merchant_${mid}_order_prefix_normal`, (normal || '11').padStart(2, '0').slice(-2)],
        [`merchant_${mid}_order_prefix_refund`, (refund || '01').padStart(2, '0').slice(-2)],
        [`merchant_${mid}_order_prefix_discount`, (discount || '21').padStart(2, '0').slice(-2)],
        [`merchant_${mid}_order_prefix_vip`, (vip || '61').padStart(2, '0').slice(-2)],
        [`merchant_${mid}_order_no_reset_period`, ['daily','monthly','yearly','never'].includes(daily_reset) ? daily_reset : 'daily']
      ];
      for (const [k, v] of pairs) {
        await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [k, v]);
      }
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/admin/settings/auto-print', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const storeId = req.storeId || 1;
      const { enabled, type } = req.body || {};
      const key = type === 'receipt' ? `auto_print_receipt_${storeId}` : `auto_print_kitchen_${storeId}`;
      const existing = await getAsync("SELECT value FROM settings WHERE `key` = ?", [key]);
      if (existing) {
        await runAsync("UPDATE settings SET value = ? WHERE `key` = ?", [enabled ? '1' : '0', key]);
      } else {
        await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?)", [key, enabled ? '1' : '0']);
      }
      res.json({ success: true, enabled });
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/admin/printers/test', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const { printer_id } = req.body || {};
      const printer = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=? AND active=1', [printer_id, req.storeId || 1]);
      if (!printer) return res.status(404).json({ error: '打印机不存在或未启用' });
      if (printer.type !== 'network' || !printer.ip_address) {
        return res.status(400).json({ error: '仅支持网络打印机测试' });
      }
      const pos = new EscPosBuilder(printer.paper_width || 58);
      pos.init();
      pos.align(1);
      pos.big(true);
      pos.line('测试打印');
      pos.big(false);
      pos.newline();
      pos.line(`打印机: ${printer.name}`);
      pos.line(`品牌: ${printer.brand}`);
      pos.line(`纸宽: ${printer.paper_width}mm`);
      pos.line(`时间: ${formatGlobalDateTime(new Date())}`);
      pos.newline();
      pos.separator();
      pos.line('如果您看到此内容，说明打印机正常工作！');
      pos.newline(2);
      pos.cut(1);
      await printToNetworkPrinter(pos.build(), printer.ip_address, printer.port);
      res.json({ success: true, message: '测试打印已发送' });
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });
};
