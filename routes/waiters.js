/* ============================================================
   routes/waiters.js — 服务员管理
   ============================================================ */
const crypto = require("crypto");
const fs = require("fs");
const { hashPassword, verifyPassword } = require("../server/middleware/password");
const { compressImage } = require("../server/services/image-compress");

function normalizeWaiterFlag(value, fallback, field) {
  if (value === undefined) return fallback;
  if ([true, 1, '1'].includes(value)) return 1;
  if ([false, 0, '0'].includes(value)) return 0;
  throw Object.assign(new Error(field + ' 参数无效'), { statusCode: 400 });
}

async function cashierUsernameExists(allAsync, username) {
  const rows = await allAsync("SELECT \`key\`, value FROM settings WHERE \`key\` LIKE 'cashiers_%'");
  for (const row of rows) {
    try {
      const list = JSON.parse(row.value);
      if (Array.isArray(list) && list.some(cashier => cashier && cashier.username === username)) return true;
    } catch (_) {}
  }
  return false;
}

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction } = deps;

app.get('/api/admin/waiters', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const rows = await allAsync(
      `SELECT w.id, w.username, w.display_name, w.can_order, w.can_mark_item, w.can_complete_order, w.active, w.store_id, s.name AS store_name
       FROM waiters w
       LEFT JOIN stores s ON s.id = w.store_id
       WHERE w.merchant_id = ?
       ORDER BY w.store_id, w.id`,
      [req.merchantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/waiters', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    const merchantId = Number(req.merchantId);
    const targetStoreId = Number(body.store_id === undefined ? req.storeId : body.store_id);
    if (!Number.isSafeInteger(merchantId) || merchantId <= 0 || !Number.isSafeInteger(targetStoreId) || targetStoreId <= 0) {
      return res.status(400).json({ error: '商户或门店编号无效' });
    }
    if (!username || username.length > 50 || !displayName || displayName.length > 255) {
      return res.status(400).json({ error: '服务员账号和姓名必填，账号最多 50 个字符，姓名最多 255 个字符' });
    }
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: '密码长度必须为 6 至 128 个字符' });

    let waiterId;
    await withTransaction(async () => {
      const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
      if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { statusCode: 403 });
      const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [targetStoreId, merchantId]);
      if (!store) throw Object.assign(new Error('店铺不存在或已停用'), { statusCode: 400 });
      if (await cashierUsernameExists(allAsync, username)) {
        throw Object.assign(new Error('该用户名已被收银员账号使用，请换一个'), { statusCode: 409 });
      }
      const result = await runAsync(
        'INSERT INTO waiters (username, password_hash, display_name, can_order, can_mark_item, can_complete_order, store_id, merchant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [username, hashPassword(password), displayName, normalizeWaiterFlag(body.can_order, 1, 'can_order'),
          normalizeWaiterFlag(body.can_mark_item, 1, 'can_mark_item'),
          normalizeWaiterFlag(body.can_complete_order, 1, 'can_complete_order'),
          targetStoreId, merchantId]
      );
      waiterId = result.lastID;
      const actor = req.adminId ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId]) : null;
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId || null, actor?.username || '', 'create_waiter', 'waiter', waiterId,
          JSON.stringify({ username, display_name: displayName, store_id: targetStoreId }), getClientIp(req), new Date().toISOString()]
      );
    });
    res.status(201).json(await getAsync(
      'SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=? AND merchant_id=?',
      [waiterId, merchantId]
    ));
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || e.statusCode === 409) return res.status(409).json({ error: e.statusCode ? e.message : '服务员账号已存在' });
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '创建服务员失败，所有更改已回滚' });
  }
});

