/* ============================================================
   routes/admin-settings.js — 货币 + 显示设置 + 通知设置
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, withTransaction, requireAdminKey, requirePermission, getClientIp } = deps;

  function normalizeCurrencyFlag(value, fallback) {
    if (value === undefined) return fallback;
    if ([true, 1, '1'].includes(value)) return 1;
    if ([false, 0, '0'].includes(value)) return 0;
    throw Object.assign(new Error('默认货币标记必须为 true/false'), { status: 400 });
  }

  async function writeCurrencyAudit(req, action, currencyId, details) {
    const actor = req.adminId
      ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, req.merchantId])
      : null;
    await runAsync(
      'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['merchant_admin', req.adminId || null, actor?.username || '', action, 'currency', currencyId || null,
        JSON.stringify(details), getClientIp(req), new Date().toISOString()]
    );
  }

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
      const body = req.body || {};
      const normalized = normalizeCurrency(body);
      if (normalized.error) return res.status(400).json({ error: normalized.error });
      const { code, symbol, name, rate } = normalized.value;
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0) return res.status(403).json({ error: '商户信息无效' });
      let isDefault = normalizeCurrencyFlag(body.is_default, 0);
      let createdCurrency;
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const countRow = await getAsync('SELECT COUNT(*) AS count FROM currencies WHERE merchant_id=?', [merchantId]);
        if (Number(countRow?.count || 0) === 0) isDefault = 1;
        if (isDefault) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [merchantId]);
        const result = await runAsync(
          'INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)',
          [merchantId, code, symbol, name, rate, isDefault]
        );
        createdCurrency = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [result.lastID, merchantId]);
        await writeCurrencyAudit(req, 'create_currency', result.lastID, { code, name, rate, is_default: isDefault });
      });
      res.status(201).json(createdCurrency);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该商户已存在此货币代码' });
      res.status(e.status || 500).json({ error: e.status ? e.message : '创建货币失败，所有更改已回滚' });
    }
  });

  app.put('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const merchantId = Number(req.merchantId);
      const body = req.body || {};
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '货币或商户编号无效' });
      }
      let updatedCurrency;
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
        if (!current) throw Object.assign(new Error('货币不存在'), { status: 404 });
        const normalized = normalizeCurrency({ ...current, ...body });
        if (normalized.error) throw Object.assign(new Error(normalized.error), { status: 400 });
        const { code, symbol, name, rate } = normalized.value;
        const isDefault = normalizeCurrencyFlag(body.is_default, Number(current.is_default));
        if (isDefault === 0 && Number(current.is_default) === 1) {
          const replacement = await getAsync(
            'SELECT id FROM currencies WHERE merchant_id=? AND id<>? ORDER BY id LIMIT 1 FOR UPDATE',
            [merchantId, id]
          );
          if (!replacement) throw Object.assign(new Error('至少保留一个默认货币，请先创建其他货币'), { status: 409 });
          await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [merchantId]);
          await runAsync('UPDATE currencies SET is_default=1 WHERE id=? AND merchant_id=?', [replacement.id, merchantId]);
        } else if (isDefault === 1) {
          await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [merchantId]);
        }
        await runAsync(
          'UPDATE currencies SET code=?,symbol=?,name=?,rate=?,is_default=? WHERE id=? AND merchant_id=?',
          [code, symbol, name, rate, isDefault, id, merchantId]
        );
        await writeCurrencyAudit(req, 'update_currency', id, { code, name, rate, is_default: isDefault });
        updatedCurrency = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [id, merchantId]);
      });
      res.json(updatedCurrency);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该商户已存在此货币代码' });
      res.status(e.status || 500).json({ error: e.status ? e.message : '更新货币失败，所有更改已回滚' });
    }
  });

  app.delete('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const merchantId = Number(req.merchantId);
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
        return res.status(400).json({ error: '货币或商户编号无效' });
      }
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
        if (!current) throw Object.assign(new Error('货币不存在'), { status: 404 });
        if (Number(current.is_default) === 1) throw Object.assign(new Error('默认货币不能删除，请先设置其他默认货币'), { status: 409 });
        const usedByMenus = await getAsync('SELECT COUNT(*) AS count FROM menus WHERE currency_code=? AND merchant_id=?', [current.code, merchantId]);
        if (Number(usedByMenus?.count || 0) > 0) {
          throw Object.assign(new Error('该货币仍被菜品使用，不能删除'), { status: 409 });
        }
        const stores = await allAsync('SELECT id FROM stores WHERE merchant_id=?', [merchantId]);
        for (const store of stores) {
          for (const suffix of ['primary_currency_code', 'secondary_currency_code']) {
            const setting = await getAsync('SELECT value FROM settings WHERE `key`=?', [`store_${store.id}_${suffix}`]);
            if (setting?.value === current.code) {
              throw Object.assign(new Error('该货币仍被门店显示设置使用，不能删除'), { status: 409 });
            }
          }
        }
        await runAsync('DELETE FROM currencies WHERE id=? AND merchant_id=?', [id, merchantId]);
        await writeCurrencyAudit(req, 'delete_currency', id, { code: current.code, name: current.name });
      });
      res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : '删除货币失败，所有更改已回滚' }); }
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
