/* routes/display.js — 展示页配置（按店铺隔离） */
module.exports = function(app, deps) {
  const { allAsync, runAsync, requireAdminKey, requirePermission } = deps;
  const withTransaction = deps.withTransaction || require('../server/db/helpers').withTransaction;

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
  const NUMERIC_RANGES = {
    image_duration: [1, 300],
    video_duration: [1, 3600],
    only_active: [0, 1],
    show_price: [0, 1],
    show_desc: [0, 1]
  };

  function invalid(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
  }

  function normalizeValue(key, value) {
    if (!KEYS.includes(key)) throw invalid('展示页配置字段无效');
    if (NUMERIC_RANGES[key]) {
      const [min, max] = NUMERIC_RANGES[key];
      const text = typeof value === 'number' ? String(value) : value;
      if (!(typeof text === 'string' && /^(0|[1-9]\d*)$/.test(text))) {
        throw invalid('展示页数值配置无效');
      }
      const number = Number(text);
      if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw invalid('展示页数值超出允许范围');
      }
      return number;
    }
    if (key === 'languages') {
      let languages;
      try {
        languages = typeof value === 'string' ? JSON.parse(value) : value;
      } catch (_) {
        throw invalid('展示语言配置必须是有效 JSON 数组');
      }
      if (!Array.isArray(languages) || languages.length < 1 || languages.length > 10 ||
          languages.some(item => typeof item !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/i.test(item))) {
        throw invalid('展示语言配置无效');
      }
      return JSON.stringify([...new Set(languages)]);
    }
    if (typeof value !== 'string' || !value.trim() || value.length > 32 ||
        /[\u0000-\u001f\u007f]/.test(value)) {
      throw invalid('展示页文本配置无效');
    }
    return value.trim();
  }

  function parseStoreId(value) {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) return null;
    const id = Number(text);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function applyRow(result, key, rawValue) {
    const shortKey = key.replace(/^store_\d+_/, '');
    if (!shortKey.startsWith('display_')) return;
    const settingKey = shortKey.slice('display_'.length);
    if (!KEYS.includes(settingKey)) return;
    try {
      result[settingKey] = normalizeValue(settingKey, rawValue);
    } catch (_) {
      // Invalid legacy rows must never break the public display page.
      result[settingKey] = DEFAULTS[settingKey];
    }
  }

  async function readSettings(storeId) {
    const result = Object.assign({}, DEFAULTS);
    const globalRows = await allAsync(
      "SELECT `key`, value FROM settings WHERE `key` LIKE 'display_%'"
    );
    for (const row of globalRows) applyRow(result, row.key, row.value);
    if (storeId) {
      const storeRows = await allAsync(
        "SELECT `key`, value FROM settings WHERE `key` LIKE ?",
        ['store_' + storeId + '_display_%']
      );
      for (const row of storeRows) applyRow(result, row.key, row.value);
    }
    return result;
  }

  async function writeSettings(storeId, body) {
    if (!parseStoreId(storeId)) throw invalid('门店编号无效');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('展示页配置格式无效');
    const entries = Object.entries(body);
    if (entries.some(([key]) => !KEYS.includes(key))) throw invalid('包含不支持的展示页配置字段');
    const normalized = entries
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, normalizeValue(key, value)]);
    await withTransaction(async () => {
      for (const [key, value] of normalized) {
        await runAsync(
          "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
          ['store_' + storeId + '_display_' + key, String(value)]
        );
      }
    });
  }

  app.get('/api/admin/display-page-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const storeId = parseStoreId(req.storeId);
      if (!storeId) return res.status(400).json({ error: '未指定有效店铺', code: 'STORE_REQUIRED' });
      res.json(await readSettings(storeId));
    } catch (_) { res.status(500).json({ error: '读取展示页配置失败' }); }
  });

  app.post('/api/admin/display-page-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const storeId = parseStoreId(req.storeId);
      if (!storeId) return res.status(400).json({ error: '未指定有效店铺', code: 'STORE_REQUIRED' });
      await writeSettings(storeId, req.body);
      res.json(await readSettings(storeId));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '保存展示页配置失败，所有更改已回滚' });
    }
  });

  app.post('/api/admin/display-page-settings/apply-all', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const storeId = parseStoreId(req.storeId);
      const merchantId = parseStoreId(req.merchantId);
      if (!storeId) return res.status(400).json({ error: '未指定有效店铺', code: 'STORE_REQUIRED' });
      if (!merchantId) return res.status(403).json({ error: '商户信息无效' });
      let appliedTo = 0;
      let storeIds = [];
      await withTransaction(async () => {
        const merchant = await allAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant.length) throw Object.assign(new Error('商户不存在或已停用'), { statusCode: 403 });
        const sourceStore = await allAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [storeId, merchantId]);
        if (!sourceStore.length) throw Object.assign(new Error('当前门店不存在或已停用'), { statusCode: 404 });
        const source = await readSettings(storeId);
        const stores = await allAsync(
          'SELECT id FROM stores WHERE merchant_id=? AND active=1 ORDER BY id FOR UPDATE',
          [merchantId]
        );
        if (!stores.length) throw Object.assign(new Error('当前商户没有可用店铺'), { statusCode: 404 });
        for (const store of stores) {
          storeIds.push(store.id);
          if (String(store.id) === String(storeId)) continue;
          for (const key of KEYS) {
            await runAsync(
              "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
              ['store_' + store.id + '_display_' + key, String(source[key])]
            );
          }
          appliedTo++;
        }
      });
      res.json({ success: true, appliedTo, source: storeId, stores: storeIds });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : '批量应用展示页配置失败，所有更改已回滚' });
    }
  });

  app.get('/api/public/display-page-settings', async (req, res) => {
    try {
      const rawStoreId = req.query.store_id === undefined ? '1' : req.query.store_id;
      const storeId = parseStoreId(rawStoreId);
      if (!storeId) return res.status(400).json({ error: '门店编号无效' });
      res.json(await readSettings(storeId));
    } catch (_) { res.status(500).json({ error: '读取展示页配置失败' }); }
  });
};
