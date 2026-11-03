/* ============================================================
   routes/admin-settings.js — 货币 + 显示设置 + 通知设置
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, withTransaction, requireAdminKey, requirePermission } = deps;

  function normalizeCurrency(input) {
    const code = String(input?.code || '').trim().toUpperCase();
    const symbol = String(input?.symbol || '').trim();
    const name = String(input?.name || '').trim();
    const rate = Number(input?.rate);
    if (!/^[A-Z0-9]{3,10}$/.test(code)) return { error: '货币代码必须为 3-10 位英文字母或数字' };
    if (!symbol || symbol.length > 8 || /[<>&"'\x60\u0000-\u001f\u007f]/.test(symbol)) return { error: '货币符号无效或包含不允许的字符' };
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return { error: '货币名称无效' };
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1e12) return { error: '汇率必须大于 0 且不超过 1e12' };
    return { value: { code, symbol, name, rate } };
  }

  app.get('/api/currencies', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try { res.json(await allAsync('SELECT * FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code', [req.merchantId])); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/currencies', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const normalized = normalizeCurrency(req.body || {});
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      const { code, symbol, name, rate } = normalized.value;
      const is_default = !!req.body?.is_default;
      let createdCurrency;
      await withTransaction(async () => {
        if (is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
        const result = await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)', [req.merchantId, code, symbol, name, rate, is_default ? 1 : 0]);
        createdCurrency = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [result.lastID, req.merchantId]);
      });
      res.status(201).json(createdCurrency);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [req.params.id, req.merchantId]);
      if (!current) return res.status(404).json({ error: '货币不存在' });
      const next = normalizeCurrency({ ...current, ...(req.body || {}) });
      if (next.error) return res.status(400).json({ error: next.error });
      const { code, symbol, name, rate } = next.value;
      const is_default = req.body?.is_default === undefined ? !!current.is_default : !!req.body.is_default;
      await withTransaction(async () => {
        if (is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
        await runAsync('UPDATE currencies SET code=?,symbol=?,name=?,rate=?,is_default=? WHERE id=? AND merchant_id=?', [code, symbol, name, rate, is_default ? 1 : 0, current.id, req.merchantId]);
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
  app.get('/api/admin/display-settings', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const sid = req.storeId || 1;
      const primaryRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`store_${sid}_primary_currency_code`]);
      const secondaryRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`store_${sid}_secondary_currency_code`]);
      res.json({
        primaryCurrencyCode: (primaryRow && primaryRow.value) || 'USD',
        secondaryCurrencyCode: (secondaryRow && secondaryRow.value) || '',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/display-settings', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const sid = req.storeId || 1;
      const { primaryCurrencyCode, secondaryCurrencyCode } = req.body || {};
      const pCode = String(primaryCurrencyCode || 'USD').trim().toUpperCase();
      const sCode = String(secondaryCurrencyCode || '').trim().toUpperCase();

      // 校验币种代码并确认两个币种均属于当前商户。
      if (!/^[A-Z0-9]{3,10}$/.test(pCode) || (sCode && !/^[A-Z0-9]{3,10}$/.test(sCode))) {
        return res.status(400).json({ error: '货币代码无效' });
      }
      if (sCode && sCode === pCode) {
        return res.status(400).json({ error: '副货币不能和主货币相同' });
      }
      const primaryCurrency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [pCode, req.merchantId]);
      if (!primaryCurrency) return res.status(400).json({ error: '主货币不存在' });
      if (sCode) {
        const secondaryCurrency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [sCode, req.merchantId]);
        if (!secondaryCurrency) return res.status(400).json({ error: '副货币不存在' });
      }

      await runAsync(
        "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        [`store_${sid}_primary_currency_code`, pCode]
      );
      await runAsync(
        "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        [`store_${sid}_secondary_currency_code`, sCode]
      );

      // 可选：应用到所有店铺
      if (req.body.applyAll) {
        const stores = await allAsync('SELECT id FROM stores WHERE merchant_id=?', [req.merchantId || 1]);
        for (const st of stores) {
          if (String(st.id) === String(sid)) continue;
          await runAsync(
            "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
            [`store_${st.id}_primary_currency_code`, pCode]
          );
          await runAsync(
            "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
            [`store_${st.id}_secondary_currency_code`, sCode]
          );
        }
      }

      res.json({ success: true, primaryCurrencyCode: pCode, secondaryCurrencyCode: sCode });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 新订单提示音设置 -----
  app.get('/api/admin/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const mid = req.merchantId || 1;
      const sid = req.storeId || 1;
      const storeRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`store_${sid}_new_order_sound_enabled`]);
      const merRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_new_order_sound_enabled`]);
      const globalRow = await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
      const row = storeRow || merRow || globalRow;
      res.json({ enabled: row ? row.value === '1' : true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const sid = req.storeId || 1;
      const enabled = req.body.enabled ? '1' : '0';
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`store_${sid}_new_order_sound_enabled`, enabled]);
      res.json({ success: true, enabled: enabled === '1' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
