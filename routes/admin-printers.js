/* ============================================================
   routes/admin-printers.js — 打印机 CRUD
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, formatOrder, buildReceipt, buildKitchenTicket, printToNetworkPrinter, EscPosBuilder, formatGlobalDateTime } = deps;

  app.get('/api/admin/printers', requireAdminKey, async (req, res) => {
    try {
      const rows = await allAsync('SELECT * FROM printers WHERE store_id=? ORDER BY id', [req.storeId || 1]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/printers', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
    try {
      const { name, type, ip_address, port, paper_width, brand, is_default } = req.body || {};
      if (!name) return res.status(400).json({ error: '打印机名称必填' });
      if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [req.storeId || 1]);
      const result = await runAsync(
        'INSERT INTO printers (name, type, ip_address, port, paper_width, brand, is_default, active, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
        [name, type || 'network', ip_address || '', port || 9100, paper_width || 58, brand || 'generic', is_default ? 1 : 0, req.storeId || 1]
      );
      res.status(201).json(await getAsync('SELECT * FROM printers WHERE id=?', [result.lastID]));
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
      const row = await getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
      if (!row) return res.status(404).json({ error: '订单不存在' });
      const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
      if (row.store_id !== printStoreId) return res.status(403).json({ error: '无权访问此订单' });
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
      const store = await getAsync('SELECT name, address FROM stores WHERE id=? AND merchant_id=?', [row.store_id || 1, req.merchantId || 1]);
      const printerId = req.body?.printer_id;
      let printer;
      if (printerId) {
        printer = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=? AND active=1', [printerId, row.store_id]);
      } else {
        printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [row.store_id || 1]);
      }
      const printData = buildReceipt(order, store, printer);
      if (printer && printer.type === 'network' && printer.ip_address) {
        try {
          await printToNetworkPrinter(printData, printer.ip_address, printer.port);
          return res.json({ success: true, printed: true, printer: printer.name });
        } catch (e) {
          return res.status(502).json({ success: false, error: e.message, printData: printData.toString('base64') });
        }
      }
      res.json({ success: true, printed: false, printData: printData.toString('base64'), message: '请使用前端打印' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/orders/:id(\\d+)/print-kitchen', requireAdminOrWaiter, async (req, res) => {
    try {
      const id = req.params.id;
      const row = await getAsync('SELECT * FROM orders WHERE id = ?', [id]);
      if (!row) return res.status(404).json({ error: '订单不存在' });
      const order = formatOrder(row);
      const store = await getAsync('SELECT name, address FROM stores WHERE id=?', [row.store_id || 1]);
      const printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [row.store_id || 1]);
      const printData = buildKitchenTicket(order, store, printer);
      if (printer && printer.type === 'network' && printer.ip_address) {
        try {
          await printToNetworkPrinter(printData, printer.ip_address, printer.port);
          return res.json({ success: true, printed: true });
        } catch (e) {
          return res.status(502).json({ success: false, error: e.message, printData: printData.toString('base64') });
        }
      }
      res.json({ success: true, printed: false, printData: printData.toString('base64') });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/settings/auto-print', requireAdminKey, async (req, res) => {
    try {
      const storeId = req.storeId || 1;
      const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`auto_print_receipt_${storeId}`]);
      const enabled = row ? (row.value === '1' || row.value === 'true') : true;
      res.json({ enabled });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/order-prefixes', requireAdminKey, async (req, res) => {
    try {
      const keys = ['order_prefix_normal', 'order_prefix_refund', 'order_prefix_discount', 'order_prefix_vip', 'order_no_reset_period'];
      const placeholders = keys.map(() => "?").join(",");
      const rows = await allAsync(`SELECT `key`, value FROM settings WHERE `key` IN (${placeholders})`, keys);
      const result = {};
      for (const r of rows) result[r.key] = r.value;
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
      const { normal, refund, discount, vip, daily_reset } = req.body || {};
      const pairs = [
        ['order_prefix_normal', (normal || '11').padStart(2, '0').slice(-2)],
        ['order_prefix_refund', (refund || '01').padStart(2, '0').slice(-2)],
        ['order_prefix_discount', (discount || '21').padStart(2, '0').slice(-2)],
        ['order_prefix_vip', (vip || '61').padStart(2, '0').slice(-2)],
        ['order_no_reset_period', ['daily','monthly','yearly','never'].includes(daily_reset) ? daily_reset : 'daily']
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
      const { enabled } = req.body || {};
      const key = `auto_print_receipt_${storeId}`;
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
      const printer = await getAsync('SELECT * FROM printers WHERE id=? AND active=1', [printer_id]);
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
