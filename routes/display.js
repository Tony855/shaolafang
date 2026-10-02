/* routes/display.js — 展示页配置（按店铺隔离） */
module.exports = function(app, deps) {
  const { allAsync, runAsync, requireAdminKey, requirePermission } = deps;

  const DEFAULTS = {
    mode: 'grid',
    image_duration: 8,
    video_mode: 'full',
    video_duration: 15,
    order: 'default',
    only_active: 1,
    show_price: 1,
    show_desc: 1,
    languages: '["zh"]'
  };

  const KEYS = ['mode','image_duration','video_mode','video_duration','order','only_active','show_price','show_desc','languages'];

  function applyRow(result, key, rawValue) {
    // key 是 'display_mode' 或 'store_2_display_mode' 这类
    const shortKey = key.replace(/^store_\d+_/, '');
    if (!shortKey.startsWith('display_')) return;
    const k = shortKey.slice('display_'.length);
    if (!KEYS.includes(k)) return;

    if (k === 'languages') {
      result[k] = rawValue;
    } else if (['image_duration','video_duration','only_active','show_price','show_desc'].includes(k)) {
      const n = parseInt(rawValue, 10);
      result[k] = Number.isNaN(n) ? DEFAULTS[k] : n;
    } else {
      result[k] = rawValue;
    }
  }

  async function readSettings(storeId) {
    const result = Object.assign({}, DEFAULTS);

    // 1) 全局默认（向后兼容）
    const globalRows = await allAsync(
      "SELECT `key`, value FROM settings WHERE `key` LIKE 'display_%'"
    );
    for (const r of globalRows) applyRow(result, r.key, r.value);

    // 2) 店铺级覆盖
    if (storeId) {
      const storeRows = await allAsync(
        "SELECT `key`, value FROM settings WHERE `key` LIKE ?",
        ['store_' + storeId + '_display_%']
      );
      for (const r of storeRows) applyRow(result, r.key, r.value);
    }
    return result;
  }

  async function writeSettings(storeId, body) {
    if (!storeId) throw new Error('缺少 storeId');
    for (const k of KEYS) {
      if (body[k] === undefined || body[k] === null) continue;
      await runAsync(
        "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        ['store_' + storeId + '_display_' + k, String(body[k])]
      );
    }
  }

  // ----- 商户后台 API -----
  app.get('/api/admin/display-page-settings', requireAdminKey, async (req, res) => {
    try {
      if (!req.storeId) return res.status(400).json({ error: '未指定店铺', code: 'STORE_REQUIRED' });
      res.json(await readSettings(req.storeId));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/display-page-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      if (!req.storeId) return res.status(400).json({ error: '未指定店铺', code: 'STORE_REQUIRED' });
      await writeSettings(req.storeId, req.body || {});
      res.json(await readSettings(req.storeId));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 应用到所有店铺 -----
  app.post('/api/admin/display-page-settings/apply-all', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      if (!req.storeId) return res.status(400).json({ error: '未指定店铺', code: 'STORE_REQUIRED' });

      // 1) 读取当前店铺的配置
      const src = await readSettings(req.storeId);

      // 2) 找出本商户所有店铺
      const stores = await allAsync(
        'SELECT id FROM stores WHERE merchant_id=? ORDER BY id',
        [req.merchantId]
      );
      if (!stores.length) return res.status(400).json({ error: '当前商户没有店铺' });

      // 3) 逐个店铺写入
      let count = 0;
      for (const st of stores) {
        if (String(st.id) === String(req.storeId)) continue; // 跳过自己
        for (const k of KEYS) {
          await runAsync(
            "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
            ['store_' + st.id + '_display_' + k, String(src[k])]
          );
        }
        count++;
      }
      res.json({ success: true, appliedTo: count, source: req.storeId, stores: stores.map(s => s.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ----- 顾客展示页 API -----
  app.get('/api/public/display-page-settings', async (req, res) => {
    try {
      const storeId = parseInt(req.query.store_id || '1', 10) || 1;
      res.json(await readSettings(storeId));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
