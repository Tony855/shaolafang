/* ============================================================
   routes/admin-printers.js — 打印机 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, formatOrder, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, EscPosBuilder, formatGlobalDateTime } = deps;

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
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/printers', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const { name, type, ip_address, port, paper_width, brand, is_default } = req.body || {};
      if (!name) return res.status(400).json({ error: '打印机名称必填' });
      if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [req.storeId || 1]);
      const result = await runAsync(
        'INSERT INTO printers (name, type, ip_address, port, paper_width, brand, is_default, active, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [name, type || 'network', ip_address || '', port || 9100, paper_width || 58, brand || 'generic', is_default ? 1 : 0, req.storeId || 1, req.merchantId]
      );
      res.status(201).json(await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [result.lastID, req.storeId || 1]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '打印机不存在' });
      const { name, type, ip_address, port, paper_width, brand, is_default, active } = req.body || {};
      if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [current.store_id]);
      await runAsync(
        'UPDATE printers SET name=?, type=?, ip_address=?, port=?, paper_width=?, brand=?, is_default=?, active=? WHERE id=? AND store_id=?',
        [name || current.name, type || current.type, ip_address ?? current.ip_address, port || current.port, paper_width || current.paper_width, brand || current.brand, is_default !== undefined ? (is_default ? 1 : 0) : current.is_default, active !== undefined ? (active ? 1 : 0) : current.active, id, req.storeId]
      );
      res.json(await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const current = await getAsync('SELECT id FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
      if (!current) return res.status(404).json({ error: '打印机不存在' });
      await runAsync('DELETE FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/orders/:id(\\d+)/print', requireAdminOrWaiter, async (req, res) => {
    try {
      const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
      const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [req.params.id, printStoreId]);
      if (!row) return res.status(404).json({ error: '订单不存在' });
      const order = formatOrder(row);
      const store = await getAsync('SELECT name, address FROM stores WHERE id=?', [row.store_id || 1]);
      res.json({ order, store: store || { name: 'FoodFlow', address: '' }, printedAt: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/settings/auto-print', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const storeId = req.storeId || 1;
      const type = req.query.type || 'kitchen';
      const key = type === 'kitchen' ? `auto_print_kitchen_${storeId}` : `auto_print_receipt_${storeId}`;
      const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [key]);
      const enabled = row ? (row.value === '1' || row.value === 'true') : false;
      res.json({ enabled });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
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
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
