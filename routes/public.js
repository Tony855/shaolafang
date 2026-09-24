/* ============================================================
   routes/public.js — 公开接口（无需登录）
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync } = deps;

  app.get('/api/public/config', async (req, res) => {
    try {
      const storeId = parseInt(req.query.store_id || '1', 10);
      const store = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [storeId]);
      const merchantId = store?.merchant_id || 1;
      const currencies = await allAsync(
        'SELECT code, symbol, name, rate, is_default FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code',
        [merchantId]
      );
      const dualRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_dual_currency_enabled`])
                   || await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
      const secondaryRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_secondary_currency_code`])
                        || await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
      const secondaryCurrency = currencies.find(c => c.code === secondaryRow?.value) || null;
      const soundRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_new_order_sound_enabled`])
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
          maxItemTypes: parseInt(s.max_order_items || '50', 10),
          maxPerItem: parseInt(s.max_item_quantity || '100', 10),
          maxNoteLength: parseInt(s.max_order_note_length || '200', 10),
          minIntervalSec: parseInt(s.order_interval_seconds || '30', 10),
        },
        call: {
          enabled: (s.call_limit_enabled || '1') !== '0',
          maxPerWindow: parseInt(s.call_limit_max || '3', 10),
          windowMinutes: parseInt(s.call_limit_window_minutes || '5', 10),
          cooldownMinutes: parseInt(s.call_limit_cooldown_minutes || '10', 10),
        },
      };
      res.json({
        currencies,
        defaultCurrency: currencies.find(c => c.is_default) || currencies[0] || { code: 'USD', symbol: '$', rate: 1 },
        dualCurrency: { enabled: dualRow?.value === '1', currency: secondaryCurrency },
        newOrderSoundEnabled: soundRow ? soundRow.value === '1' : true,
        constraints,
        waiter_refresh_interval: parseInt(s.waiter_refresh_interval || '8', 10),
        kitchen_auto_hide_minutes: parseInt(s.kitchen_auto_hide_minutes || '10', 10),
        max_order_items: constraints.order.maxItemTypes,
        max_item_quantity: constraints.order.maxPerItem,
        max_order_note_length: constraints.order.maxNoteLength,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/public/store-info', async (req, res) => {
    try {
      const storeId = parseInt(req.query.store_id || '1', 10);
      const store = await getAsync('SELECT id, name, address FROM stores WHERE id=? AND active=1', [storeId]);
      if (!store) return res.status(404).json({ error: '店铺不存在' });
      res.json(store);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/public/categories', async (req, res) => {
    try {
      const storeId = parseInt(req.query.store_id || '1', 10);
      const rows = await allAsync('SELECT id, name, sort FROM menu_categories WHERE store_id=? ORDER BY sort', [storeId]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ordering-system', timestamp: new Date().toISOString() }));
};
