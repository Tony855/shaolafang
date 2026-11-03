/* ============================================================
   routes/calls.js — 呼叫 + 预约
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.post('/api/public/call-waiter', async (req, res) => {
  try {
    const { table, sessionToken } = req.body || {};
    if (!table) return res.status(400).json({ error: '桌号不能为空' });
    let callStoreId = req.storeId || 1;
    if (sessionToken) {
      const session = await getAsync('SELECT store_id FROM scan_sessions WHERE token=?', [sessionToken]);
      if (session) callStoreId = session.store_id || 1;
    }
    const tableRow = await getAsync('SELECT id, store_id FROM tables WHERE name=? AND store_id=?', [table, callStoreId]);
    if (!tableRow) return res.status(404).json({ error: '桌号不存在' });
    const limitRows = await allAsync("SELECT `key`, value FROM settings WHERE `key` IN ('call_limit_enabled','call_limit_max','call_limit_window_minutes','call_limit_cooldown_minutes')");
    const limitCfg = {};
    limitRows.forEach(r => { limitCfg[r.key] = r.value; });
    const limitEnabled = (limitCfg.call_limit_enabled || '1') !== '0';
    const maxCalls = parseInt(limitCfg.call_limit_max || '3', 10);
    const windowMinutes = parseInt(limitCfg.call_limit_window_minutes || '5', 10);
    const cooldownMinutes = parseInt(limitCfg.call_limit_cooldown_minutes || '10', 10);
    if (limitEnabled) {
      const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
      const countRow = await getAsync(
        "SELECT COUNT(*) AS cnt FROM waiter_calls WHERE table_name=? AND store_id=? AND (type='call' OR type='' OR type IS NULL) AND created_at >= ?",
        [table, tableRow.store_id, windowStart]
      );
      const callCount = countRow?.cnt || 0;
      if (callCount >= maxCalls) {
        const lastCall = await getAsync(
          "SELECT created_at FROM waiter_calls WHERE table_name=? AND store_id=? AND (type='call' OR type='' OR type IS NULL) ORDER BY created_at DESC LIMIT 1",
          [table, tableRow.store_id]
        );
        let cooldownRemaining = cooldownMinutes;
        if (lastCall) {
          const elapsed = (Date.now() - new Date(lastCall.created_at).getTime()) / 60000;
          cooldownRemaining = Math.max(0, Math.ceil(cooldownMinutes - elapsed));
        }
        return res.status(429).json({ error: '呼叫过于频繁', cooldownMinutes: cooldownRemaining });
      }
    }
    const callId = crypto.randomBytes(8).toString('hex');
    await runAsync(
      'INSERT INTO waiter_calls (id, table_name, store_id, session_token, status, type, created_at, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
      [callId, table, tableRow.store_id, sessionToken || '', 'pending', 'call', new Date().toISOString(), tableRow.store_id]
    );
    res.json({ success: true, callId, message: '已通知服务员' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/waiter-calls', requireAdminOrWaiter, async (req, res) => {
  try {
    const storeId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const rows = await allAsync(
      'SELECT * FROM waiter_calls WHERE store_id=? AND status="pending" ORDER BY created_at DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/reservations', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const rows = await allAsync(
      'SELECT * FROM reservations WHERE store_id=? ORDER BY reservation_time DESC',
      [storeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/reservations/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 订单打印 -----
};
