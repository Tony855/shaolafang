/* ============================================================
   routes/public.js — 公开接口（无需登录）
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync } = deps;

  function boundedSetting(value, fallback, min, max) {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^(0|[1-9]\d*)$/.test(text)) return fallback;
    const number = Number(text);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
  }

  function settingFlag(value, fallback = true) {
    if ([true, 1, '1', 'true'].includes(value)) return true;
    if ([false, 0, '0', 'false'].includes(value)) return false;
    return fallback;
  }

  app.get('/api/public/config', async (req, res) => {
    try {
      const storeId = Number(req.query.store_id ?? 1);
      if (!Number.isSafeInteger(storeId) || storeId <= 0) return res.status(400).json({ error: '店铺编号无效' });
      const store = await getAsync('SELECT s.id, s.merchant_id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1', [storeId]);
      if (!store) return res.status(404).json({ error: '店铺不存在或已停用' });
      const merchantId = store.merchant_id;
      const currencies = await allAsync(
        'SELECT code, symbol, name, rate, is_default FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code',
        [merchantId]
      );
      // 简化：只读店铺级
      const primaryRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`store_${storeId}_primary_currency_code`]);
      const secondaryRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`store_${storeId}_secondary_currency_code`]);

      const primaryCode = (primaryRow && primaryRow.value) || 'USD';
      const secondaryCode = (secondaryRow && secondaryRow.value) || '';

      const primaryCurrency = currencies.find(c => c.code === primaryCode) || currencies.find(c => c.is_default) || currencies[0] || { code: 'USD', symbol: '$', rate: 1 };
      const secondaryCurrency = secondaryCode ? (currencies.find(c => c.code === secondaryCode) || null) : null;
      const soundRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`store_${storeId}_new_order_sound_enabled`])
                    || await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_new_order_sound_enabled`])
                    || await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
      const keys = [
        'waiter_refresh_interval', 'kitchen_auto_hide_minutes', 'max_order_items',
        'max_item_quantity', 'max_order_note_length', 'order_interval_seconds',
        'call_limit_enabled', 'call_limit_max', 'call_limit_window_minutes', 'call_limit_cooldown_minutes',
      ];
      const placeholders = keys.map(() => '?').join(',');
      const rows = await allAsync(`SELECT \`key\`, value FROM settings WHERE \`key\` IN (${placeholders})`, keys);
      const s = {};
      rows.forEach(r => { s[r.key] = r.value; });
      const constraints = {
        order: {
          maxItemTypes: boundedSetting(s.max_order_items, 50, 1, 200),
          maxPerItem: boundedSetting(s.max_item_quantity, 100, 1, 1000),
          maxNoteLength: boundedSetting(s.max_order_note_length, 200, 0, 2000),
          minIntervalSec: boundedSetting(s.order_interval_seconds, 30, 1, 3600),
        },
        call: {
          enabled: settingFlag(s.call_limit_enabled, true),
          maxPerWindow: boundedSetting(s.call_limit_max, 3, 1, 100),
          windowMinutes: boundedSetting(s.call_limit_window_minutes, 5, 1, 1440),
          cooldownMinutes: boundedSetting(s.call_limit_cooldown_minutes, 10, 1, 1440),
        },
      };
      res.json({
        currencies,
        primaryCurrency,
        secondaryCurrency,
        // 兼容旧字段
        defaultCurrency: primaryCurrency,
        dualCurrency: { enabled: !!secondaryCurrency, currency: secondaryCurrency },
        newOrderSoundEnabled: soundRow ? soundRow.value === '1' : true,
        constraints,
        waiter_refresh_interval: boundedSetting(s.waiter_refresh_interval, 8, 1, 300),
        kitchen_auto_hide_minutes: boundedSetting(s.kitchen_auto_hide_minutes, 10, 0, 1440),
        max_order_items: constraints.order.maxItemTypes,
        max_item_quantity: constraints.order.maxPerItem,
        max_order_note_length: constraints.order.maxNoteLength,
      });
    } catch (e) { res.status(500).json({ error: '读取公开配置失败' }); }
  });

  app.get('/api/public/store-info', async (req, res) => {
    try {
      const storeId = Number(req.query.store_id ?? 1);
      if (!Number.isSafeInteger(storeId) || storeId <= 0) return res.status(400).json({ error: '店铺编号无效' });
      const store = await getAsync('SELECT s.id, s.name, s.address FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1', [storeId]);
      if (!store) return res.status(404).json({ error: '店铺不存在或已停用' });
      res.json(store);
    } catch (e) { res.status(500).json({ error: '公开接口请求失败，请稍后重试' }); }
  });

  app.get('/api/public/categories', async (req, res) => {
    try {
      const storeId = Number(req.query.store_id ?? 1);
      if (!Number.isSafeInteger(storeId) || storeId <= 0) return res.status(400).json({ error: '店铺编号无效' });
      const store = await getAsync('SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1', [storeId]);
      if (!store) return res.status(404).json({ error: '店铺不存在或已停用' });
      const rows = await allAsync('SELECT id, name, sort FROM menu_categories WHERE store_id=? ORDER BY sort', [storeId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: '公开接口请求失败，请稍后重试' }); }
  });

  // ★ KHQR 银行列表（给前端拉取图标映射）
  app.get('/api/public/khqr/banks', async (req, res) => {
    try {
      const { BANKS, DEFAULT_BANK } = require('../server/config/khqr-banks');
      const { VIETQR_BANKS } = require('../server/config/vietqr-banks');
      const { resolveIcon } = require('../server/services/icon-resolver');

      // ★ 大小写不敏感：把配置里的 icon 名解析成磁盘真实文件名
      const resolve = (b) => ({ name: b.name, icon: resolveIcon(b.icon) });

      const khBanks = BANKS.map(resolve);
      const vnBanks = Object.values(VIETQR_BANKS).map(resolve);

      // 按 name 去重（KB 和 VN 可能有同名，取第一个）
      const seen = new Set();
      const allBanks = [];
      for (const b of [...khBanks, ...vnBanks]) {
        const k = b.name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        allBanks.push(b);
      }

      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json({
        banks: allBanks,
        defaultBank: { name: DEFAULT_BANK.name, icon: resolveIcon(DEFAULT_BANK.icon) },
      });
    } catch (e) {
      res.status(500).json({ error: '读取银行列表失败' });
    }
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'foodflow', timestamp: new Date().toISOString() }));
};
