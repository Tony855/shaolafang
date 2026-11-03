/* ============================================================
   routes/public-session.js — 二维码 + 桌台 session
   ============================================================ */
const crypto = require('crypto');
const QRCode = require('qrcode');

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, formatOrder } = deps;

  app.get('/api/qrcode/:table', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
    try {
      const storeId = Number(req.storeId);
      if (!Number.isSafeInteger(storeId) || storeId <= 0) return res.status(403).json({ error: '无权访问该店铺' });
      const table = await getAsync('SELECT name, store_id FROM tables WHERE name=? AND store_id=?', [req.params.table, storeId]);
      if (!table) return res.status(404).json({ error: '桌号不存在' });
      const url = `${req.protocol}://${req.get('host')}/?table=${encodeURIComponent(table.name)}`;
      const qrDataUrl = await QRCode.toDataURL(url);
      res.json({ qrDataUrl, url, table: table.name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/tables/:id/qrcode', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
    try {
      const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ? AND store_id = ?', [req.params.id, req.storeId]);
      if (!table) return res.status(404).json({ error: '桌号不存在' });
      const store = await getAsync('SELECT s.name FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1', [table.store_id]);
      if (!store) return res.status(404).json({ error: '店铺不存在或已停用' });
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
      const qrToken = typeof req.params.token === 'string' ? req.params.token : '';
      if (!qrToken || qrToken.length > 255) return res.status(400).json({ error: '桌码无效' });
      const table = await getAsync('SELECT name, store_id FROM tables WHERE qr_token=?', [qrToken]);
      if (!table) return res.status(404).json({ error: '无效或已失效的桌码' });
      const storeId = Number(table.store_id);
      if (!Number.isSafeInteger(storeId) || storeId <= 0) return res.status(404).json({ error: '桌码所属店铺无效' });
      const activeStore = await getAsync(
        'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
        [storeId]
      );
      if (!activeStore) return res.status(404).json({ error: '店铺不存在或已停用' });
      const sessionToken = crypto.randomBytes(24).toString('base64url');
      const qrTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
      const rawQrTimeout = String(qrTimeoutSetting?.value ?? '45').trim();
      const configuredQrTimeout = /^\d+$/.test(rawQrTimeout) ? Number(rawQrTimeout) : NaN;
      // A literal 0 intentionally disables expiry; malformed values fall back to
      // the secure default rather than accidentally creating a never-expiring token.
      const qrTimeoutMinutes = Number.isSafeInteger(configuredQrTimeout) && configuredQrTimeout >= 0
        ? Math.min(configuredQrTimeout, 1440)
        : 45;
      const expiresAt = qrTimeoutMinutes > 0
        ? new Date(Date.now() + qrTimeoutMinutes * 60 * 1000).toISOString()
        : new Date('9999-12-31T23:59:59Z').toISOString();
      await runAsync('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))', [table.name, sessionToken, expiresAt, new Date().toISOString(), storeId, storeId]);
      const customerToken = crypto.randomBytes(16).toString('base64url');
      res.json({ table: table.name, storeId, sessionToken, customerToken, expiresAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const getSessionToken = req => {
    const headerToken = typeof req.get === 'function' ? req.get('X-Scan-Session') : req.headers?.['x-scan-session'];
    const value = typeof headerToken === 'string' && headerToken.trim()
      ? headerToken.trim()
      : (typeof req.params?.token === 'string' ? req.params.token : '');
    return value;
  };

  const getCustomerToken = req => {
    const headerToken = typeof req.get === 'function' ? req.get('X-Customer-Token') : req.headers?.['x-customer-token'];
    const value = typeof headerToken === 'string' && headerToken.trim()
      ? headerToken.trim()
      : (typeof req.query?.ct === 'string' ? req.query.ct.trim() : '');
    return value;
  };

  const getSessionOrders = async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const sessionToken = getSessionToken(req);
      if (!sessionToken || sessionToken.length > 256) return res.status(400).json({ error: '扫码会话令牌无效' });
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [sessionToken]);
      if (!session) return res.status(404).json({ error: '扫码会话不存在，请重新扫码' });
      if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: '二维码已过期，请重新扫码' });
      const sessionStoreId = Number(session.store_id);
      if (!Number.isSafeInteger(sessionStoreId) || sessionStoreId <= 0) return res.status(410).json({ error: '扫码会话店铺信息无效' });
      const activeStore = await getAsync(
        'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
        [sessionStoreId]
      );
      if (!activeStore) return res.status(404).json({ error: '店铺不存在或已停用' });
      const customerToken = getCustomerToken(req);
      if (customerToken.length > 128) return res.status(400).json({ error: '顾客会话令牌无效' });
      let rows;
      if (customerToken) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND customer_token=? AND status!='canceled' AND createdAt > ? ORDER BY createdAt DESC", [sessionStoreId, customerToken, sevenDaysAgo]);
      } else {
        rows = await allAsync("SELECT * FROM orders WHERE table_name=? AND store_id=? AND session_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.table_name, sessionStoreId, sessionToken]);
      }
      res.json({ table: session.table_name, orders: rows.map(formatOrder) });
    } catch (error) {
      res.status(500).json({ error: '查询订单失败' });
    }
  };

  const getSessionInfo = async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const sessionToken = getSessionToken(req);
      if (!sessionToken || sessionToken.length > 256) return res.status(400).json({ error: '扫码会话令牌无效' });
      const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [sessionToken]);
      if (!session) return res.status(404).json({ error: '会话不存在' });
      if (!Number.isFinite(new Date(session.expires_at).getTime()) || new Date(session.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: '会话已过期' });
      const sessionStoreId = Number(session.store_id);
      if (!Number.isSafeInteger(sessionStoreId) || sessionStoreId <= 0) return res.status(410).json({ error: '扫码会话店铺信息无效' });
      const activeStore = await getAsync(
        'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
        [sessionStoreId]
      );
      if (!activeStore) return res.status(404).json({ error: '店铺不存在或已停用' });
      res.json({ table: session.table_name, storeId: sessionStoreId, sessionToken, expiresAt: session.expires_at });
    } catch (error) {
      res.status(500).json({ error: '读取扫码会话失败' });
    }
  };

  const deleteSession = async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const sessionToken = getSessionToken(req);
      if (!sessionToken || sessionToken.length > 256) return res.status(400).json({ error: '扫码会话令牌无效' });
      await runAsync('DELETE FROM scan_sessions WHERE token=?', [sessionToken]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: '结束扫码会话失败' });
    }
  };

  // Header-based endpoints keep bearer tokens out of URLs and reverse-proxy access logs.
  app.get('/api/public/table-session/orders', getSessionOrders);
  app.get('/api/public/table-session/info', getSessionInfo);
  app.delete('/api/public/table-session', deleteSession);

  // Legacy path/query aliases remain for older clients during rollout.
  app.get('/api/public/table-session/:token/orders', getSessionOrders);
  app.get('/api/public/table-session/:token/info', getSessionInfo);
  app.delete('/api/public/table-session/:token', deleteSession);
};
