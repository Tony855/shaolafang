/* ============================================================
   routes/public-session.js — 二维码 + 桌台 session
   ============================================================ */
const crypto = require('crypto');
const QRCode = require('qrcode');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, formatOrder } = deps;

  app.get('/api/qrcode/:table', async (req, res) => {
    try {
      const table = await getAsync('SELECT name, store_id FROM tables WHERE name=? AND store_id=?', [req.params.table, 1]);
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
      const qrTimeoutMinutes = parseInt(qrTimeoutSetting?.value || '45', 10);
      const expiresAt = qrTimeoutMinutes > 0
        ? new Date(Date.now() + qrTimeoutMinutes * 60 * 1000).toISOString()
        : new Date('9999-12-31T23:59:59Z').toISOString();
      await runAsync('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, ?)', [table.name, sessionToken, expiresAt, new Date().toISOString(), table.store_id || 1]);
      const customerToken = crypto.randomBytes(16).toString('base64url');
      res.json({ table: table.name, storeId: table.store_id || 1, sessionToken, customerToken, expiresAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/public/table-session/:token/orders', async (req, res) => {
    try {
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [req.params.token]);
      if (!session) return res.status(404).json({ error: '扫码会话不存在，请重新扫码' });
      if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '二维码已过期，请重新扫码' });
      const qrTimeoutS = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const qrTimeoutMins = parseInt(qrTimeoutS?.value || '45', 10);
      if (qrTimeoutMins > 0) {
        const newQrExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
        runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newQrExpires, req.params.token]).catch(()=>{});
      }
      const customerToken = req.query.ct || '';
      let rows;
      if (customerToken) {
        // 只按customer_token + store_id查询，不管订单在哪个桌，都能查到自己的订单
        rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND customer_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.store_id || 1, customerToken]);
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
      if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '会话已过期' });
      const qrTimeoutS2 = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const qrTimeoutMins2 = parseInt(qrTimeoutS2?.value || '45', 10);
      let expiresAt2 = session.expires_at;
      if (qrTimeoutMins2 > 0) {
        expiresAt2 = new Date(Date.now() + qrTimeoutMins2 * 60 * 1000).toISOString();
        runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [expiresAt2, req.params.token]).catch(()=>{});
      }
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