app.put('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const merchantId = Number(req.merchantId);
    const body = req.body || {};
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
      return res.status(400).json({ error: '服务员或商户编号无效' });
    }
    if (body.username !== undefined && (typeof body.username !== 'string' || !body.username.trim() || body.username.trim().length > 50)) {
      return res.status(400).json({ error: '服务员账号必须为 1 至 50 个字符' });
    }
    if (body.display_name !== undefined && (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.trim().length > 255)) {
      return res.status(400).json({ error: '服务员姓名必须为 1 至 255 个字符' });
    }
    if (body.password !== undefined && body.password !== '' &&
        (typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 128)) {
      return res.status(400).json({ error: '密码长度必须为 6 至 128 个字符' });
    }
    let updatedWaiter;
    await withTransaction(async () => {
      const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
      if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { statusCode: 403 });
      const current = await getAsync('SELECT * FROM waiters WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
      if (!current) throw Object.assign(new Error('服务员不存在'), { statusCode: 404 });

      const username = body.username === undefined ? current.username : body.username.trim();
      const displayName = body.display_name === undefined ? current.display_name : body.display_name.trim();
      const targetStoreId = body.store_id === undefined ? Number(current.store_id) : Number(body.store_id);
      if (!Number.isSafeInteger(targetStoreId) || targetStoreId <= 0) throw Object.assign(new Error('目标门店编号无效'), { statusCode: 400 });
      const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE', [targetStoreId, merchantId]);
      if (!store) throw Object.assign(new Error('目标店铺不存在或已停用'), { statusCode: 400 });
      if (username !== current.username && await cashierUsernameExists(allAsync, username)) {
        throw Object.assign(new Error('该用户名已被收银员账号使用，请换一个'), { statusCode: 409 });
      }

      const canOrder = normalizeWaiterFlag(body.can_order, Number(current.can_order), 'can_order');
      const canMarkItem = normalizeWaiterFlag(body.can_mark_item, Number(current.can_mark_item), 'can_mark_item');
      const canCompleteOrder = normalizeWaiterFlag(body.can_complete_order, Number(current.can_complete_order), 'can_complete_order');
      const active = normalizeWaiterFlag(body.active, Number(current.active), 'active');
      const passwordChanged = typeof body.password === 'string' && body.password.length > 0;
      const accessChanged = passwordChanged || username !== current.username ||
        targetStoreId !== Number(current.store_id) || active !== Number(current.active) ||
        canOrder !== Number(current.can_order) || canMarkItem !== Number(current.can_mark_item) ||
        canCompleteOrder !== Number(current.can_complete_order);

      await runAsync(
        'UPDATE waiters SET username=?, display_name=?, can_order=?, can_mark_item=?, can_complete_order=?, active=?, store_id=? WHERE id=? AND merchant_id=?',
        [username, displayName, canOrder, canMarkItem, canCompleteOrder, active, targetStoreId, id, merchantId]
      );
      if (passwordChanged) {
        await runAsync('UPDATE waiters SET password_hash=? WHERE id=? AND merchant_id=?', [hashPassword(body.password), id, merchantId]);
      }
      if (accessChanged) await runAsync('DELETE FROM waiter_sessions WHERE waiter_id=?', [id]);

      const actor = req.adminId ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId]) : null;
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId || null, actor?.username || '', 'update_waiter', 'waiter', id,
          JSON.stringify({ before: { username: current.username, store_id: current.store_id, active: current.active },
            after: { username, store_id: targetStoreId, active } }), getClientIp(req), new Date().toISOString()]
      );
      updatedWaiter = await getAsync(
        'SELECT id, username, display_name, can_order, can_mark_item, can_complete_order, active, store_id FROM waiters WHERE id=? AND merchant_id=?',
        [id, merchantId]
      );
    });
    res.json(updatedWaiter);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' || e.statusCode === 409) return res.status(409).json({ error: e.statusCode ? e.message : '服务员账号已存在' });
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '更新服务员失败，所有更改已回滚' });
  }
});

app.delete('/api/admin/waiters/:id', requireAdminKey, requirePermission('can_manage_waiter'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const merchantId = Number(req.merchantId);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(merchantId) || merchantId <= 0) {
      return res.status(400).json({ error: '服务员或商户编号无效' });
    }
    await withTransaction(async () => {
      const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
      if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { statusCode: 403 });
      const current = await getAsync('SELECT id, username, store_id FROM waiters WHERE id=? AND merchant_id=? FOR UPDATE', [id, merchantId]);
      if (!current) throw Object.assign(new Error('服务员不存在'), { statusCode: 404 });
      await runAsync('DELETE FROM waiter_sessions WHERE waiter_id=?', [id]);
      await runAsync('DELETE FROM waiters WHERE id=? AND merchant_id=?', [id, merchantId]);
      const actor = req.adminId ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId]) : null;
      await runAsync(
        'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['merchant_admin', req.adminId || null, actor?.username || '', 'delete_waiter', 'waiter', id,
          JSON.stringify(current), getClientIp(req), new Date().toISOString()]
      );
    });
    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : '删除服务员失败，所有更改已回滚' });
  }
});

// ----- 店铺管理 -----

};
