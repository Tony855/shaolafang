/* ============================================================
   routes/admin-settings.js — 货币 + 显示设置 + 通知设置
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, withTransaction, requireAdminKey, requirePermission } = deps;

  app.get('/api/currencies', requireAdminKey, async (req, res) => {
    try { res.json(await allAsync('SELECT * FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code', [req.merchantId])); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/currencies', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const { code, symbol, name, rate, is_default } = req.body;
      if (!code || !symbol || !name || !(Number(rate) > 0)) return res.status(400).json({ error: '货币资料不完整' });
      await withTransaction(async () => {
        if (is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
        const result = await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)', [req.merchantId, String(code).toUpperCase(), symbol, name, Number(rate), is_default ? 1 : 0]);
        res.status(201).json(await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [result.lastID, req.merchantId]));
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [req.params.id, req.merchantId]);
      if (!current) return res.status(404).json({ error: '货币不存在' });
      const next = { ...current, ...req.body };
      if (!(Number(next.rate) > 0)) return res.status(400).json({ error: '汇率必须大于 0' });
      await withTransaction(async () => {
        if (next.is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
        await runAsync('UPDATE currencies SET code=?,symbol=?,name=?,rate=?,is_default=? WHERE id=? AND merchant_id=?', [String(next.code).toUpperCase(), next.symbol, next.name, Number(next.rate), next.is_default ? 1 : 0, current.id, req.merchantId]);
      });
      res.json(await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [current.id, req.merchantId]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [req.params.id, req.merchantId]);
      if (!current) return res.status(404).json({ error: '货币不存在' });
      if (current.is_default) return res.status(409).json({ error: '默认货币不能删除，请先设置其他默认货币' });
      await runAsync('DELETE FROM currencies WHERE id=? AND merchant_id=?', [current.id, req.merchantId]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 显示设置 -----
  app.get('/api/admin/display-settings', requireAdminKey, async (req, res) => {
    try {
      const mid = req.merchantId || 1;
      const enabled = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_dual_currency_enabled`]);
      const secondary = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_secondary_currency_code`]);
      const enabledFallback = enabled || await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
      const secondaryFallback = secondary || await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
      res.json({ enabled: enabledFallback?.value === '1', secondaryCurrencyCode: secondaryFallback?.value || 'USD' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/display-settings', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const mid = req.merchantId || 1;
      const enabled = req.body.enabled ? '1' : '0';
      const secondary = String(req.body.secondaryCurrencyCode || 'USD');
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_dual_currency_enabled`, enabled]);
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_secondary_currency_code`, secondary]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 新订单提示音设置 -----
  app.get('/api/admin/notification-settings', requireAdminKey, async (req, res) => {
    try {
      const mid = req.merchantId || 1;
      const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_new_order_sound_enabled`]);
      const fallback = row || await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
      res.json({ enabled: fallback ? fallback.value === '1' : true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const mid = req.merchantId || 1;
      const enabled = req.body.enabled ? '1' : '0';
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_new_order_sound_enabled`, enabled]);
      res.json({ success: true, enabled: enabled === '1' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
