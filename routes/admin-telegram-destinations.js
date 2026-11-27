'use strict';

const { parsePositiveRouteId } = require('../server/services/route-id');
const { normalizeRouteError } = require('../server/utils/http-error');

function normalizeFlag(value, fallback, label) {
  if (value === undefined) return fallback === null ? null : (fallback ? 1 : 0);
  if ([true, 1, '1'].includes(value)) return 1;
  if ([false, 0, '0'].includes(value)) return 0;
  throw Object.assign(new Error(label + ' 参数无效'), { status: 400 });
}

function normalizeGroupChat(input) {
  const chatId = typeof input?.chatId === 'string' ? input.chatId.trim() : '';
  if (!/^-\\d{5,20}$/.test(chatId)) {
    throw Object.assign(new Error('仅支持 Telegram 群组或超级群组 Chat ID'), { status: 400 });
  }
  return {
    chatId,
    chatType: chatId.startsWith('-100') ? 'supergroup' : 'group',
    title: String(input?.title || '').trim().slice(0, 255),
    username: String(input?.username || '').trim().replace(/^@/, '').slice(0, 32)
  };
}

module.exports = function registerTelegramDestinationRoutes(app, deps) {
  const { getAsync, allAsync, runAsync, withTransaction, requireAdminKey, requirePermission, getClientIp } = deps;

  function tenant(req) {
    const merchantId = Number(req.merchantId);
    if (!Number.isSafeInteger(merchantId) || merchantId <= 0) {
      throw Object.assign(new Error('商户信息无效'), { status: 403 });
    }
    return merchantId;
  }

  async function assertStoreAccess(req, merchantId, storeId, lock = false) {
    const adminId = Number(req.adminId);
    if (!Number.isSafeInteger(adminId) || adminId <= 0) {
      throw Object.assign(new Error('管理员身份无效'), { status: 403 });
    }
    const accessSql = req.isPrimaryAdmin
      ? 'SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1' + (lock ? ' FOR UPDATE' : '')
      : 'SELECT s.id FROM stores s JOIN merchant_admin_store_access a ON a.store_id=s.id AND a.merchant_id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND a.admin_id=?' + (lock ? ' FOR UPDATE' : '');
    const store = await getAsync(accessSql, req.isPrimaryAdmin ? [storeId, merchantId] : [storeId, merchantId, adminId]);
    if (!store) throw Object.assign(new Error('门店不存在、已停用或无权管理'), { status: 404 });
    return store;
  }

  async function audit(req, action, targetId, details) {
    const actor = req.adminId
      ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, req.merchantId])
      : null;
    await runAsync(
      'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['merchant_admin', req.adminId || null, actor?.username || '', action, 'telegram_chat_destination', targetId || null,
        JSON.stringify(details), typeof getClientIp === 'function' ? getClientIp(req) : '', new Date().toISOString()]
    );
  }

  app.get('/api/admin/telegram/destinations', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = tenant(req);
      const adminId = Number(req.adminId);
      const primary = req.isPrimaryAdmin === true;
      const rows = await allAsync(`
        SELECT d.id AS destination_id, d.chat_id, d.chat_type, d.title, d.username, d.is_enabled AS destination_enabled,
               sub.id AS subscription_id, sub.store_id, s.name AS store_name, sub.is_enabled AS subscription_enabled,
               sub.notify_order_created, sub.notify_settled, sub.notify_refunded
        FROM telegram_chat_destinations d
        LEFT JOIN telegram_store_subscriptions sub ON sub.destination_id=d.id AND sub.merchant_id=d.merchant_id
        LEFT JOIN stores s ON s.id=sub.store_id AND s.merchant_id=sub.merchant_id
        LEFT JOIN merchant_admin_store_access a ON a.store_id=s.id AND a.merchant_id=s.merchant_id AND a.admin_id=?
        WHERE d.merchant_id=? AND (?=1 OR s.id IS NULL OR a.admin_id IS NOT NULL)
        ORDER BY d.id DESC, s.name, s.id
      `, [adminId, merchantId, primary ? 1 : 0]);
      const availableStores = await allAsync(`
        SELECT s.id, s.name FROM stores s
        LEFT JOIN merchant_admin_store_access a ON a.store_id=s.id AND a.merchant_id=s.merchant_id AND a.admin_id=?
        WHERE s.merchant_id=? AND s.active=1 AND (?=1 OR a.admin_id IS NOT NULL)
        ORDER BY s.name, s.id
      `, [adminId, merchantId, primary ? 1 : 0]);
      const destinations = new Map();
      for (const row of rows) {
        let item = destinations.get(Number(row.destination_id));
        if (!item) {
          item = {
            id: Number(row.destination_id), chatId: row.chat_id, chatType: row.chat_type,
            title: row.title, username: row.username, enabled: Number(row.destination_enabled) === 1,
            stores: []
          };
          destinations.set(item.id, item);
        }
        if (row.subscription_id && row.store_id !== null) {
          item.stores.push({
            subscriptionId: Number(row.subscription_id), storeId: Number(row.store_id), storeName: row.store_name || '',
            enabled: Number(row.subscription_enabled) === 1,
            notifyOrderCreated: Number(row.notify_order_created) === 1,
            notifySettled: Number(row.notify_settled) === 1,
            notifyRefunded: Number(row.notify_refunded) === 1
          });
        }
      }
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ destinations: [...destinations.values()], availableStores: availableStores.map(store => ({ id: Number(store.id), name: store.name || '' })) });
    } catch (error) {
      const safe = normalizeRouteError(error, 'Telegram 群组列表读取失败');
      res.status(safe.status).json({ error: safe.message });
    }
  });

  app.post('/api/admin/telegram/destinations', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = tenant(req);
      const chat = normalizeGroupChat(req.body || {});
      let destination;
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const result = await runAsync(`
          INSERT INTO telegram_chat_destinations
            (merchant_id, bot_profile, chat_id, chat_type, title, username, is_enabled, created_at, updated_at)
          VALUES (?, 'admin', ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
        `, [merchantId, chat.chatId, chat.chatType, chat.title, chat.username]);
        destination = await getAsync(
          'SELECT id, chat_id, chat_type, title, username, is_enabled FROM telegram_chat_destinations WHERE id=? AND merchant_id=?',
          [result.lastID, merchantId]
        );
        await audit(req, 'create_telegram_chat_destination', result.lastID, { chat_type: chat.chatType, title: chat.title });
      });
      res.status(201).json({ success: true, destination });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
        return res.status(409).json({ error: '该 Chat ID 已登记，不能重复添加或跨商户占用' });
      }
      const safe = normalizeRouteError(error, 'Telegram 群组创建失败，所有更改已回滚');
      res.status(safe.status).json({ error: safe.message });
    }
  });

  app.put('/api/admin/telegram/destinations/:id/stores/:storeId', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = tenant(req);
      const destinationId = parsePositiveRouteId(req.params.id);
      const storeId = parsePositiveRouteId(req.params.storeId);
      if (!destinationId || !storeId) return res.status(400).json({ error: '群组或门店编号无效' });
      const body = req.body || {};
      const enabled = normalizeFlag(body.enabled, 1, '订阅状态');
      const notifyOrderCreated = normalizeFlag(body.notifyOrderCreated, 1, '新订单通知开关');
      const notifySettled = normalizeFlag(body.notifySettled, 1, '收款通知开关');
      const notifyRefunded = normalizeFlag(body.notifyRefunded, 1, '退款通知开关');
      let subscription;
      await withTransaction(async () => {
        const destination = await getAsync(
          'SELECT id FROM telegram_chat_destinations WHERE id=? AND merchant_id=? FOR UPDATE',
          [destinationId, merchantId]
        );
        if (!destination) throw Object.assign(new Error('Telegram 群组不存在'), { status: 404 });
        await assertStoreAccess(req, merchantId, storeId, true);
        await runAsync(`
          INSERT INTO telegram_store_subscriptions
            (merchant_id, destination_id, store_id, is_enabled, notify_order_created, notify_settled, notify_refunded, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE is_enabled=VALUES(is_enabled), notify_order_created=VALUES(notify_order_created),
            notify_settled=VALUES(notify_settled), notify_refunded=VALUES(notify_refunded), updated_at=UTC_TIMESTAMP(3)
        `, [merchantId, destinationId, storeId, enabled, notifyOrderCreated, notifySettled, notifyRefunded]);
        subscription = await getAsync(
          'SELECT id, store_id, is_enabled, notify_order_created, notify_settled, notify_refunded FROM telegram_store_subscriptions WHERE merchant_id=? AND destination_id=? AND store_id=?',
          [merchantId, destinationId, storeId]
        );
        await audit(req, 'upsert_telegram_store_subscription', subscription?.id, {
          destination_id: destinationId, store_id: storeId, enabled: !!enabled,
          notify_order_created: !!notifyOrderCreated, notify_settled: !!notifySettled, notify_refunded: !!notifyRefunded
        });
      });
      res.json({ success: true, subscription });
    } catch (error) {
      const safe = normalizeRouteError(error, 'Telegram 门店订阅保存失败，所有更改已回滚');
      res.status(safe.status).json({ error: safe.message });
    }
  });

  app.delete('/api/admin/telegram/destinations/:id/stores/:storeId', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = tenant(req);
      const destinationId = parsePositiveRouteId(req.params.id);
      const storeId = parsePositiveRouteId(req.params.storeId);
      if (!destinationId || !storeId) return res.status(400).json({ error: '群组或门店编号无效' });
      await withTransaction(async () => {
        const destination = await getAsync('SELECT id FROM telegram_chat_destinations WHERE id=? AND merchant_id=? FOR UPDATE', [destinationId, merchantId]);
        if (!destination) throw Object.assign(new Error('Telegram 群组不存在'), { status: 404 });
        await assertStoreAccess(req, merchantId, storeId, true);
        const current = await getAsync(
          'SELECT id FROM telegram_store_subscriptions WHERE merchant_id=? AND destination_id=? AND store_id=? FOR UPDATE',
          [merchantId, destinationId, storeId]
        );
        if (!current) throw Object.assign(new Error('该群组尚未订阅此门店'), { status: 404 });
        await runAsync('DELETE FROM telegram_store_subscriptions WHERE id=? AND merchant_id=?', [current.id, merchantId]);
        await audit(req, 'delete_telegram_store_subscription', current.id, { destination_id: destinationId, store_id: storeId });
      });
      res.json({ success: true });
    } catch (error) {
      const safe = normalizeRouteError(error, 'Telegram 门店订阅删除失败，所有更改已回滚');
      res.status(safe.status).json({ error: safe.message });
    }
  });

  app.put('/api/admin/telegram/destinations/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = tenant(req);
      const destinationId = parsePositiveRouteId(req.params.id);
      if (!destinationId) return res.status(400).json({ error: '群组编号无效' });
      const enabled = normalizeFlag(req.body?.enabled, null, '群组状态');
      if (enabled === null) return res.status(400).json({ error: '请提供群组状态' });
      await withTransaction(async () => {
        const destination = await getAsync('SELECT id FROM telegram_chat_destinations WHERE id=? AND merchant_id=? FOR UPDATE', [destinationId, merchantId]);
        if (!destination) throw Object.assign(new Error('Telegram 群组不存在'), { status: 404 });
        await runAsync('UPDATE telegram_chat_destinations SET is_enabled=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND merchant_id=?', [enabled, destinationId, merchantId]);
        await audit(req, 'update_telegram_chat_destination', destinationId, { enabled: !!enabled });
      });
      res.json({ success: true, enabled: !!enabled });
    } catch (error) {
      const safe = normalizeRouteError(error, 'Telegram 群组状态更新失败，所有更改已回滚');
      res.status(safe.status).json({ error: safe.message });
    }
  });

  app.delete('/api/admin/telegram/destinations/:id', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = tenant(req);
      const destinationId = parsePositiveRouteId(req.params.id);
      if (!destinationId) return res.status(400).json({ error: '群组编号无效' });
      await withTransaction(async () => {
        const destination = await getAsync('SELECT id FROM telegram_chat_destinations WHERE id=? AND merchant_id=? FOR UPDATE', [destinationId, merchantId]);
        if (!destination) throw Object.assign(new Error('Telegram 群组不存在'), { status: 404 });
        const subscriptions = await getAsync('SELECT COUNT(*) AS count FROM telegram_store_subscriptions WHERE merchant_id=? AND destination_id=?', [merchantId, destinationId]);
        if (Number(subscriptions?.count || 0) > 0) {
          throw Object.assign(new Error('请先移除此群组的所有门店订阅'), { status: 409 });
        }
        await runAsync('DELETE FROM telegram_chat_destinations WHERE id=? AND merchant_id=?', [destinationId, merchantId]);
        await audit(req, 'delete_telegram_chat_destination', destinationId, { deleted: true });
      });
      res.json({ success: true });
    } catch (error) {
      const safe = normalizeRouteError(error, 'Telegram 群组删除失败，所有更改已回滚');
      res.status(safe.status).json({ error: safe.message });
    }
  });
};
