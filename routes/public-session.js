/* ============================================================
   routes/public-session.js — 二维码 + 桌台 session
   ============================================================ */
const crypto = require('crypto');
const QRCode = require('qrcode');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, formatOrder } = deps;

  app.get('/api/qrcode/:table', async (req, res) => {
    try {
      const storeId = parseInt(req.query.store_id || req.get('X-Store-Id') || '1', 10) || 1;
      const table = await getAsync('SELECT name, store_id FROM tables WHERE name=? AND store_id=?', [req.params.table, storeId]);
      if (!table) return res.status(404).json({ error: '桌号不存在' });
      const url = `${req.protocol}://${req.get('host')}/?table=${encodeURIComponent(table.name)}`;
      const qrDataUrl = await QRCode.toDataURL(url);
      res.json({ qrDataUrl, url, table: table.name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tables/:id/qrcode', requireAdminKey, async (req, res) => {
    try {
      const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ? AND store_id = ?', [req.params.id, req.storeId]);
      if (!table) return res.status(404).json({ error: '桌号不存在' });
      const store = await getAsync('SELECT name FROM stores WHERE id = ?', [table.store_id || 1]);
      const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
      const qrDataUrl = await QRCode.toDataURL(url);
      res.json({ qrDataUrl, url, table: table.name, storeName: store?.name || '' });
    } catch (e) {
      res.status(500).json({ error: '生成二维码失败' });
    }
  });

  // ----- 顾客二维码桌码解析 -----
  app.get('/api/public/table-token/:token', async (req, res) => {
    try {
      const table = await getAsync('SELECT name, store_id FROM tables WHERE qr_token=?', [req.params.token]);
      if (!table) return res.status(404).json({ error: '无效或已失效的桌码' });
      const sessionToken = crypto.randomBytes(24).toString('base64url');
      const qrTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const configuredQrTimeout = Number.parseInt(qrTimeoutSetting?.value ?? '45', 10);
      // A literal 0 intentionally disables expiry; malformed values fall back to
      // the secure default rather than accidentally creating a never-expiring token.
      const qrTimeoutMinutes = Number.isSafeInteger(configuredQrTimeout) && configuredQrTimeout >= 0
        ? Math.min(configuredQrTimeout, 1440)
        : 45;
      const expiresAt = qrTimeoutMinutes > 0
        ? new Date(Date.now() + qrTimeoutMinutes * 60 * 1000).toISOString()
        : new Date('9999-12-31T23:59:59Z').toISOString();
      await runAsync('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))', [table.name, sessionToken, expiresAt, new Date().toISOString(), table.store_id || 1, table.store_id || 1]);
      const customerToken = crypto.randomBytes(16).toString('base64url');
      res.json({ table: table.name, storeId: table.store_id || 1, sessionToken, customerToken, expiresAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/public/table-session/:token/orders', async (req, res) => {
    try {
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [req.params.token]);
      if (!session) return res.status(404).json({ error: '扫码会话不存在，请重新扫码' });
      if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: '二维码已过期，请重新扫码' });
      const customerToken = req.query.ct || '';
      let rows;
      if (customerToken) {
        // 只按customer_token + store_id查询，不管订单在哪个桌，都能查到自己的订单
        // 限定最近7天，避免无限累积历史订单
        const sevenDaysAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
        rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND customer_token=? AND status!='canceled' AND createdAt > ? ORDER BY createdAt DESC", [session.store_id || 1, customerToken, sevenDaysAgo]);
      } else {
        rows = await allAsync("SELECT * FROM orders WHERE table_name=? AND store_id=? AND session_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.table_name, session.store_id || 1, req.params.token]);
      }
      res.json({ table: session.table_name, orders: rows.map(formatOrder) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/public/table-session/:token/info', async (req, res) => {
    try {
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [req.params.token]);
      if (!session) return res.status(404).json({ error: '会话不存在' });
      if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: '会话已过期' });
      let expiresAt2 = session.expires_at;
      res.json({ table: session.table_name, storeId: session.store_id || 1, sessionToken: req.params.token, expiresAt: expiresAt2 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/public/table-session/:token', async (req, res) => {
    try {
      await runAsync('DELETE FROM scan_sessions WHERE token=?', [req.params.token]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
