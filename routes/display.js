/* routes/display.js — 展示页配置 */
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

  async function readSettings() {
    const rows = await allAsync("SELECT `key`, value FROM settings WHERE `key` LIKE 'display_%'");
    const result = Object.assign({}, DEFAULTS);
    for (const r of rows) {
      const k = String(r.key).replace(/^display_/, '');
      if (k === 'languages') {
        result[k] = r.value;
      } else if (['image_duration','video_duration','only_active','show_price','show_desc'].includes(k)) {
        const n = parseInt(r.value, 10);
        result[k] = Number.isNaN(n) ? DEFAULTS[k] : n;   // ★ 修 0 被 || 吞掉的 bug
      } else {
        result[k] = r.value;
      }
    }
    return result;
  }

  async function writeSettings(body) {
    const keys = ['mode','image_duration','video_mode','video_duration','order','only_active','show_price','show_desc','languages'];
    for (const k of keys) {
      if (body[k] === undefined || body[k] === null) continue;
      await runAsync(
        "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        ['display_' + k, String(body[k])]
      );
    }
  }

  app.get('/api/admin/display-page-settings', requireAdminKey, async (req, res) => {
    try { res.json(await readSettings()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/display-page-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try { await writeSettings(req.body || {}); res.json(await readSettings()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/public/display-page-settings', async (req, res) => {
    try { res.json(await readSettings()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
};
