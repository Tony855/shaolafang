/* ============================================================
   routes/public-session.js — 二维码 + 桌台 session
   ============================================================ */
const crypto = require('crypto');
const QRCode = require('qrcode');
const { parsePositiveRouteId } = require('../server/services/route-id');

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
    } catch (e) { res.status(500).json({ error: '二维码请求失败，请稍后重试' }); }
  });

  app.get('/api/tables/:id/qrcode', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
    try {
      const tableId = parsePositiveRouteId(req.params.id);
      if (tableId === null) return res.status(400).json({ error: '桌台编号无效' });
      const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ? AND store_id = ?', [tableId, req.storeId]);
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
      // The response contains bearer session/customer tokens; never let a
      // browser, reverse proxy, or shared cache persist those credentials.
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Pragma', 'no-cache');
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
    } catch (e) { res.status(500).json({ error: '扫码会话请求失败，请稍后重试' }); }
  });

  const getSessionToken = req => {
    const headerToken = typeof req.get === 'function' ? req.get('X-Scan-Session') : req.headers?.['x-scan-session'];
    return typeof headerToken === 'string' ? headerToken.trim() : '';
  };

  const getCustomerToken = req => {
    const headerToken = typeof req.get === 'function' ? req.get('X-Customer-Token') : req.headers?.['x-customer-token'];
    return typeof headerToken === 'string' ? headerToken.trim() : '';
  };

  // Public order responses must never disclose bearer credentials stored on rows.
  // customerToken and sessionToken are authentication secrets, not display data.
  const formatPublicOrder = row => {
    const formatted = formatOrder(row);
    if (!formatted || typeof formatted !== 'object') return formatted;
    const safe = { ...formatted };
    delete safe.sessionToken;
    delete safe.customerToken;
    return safe;
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
      if (!customerToken) return res.status(401).json({ error: '请提供顾客会话令牌' });
      if (customerToken.length > 128) return res.status(400).json({ error: '顾客会话令牌无效' });
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const rows = await allAsync(
        "SELECT * FROM orders WHERE store_id=? AND table_name=? AND session_token=? AND customer_token=? AND status!='canceled' AND createdAt > ? ORDER BY createdAt DESC",
        [sessionStoreId, session.table_name, sessionToken, customerToken, sevenDaysAgo]
      );
      res.json({ table: session.table_name, orders: rows.map(formatPublicOrder) });
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
      // The bearer token was supplied in X-Scan-Session; never echo it in the response.
      res.json({ table: session.table_name, storeId: sessionStoreId, expiresAt: session.expires_at });
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

  // Do not accept bearer credentials in URL paths: reverse proxies and access logs
  // commonly record full request URLs. Clients must use the X-Scan-Session header.
};
