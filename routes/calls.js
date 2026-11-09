/* ============================================================
   routes/calls.js — 呼叫 + 预约
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

function parsePositiveReservationId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^[1-9]\\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.post('/api/public/call-waiter', async (req, res) => {
  try {
    const table = typeof req.body?.table === 'string' ? req.body.table.trim() : '';
    const sessionToken = typeof req.body?.sessionToken === 'string' ? req.body.sessionToken.trim() : '';
    if (!table || table.length > 50) return res.status(400).json({ error: '桌号无效' });
    if (!sessionToken) return res.status(401).json({ error: '请先扫描桌台二维码' });
    if (sessionToken.length > 256) return res.status(400).json({ error: '扫码会话令牌无效' });

    const initialSession = await getAsync(
      'SELECT table_name, store_id, expires_at FROM scan_sessions WHERE token=?',
      [sessionToken]
    );
    if (!initialSession) return res.status(401).json({ error: '扫码会话不存在，请重新扫码' });
    const initialStoreId = Number(initialSession.store_id);
    if (!Number.isSafeInteger(initialStoreId) || initialStoreId <= 0) return res.status(401).json({ error: '扫码会话店铺信息无效' });
    const activeStore = await getAsync(
      'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
      [initialStoreId]
    );
    if (!activeStore) return res.status(404).json({ error: '店铺不存在或已停用' });
    const initialExpiry = new Date(initialSession.expires_at).getTime();
    if (!Number.isFinite(initialExpiry) || initialExpiry <= Date.now()) {
      return res.status(410).json({ error: '二维码已过期，请重新扫码' });
    }
    if (initialSession.table_name !== table) {
      return res.status(403).json({ error: '扫码桌号与请求桌号不一致' });
    }

    const limitRows = await allAsync(
      "SELECT `key`, value FROM settings WHERE `key` IN ('call_limit_enabled','call_limit_max','call_limit_window_minutes','call_limit_cooldown_minutes')"
    );
    const limitCfg = Object.fromEntries(limitRows.map(row => [row.key, row.value]));
    const parseLimit = (value, fallback, min, max) => {
      const parsed = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
      return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
    };
    const limitEnabled = (limitCfg.call_limit_enabled || '1') !== '0';
    const maxCalls = parseLimit(limitCfg.call_limit_max, 3, 1, 100);
    const windowMinutes = parseLimit(limitCfg.call_limit_window_minutes, 5, 1, 1440);
    const cooldownMinutes = parseLimit(limitCfg.call_limit_cooldown_minutes, 10, 1, 1440);

    const result = await withTransaction(async () => {
      // Match table -> session lock ordering used by table moves.
      const tableRow = await getAsync(
        'SELECT id, store_id FROM tables WHERE name=? AND store_id=? FOR UPDATE',
        [table, initialSession.store_id]
      );
      if (!tableRow) throw Object.assign(new Error('桌号不存在'), { status: 404 });
      const activeStore = await getAsync(
        'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
        [tableRow.store_id]
      );
      if (!activeStore) throw Object.assign(new Error('店铺已停用，暂时无法呼叫服务员'), { status: 404 });
      const session = await getAsync(
        'SELECT table_name, store_id, expires_at FROM scan_sessions WHERE token=? FOR UPDATE',
        [sessionToken]
      );
      if (!session) throw Object.assign(new Error('扫码会话已失效，请重新扫码'), { status: 401 });
      const expiresAt = new Date(session.expires_at).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw Object.assign(new Error('二维码已过期，请重新扫码'), { status: 410 });
      }
      if (session.table_name !== table || Number(session.store_id) !== Number(tableRow.store_id)) {
        throw Object.assign(new Error('扫码桌号与请求桌号不一致'), { status: 403 });
      }

      if (limitEnabled) {
        const recentCalls = await allAsync(
          "SELECT created_at FROM waiter_calls WHERE table_name=? AND store_id=? AND (type='call' OR type='' OR type IS NULL) ORDER BY created_at DESC LIMIT ?",
          [table, tableRow.store_id, maxCalls]
        );
        if (recentCalls.length >= maxCalls) {
          const timestamps = recentCalls.map(row => new Date(row.created_at).getTime());
          const newest = timestamps[0];
          const oldest = timestamps[timestamps.length - 1];
          const now = Date.now();
          // Once the limit is reached, keep the cooldown active even after the
          // rolling count window begins to shed older calls.
          if (!timestamps.every(Number.isFinite)) {
            return { limited: true, cooldownMinutes };
          }
          if (newest - oldest <= windowMinutes * 60 * 1000) {
            const elapsedMinutes = (now - newest) / 60000;
            const remaining = Math.max(0, Math.ceil(cooldownMinutes - elapsedMinutes));
            if (remaining > 0) return { limited: true, cooldownMinutes: remaining };
          }
        }
      }

      const callId = crypto.randomBytes(16).toString('hex');
      await runAsync(
        'INSERT INTO waiter_calls (id, table_name, store_id, session_token, status, type, created_at, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
        [callId, table, tableRow.store_id, sessionToken, 'pending', 'call', new Date().toISOString(), tableRow.store_id]
      );
      return { limited: false, callId };
    });

    if (result.limited) return res.status(429).json({ error: '呼叫过于频繁', cooldownMinutes: result.cooldownMinutes });
    res.json({ success: true, callId: result.callId, message: '已通知服务员' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : '呼叫服务员失败' });
  }
});

app.get('/api/waiter-calls', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const rows = await allAsync(
      'SELECT id, table_name, store_id, status, type, message, created_at, handled_by, handled_at FROM waiter_calls WHERE store_id=? AND status="pending" ORDER BY created_at DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

app.put('/api/waiter-calls/:id/handle', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const existing = await getAsync('SELECT * FROM waiter_calls WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ error: '呼叫记录不存在' });
    const handler = req.isAdmin ? 'admin' : (req.waiter?.display_name || 'waiter');
    await runAsync(
      'UPDATE waiter_calls SET status=?, handled_by=?, handled_at=? WHERE id=? AND store_id=?',
      ['handled', handler, new Date().toISOString(), id, storeId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

app.get('/api/admin/reservations', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const rows = await allAsync(
      'SELECT * FROM reservations WHERE store_id=? ORDER BY reservation_time DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

app.put('/api/admin/reservations/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parsePositiveReservationId(req.params.id);
    if (id === null) return res.status(400).json({ error: '预约编号无效' });
    const { status } = req.body || {};
    const reservation = await getAsync('SELECT * FROM reservations WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!reservation) return res.status(404).json({ error: '预约不存在' });
    if (!['pending', 'confirmed', 'canceled', 'completed'].includes(status)) {
      return res.status(400).json({ error: '无效的预约状态' });
    }
    await runAsync('UPDATE reservations SET status=? WHERE id=? AND store_id=?', [status, id, req.storeId]);
    if (status === 'canceled' || status === 'completed') {
      const table = await getAsync('SELECT id, status FROM tables WHERE name=? AND store_id=?', [reservation.table_name, req.storeId]);
      if (table && table.status === 'reserved') {
        const active = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name=? AND store_id=? AND status=\"pending\"", [reservation.table_name, req.storeId]);
        if (active.count === 0) await runAsync('UPDATE tables SET status=? WHERE id=? AND store_id=?', ['available', table.id, req.storeId]);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: '请求失败，请稍后重试' }); }
});

// ----- 订单打印 -----
};

module.exports.parsePositiveReservationId = parsePositiveReservationId;
