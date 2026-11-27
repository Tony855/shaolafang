const { parsePositiveRouteId } = require('../server/services/route-id');
const { normalizeRouteError } = require('../server/utils/http-error');
const { validateChatId, getTelegramBotUsername, getTelegramGroupChats } = require('../server/services/telegram-bot');
const { createStoreEntrySignature } = require('../server/services/telegram-store-entry');
/* ============================================================
   routes/admin-settings.js — 货币 + 显示设置 + 通知设置
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, withTransaction, requireAdminKey, requirePermission, getClientIp } = deps;

  async function getStoreEntryLink(storeId, chatId) {
    const secret = String(process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET || '');
    if (!chatId || secret.length < 32 || secret.length > 256) return null;
    const rows = await allAsync(
      'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
      ['telegram_client_bot_enabled', 'telegram_client_bot_token']
    );
    const config = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
    if (config.telegram_client_bot_enabled !== '1') return null;
    const token = String(config.telegram_client_bot_token || '');
    if (!token) return null;
    const username = await getTelegramBotUsername({ token });
    const signature = createStoreEntrySignature({ storeId, chatId, secret });
    return 'https://t.me/' + username + '?start=delivery_' + storeId + '_' + signature;
  }

  function normalizeCurrencyFlag(value, fallback) {
    if (value === undefined) return fallback;
    if ([true, 1, '1'].includes(value)) return 1;
    if ([false, 0, '0'].includes(value)) return 0;
    throw Object.assign(new Error('默认货币标记必须为 true/false'), { status: 400 });
  }

  async function writeCurrencyAudit(req, action, currencyId, details, targetType = 'currency') {
    const actor = req.adminId
      ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, req.merchantId])
      : null;
    await runAsync(
      'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['merchant_admin', req.adminId || null, actor?.username || '', action, targetType, currencyId || null,
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
    catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
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
      const safeError = normalizeRouteError(e, '创建货币失败，所有更改已回滚');
      res.status(safeError.status).json({ error: safeError.message });
    }
  });

  app.put('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
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
      const safeError = normalizeRouteError(e, '更新货币失败，所有更改已回滚');
      res.status(safeError.status).json({ error: safeError.message });
    }
  });

  app.delete('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const id = parsePositiveRouteId(req.params.id);
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
    } catch (e) { const safeError = normalizeRouteError(e, '删除货币失败，所有更改已回滚');
      res.status(safeError.status).json({ error: safeError.message }); }
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
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/admin/display-settings', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
    try {
      const body = req.body || {};
      const merchantId = Number(req.merchantId);
      const sid = Number(req.storeId || 1);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || !Number.isSafeInteger(sid) || sid <= 0) {
        return res.status(400).json({ error: '商户或门店编号无效' });
      }
      const { primaryCurrencyCode, secondaryCurrencyCode } = body;
      const pCode = String(primaryCurrencyCode || 'USD').trim().toUpperCase();
      const sCode = String(secondaryCurrencyCode || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{3,10}$/.test(pCode) || (sCode && !/^[A-Z0-9]{3,10}$/.test(sCode))) {
        return res.status(400).json({ error: '货币代码无效' });
      }
      if (sCode && sCode === pCode) return res.status(400).json({ error: '副货币不能和主货币相同' });
      const applyAll = normalizeCurrencyFlag(body.applyAll, 0);

      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const currentStore = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [sid, merchantId]);
        if (!currentStore) throw Object.assign(new Error('当前门店不存在或已停用'), { status: 404 });
        const primaryCurrency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [pCode, merchantId]);
        if (!primaryCurrency) throw Object.assign(new Error('主货币不存在'), { status: 400 });
        if (sCode) {
          const secondaryCurrency = await getAsync('SELECT code FROM currencies WHERE code=? AND merchant_id=?', [sCode, merchantId]);
          if (!secondaryCurrency) throw Object.assign(new Error('副货币不存在'), { status: 400 });
        }

        const stores = applyAll
          ? (req.isPrimaryAdmin !== false
            ? await allAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id FOR UPDATE', [merchantId])
            : await allAsync(
                'SELECT s.id FROM merchant_admin_store_access a JOIN stores s ON s.id=a.store_id AND s.merchant_id=a.merchant_id WHERE a.merchant_id=? AND a.admin_id=? AND s.active=1 ORDER BY s.id FOR UPDATE',
                [merchantId, req.adminId]
              ))
          : [{ id: sid }];
        for (const store of stores) {
          await runAsync(
            "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
            [`store_${store.id}_primary_currency_code`, pCode]
          );
          await runAsync(
            "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
            [`store_${store.id}_secondary_currency_code`, sCode]
          );
        }
        await writeCurrencyAudit(req, 'update_currency_display_settings', sid,
          { primaryCurrencyCode: pCode, secondaryCurrencyCode: sCode, applyAll: !!applyAll }, 'store');
      });
      res.json({ success: true, primaryCurrencyCode: pCode, secondaryCurrencyCode: sCode });
    } catch (e) { const safeError = normalizeRouteError(e, '更新货币显示设置失败，所有更改已回滚');
      res.status(safeError.status).json({ error: safeError.message }); }
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
    } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
  });

  app.post('/api/admin/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const body = req.body || {};
      const merchantId = Number(req.merchantId);
      const storeId = Number(req.storeId);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || !Number.isSafeInteger(storeId) || storeId <= 0) {
        return res.status(400).json({ error: '商户或门店编号无效' });
      }
      if (![true, false, 0, 1, '0', '1'].includes(body.enabled)) {
        return res.status(400).json({ error: '提示音开关值无效' });
      }
      const enabled = [true, 1, '1'].includes(body.enabled) ? '1' : '0';
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [storeId, merchantId]);
        if (!store) throw Object.assign(new Error('门店不存在或已停用'), { status: 404 });
        await runAsync(
          "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
          [`store_${storeId}_new_order_sound_enabled`, enabled]
        );
        await writeCurrencyAudit(req, 'update_notification_setting', storeId, { new_order_sound_enabled: enabled === '1' }, 'store');
      });
      res.json({ success: true, enabled: enabled === '1' });
    } catch (e) { const safeError = normalizeRouteError(e, '更新提示音设置失败，所有更改已回滚');
      res.status(safeError.status).json({ error: safeError.message }); }
  });

  

  // Discover group/supergroup Chat IDs using the platform Admin Bot.
  // This endpoint returns identifiers only; it never returns message text or sender data.
  app.get('/api/admin/telegram/group-chats', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = Number(req.merchantId);
      const storeId = Number(req.storeId);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || !Number.isSafeInteger(storeId) || storeId <= 0) {
        return res.status(400).json({ error: '商户或门店编号无效' });
      }
      const store = await getAsync(
        'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1 LIMIT 1',
        [storeId, merchantId]
      );
      if (!store) return res.status(404).json({ error: '当前门店不存在或已停用' });
      const settings = await allAsync(
        'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
        ['telegram_admin_bot_enabled', 'telegram_admin_bot_token']
      );
      const config = Object.fromEntries((Array.isArray(settings) ? settings : []).map(row => [row.key, row.value]));
      if (config.telegram_admin_bot_enabled !== '1' || !String(config.telegram_admin_bot_token || '')) {
        return res.status(409).json({ error: '平台 Admin Bot 尚未配置或启用，请联系超级管理员' });
      }
      const chats = await getTelegramGroupChats({ token: String(config.telegram_admin_bot_token) });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ chats, hint: chats.length ? '' : '暂未发现群组。请先把 Admin Bot 拉入群组，并在群内发送 /start@Bot用户名，然后重新获取。' });
    } catch (error) {
      const message = String(error?.message || '');
      const safeMessage = /Admin Bot|Telegram|群组|Webhook/.test(message)
        ? message : 'Telegram 群组读取失败，请稍后重试';
      res.status(502).json({ error: safeMessage });
    }
  });

  // ----- 门店级 Telegram 管理员通知收件人 -----
  app.get('/api/admin/telegram/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = Number(req.merchantId);
      const storeId = Number(req.storeId);
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || !Number.isSafeInteger(storeId) || storeId <= 0) {
        return res.status(400).json({ error: '商户或门店编号无效' });
      }
      const row = await getAsync(
        'SELECT r.chat_id, r.is_enabled, r.notify_order_created, r.notify_settled, r.notify_refunded FROM telegram_store_admin_recipients r JOIN stores s ON s.id=r.store_id AND s.merchant_id=r.merchant_id JOIN merchants m ON m.id=r.merchant_id WHERE r.merchant_id=? AND r.store_id=? AND s.active=1 AND m.status=1 LIMIT 1',
        [merchantId, storeId]
      );
      const bot = await getAsync("SELECT value FROM settings WHERE `key`='telegram_admin_bot_enabled'");
      let storeEntryLink = null;
      try { storeEntryLink = await getStoreEntryLink(storeId, Number(row?.is_enabled) === 1 ? String(row?.chat_id || '') : ''); } catch (_) {}
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({
        enabled: Boolean(row && Number(row.is_enabled) === 1 && validateChatId(String(row.chat_id || ''))),
        chatId: String(row?.chat_id || ''),
        storeEntryLink,
        notifyOrderCreated: row ? Number(row.notify_order_created) === 1 : true,
        notifySettled: row ? Number(row.notify_settled) === 1 : true,
        notifyRefunded: row ? Number(row.notify_refunded) === 1 : true,
        globalBotEnabled: bot?.value === '1'
      });
    } catch (_) {
      res.status(500).json({ error: 'Telegram 门店通知设置读取失败' });
    }
  });

  app.put('/api/admin/telegram/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    let failureStage = 'validate';
    try {
      const merchantId = Number(req.merchantId);
      const storeId = Number(req.storeId);
      const body = req.body || {};
      if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || !Number.isSafeInteger(storeId) || storeId <= 0) {
        return res.status(400).json({ error: '商户或门店编号无效' });
      }
      const readFlag = (value, fallback, label) => {
        if (value === undefined) return fallback ? 1 : 0;
        if ([true, 1, '1'].includes(value)) return 1;
        if ([false, 0, '0'].includes(value)) return 0;
        throw Object.assign(new Error(label + ' 参数无效'), { status: 400 });
      };
      const notifyOrderCreated = readFlag(body.notifyOrderCreated, true, '新订单通知开关');
      const notifySettled = readFlag(body.notifySettled, true, '收款通知开关');
      const notifyRefunded = readFlag(body.notifyRefunded, true, '退款通知开关');
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (chatId.length > 64 || (chatId && !validateChatId(chatId))) {
        return res.status(400).json({ error: 'Telegram Chat ID 无效' });
      }
      // A configured Chat ID is the store's default binding. Clearing it unbinds the store.
      const enabled = chatId ? 1 : 0;

      failureStage = 'transaction_start';
      await withTransaction(async () => {
        failureStage = 'merchant_lock';
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        failureStage = 'store_lock';
        const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [storeId, merchantId]);
        if (!store) throw Object.assign(new Error('门店不存在或已停用'), { status: 404 });
        // Store binding is saved independently of platform Bot availability.
        // Delivery remains fail-closed in the notification worker until Super Admin enables the Bot.
        failureStage = 'recipient_upsert';
        await runAsync(
          'INSERT INTO telegram_store_admin_recipients (merchant_id, store_id, chat_id, is_enabled, notify_order_created, notify_settled, notify_refunded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE chat_id=VALUES(chat_id), is_enabled=VALUES(is_enabled), notify_order_created=VALUES(notify_order_created), notify_settled=VALUES(notify_settled), notify_refunded=VALUES(notify_refunded), updated_at=UTC_TIMESTAMP(3)',
          [merchantId, storeId, chatId, enabled, notifyOrderCreated, notifySettled, notifyRefunded]
        );

        // A disabled store or event toggle is a terminal decision for queued
        // notices. Do this in the same transaction as the settings update so
        // re-enabling later cannot release an old backlog.
        failureStage = 'outbox_suppression';
        if (!enabled) {
          await runAsync(
            "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='event_disabled', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='merchant_store' AND merchant_id=? AND store_id=? AND state IN ('pending','processing')",
            [merchantId, storeId]
          );
        } else {
          for (const [eventType, eventEnabled] of [
            ['order.created', notifyOrderCreated],
            ['order.settled', notifySettled],
            ['order.refunded', notifyRefunded]
          ]) {
            if (eventEnabled) continue;
            await runAsync(
              "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='event_disabled', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='merchant_store' AND merchant_id=? AND store_id=? AND event_type=? AND state IN ('pending','processing')",
              [merchantId, storeId, eventType]
            );
          }
        }
        failureStage = 'audit_write';
        await writeCurrencyAudit(req, 'update_telegram_store_notifications', storeId, {
          enabled: !!enabled,
          chat_id_configured: !!chatId,
          notify_order_created: !!notifyOrderCreated,
          notify_settled: !!notifySettled,
          notify_refunded: !!notifyRefunded
        }, 'store');
      });
      let storeEntryLink = null;
      try { storeEntryLink = await getStoreEntryLink(storeId, chatId); } catch (_) { /* Binding is saved; link can be refreshed after Bot configuration is available. */ }
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ success: true, enabled: !!enabled, chatId, storeEntryLink, notifyOrderCreated: !!notifyOrderCreated, notifySettled: !!notifySettled, notifyRefunded: !!notifyRefunded });
    } catch (error) {
      const safeError = normalizeRouteError(error, 'Telegram 门店通知设置保存失败，所有更改已回滚');
      if (!safeError.isClientError) {
        // Never log request bodies, Chat IDs, Bot tokens, SQL text, or raw error messages.
        console.error('[telegram-store-notification-settings] save failed', {
          stage: failureStage,
          code: String(error.code || '').slice(0, 40),
          errno: Number.isFinite(Number(error.errno)) ? Number(error.errno) : null,
          sqlState: /^[0-9A-Z]{5}$/.test(String(error.sqlState || '')) ? error.sqlState : null
        });
      }
      res.status(safeError.status).json({ error: safeError.message });
    }
  });
};
