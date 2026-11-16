'use strict';

const crypto = require('node:crypto');
const { hashSessionToken } = require('../server/services/session-token');

const positiveId = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

module.exports = function registerDeliveryRoutes(app, deps) {
  const { getAsync, allAsync, runAsync, withTransaction, requireAdminKey, requirePermission,
    hashPassword, verifyPassword, io } = deps;

  async function getRider(req, res, next) {
    try {
      const raw = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (!raw || raw.length > 256) return res.status(401).json({ error: '请先登录骑手账号' });
      const rider = await getAsync(
        `SELECT r.id, r.merchant_id, r.store_id, r.display_name, r.phone
         FROM delivery_rider_sessions s JOIN delivery_riders r ON r.id=s.rider_id
         JOIN stores st ON st.id=r.store_id AND st.merchant_id=r.merchant_id AND st.active=1
         JOIN merchants m ON m.id=r.merchant_id AND m.status=1
         WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(3) AND r.active=1`,
        [hashSessionToken(raw)]
      );
      if (!rider) return res.status(401).json({ error: '骑手会话已失效，请重新登录' });
      req.deliveryRider = rider;
      req.deliveryRiderTokenHash = hashSessionToken(raw);
      next();
    } catch (_) { res.status(503).json({ error: '骑手服务暂不可用' }); }
  }

  app.get('/api/admin/delivery/riders', requireAdminKey, requirePermission('can_manage_order'), async (req, res) => {
    try {
      const rows = await allAsync(
        'SELECT id, username, display_name, phone, active, created_at FROM delivery_riders WHERE merchant_id=? AND store_id=? ORDER BY id DESC',
        [req.merchantId, req.storeId]
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ riders: rows });
    } catch (_) { res.status(500).json({ error: '读取骑手列表失败' }); }
  });

  app.post('/api/admin/delivery/riders', requireAdminKey, requirePermission('can_manage_order'), async (req, res) => {
    try {
      const username = cleanText(req.body?.username, 80);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const displayName = cleanText(req.body?.displayName, 120);
      const phone = cleanText(req.body?.phone, 40);
      if (!/^[\p{L}\p{N}_.-]{3,80}$/u.test(username) || password.length < 8 || password.length > 128 || !displayName) {
        return res.status(400).json({ error: '账号至少3位，密码至少8位，并填写骑手姓名' });
      }
      const store = await getAsync('SELECT id, merchant_id FROM stores WHERE id=? AND merchant_id=? AND active=1', [req.storeId, req.merchantId]);
      if (!store) return res.status(403).json({ error: '无权操作当前门店' });
      const result = await runAsync(
        'INSERT INTO delivery_riders (merchant_id, store_id, username, password_hash, display_name, phone) VALUES (?, ?, ?, ?, ?, ?)',
        [store.merchant_id, store.id, username, hashPassword(password), displayName, phone]
      );
      res.status(201).json({ success: true, rider: { id: result.insertId, username, displayName, phone } });
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '该门店已存在相同骑手账号' });
      res.status(500).json({ error: '创建骑手失败' });
    }
  });

  app.get('/api/admin/delivery/jobs', requireAdminKey, requirePermission('can_manage_order'), async (req, res) => {
    try {
      const rows = await allAsync(
        `SELECT j.id, j.order_id, o.order_no, j.rider_id, r.display_name AS rider_name,
          r.phone AS rider_phone, j.recipient_name, j.recipient_phone, j.delivery_address,
          j.status, j.assigned_at, j.updated_at, l.latitude, l.longitude, l.accuracy_m,
          l.updated_at AS location_updated_at
         FROM delivery_jobs j JOIN orders o ON o.id=j.order_id AND o.store_id=j.store_id
         LEFT JOIN delivery_riders r ON r.id=j.rider_id AND r.store_id=j.store_id
         LEFT JOIN delivery_rider_locations l ON l.rider_id=j.rider_id AND l.store_id=j.store_id
         WHERE j.merchant_id=? AND j.store_id=? ORDER BY j.updated_at DESC LIMIT 200`,
        [req.merchantId, req.storeId]
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ jobs: rows });
    } catch (_) { res.status(500).json({ error: '读取配送任务失败' }); }
  });

  app.post('/api/admin/delivery/orders/:id/assign', requireAdminKey, requirePermission('can_manage_order'), async (req, res) => {
    const orderId = positiveId(req.params.id);
    const riderId = positiveId(req.body?.riderId);
    const address = cleanText(req.body?.address, 500);
    const recipientName = cleanText(req.body?.recipientName, 120);
    const recipientPhone = cleanText(req.body?.recipientPhone, 40);
    if (!orderId || !riderId || !address) return res.status(400).json({ error: '订单、骑手和配送地址不能为空' });
    try {
      const job = await withTransaction(async () => {
        const order = await getAsync('SELECT id, status FROM orders WHERE id=? AND store_id=? FOR UPDATE', [orderId, req.storeId]);
        if (!order || order.status === 'canceled') {
          const error = new Error('订单不存在或已取消'); error.status = 404; throw error;
        }
        const rider = await getAsync(
          'SELECT id FROM delivery_riders WHERE id=? AND merchant_id=? AND store_id=? AND active=1 FOR UPDATE',
          [riderId, req.merchantId, req.storeId]
        );
        if (!rider) { const error = new Error('骑手不存在或已停用'); error.status = 404; throw error; }
        await runAsync(
          `INSERT INTO delivery_jobs (merchant_id, store_id, order_id, rider_id, recipient_name, recipient_phone, delivery_address, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'assigned')
           ON DUPLICATE KEY UPDATE rider_id=VALUES(rider_id), recipient_name=VALUES(recipient_name),
           recipient_phone=VALUES(recipient_phone), delivery_address=VALUES(delivery_address),
           status='assigned', assigned_at=UTC_TIMESTAMP(3), accepted_at=NULL, picked_up_at=NULL, delivered_at=NULL`,
          [req.merchantId, req.storeId, orderId, riderId, recipientName, recipientPhone, address]
        );
        return getAsync('SELECT id, order_id, rider_id, status, delivery_address FROM delivery_jobs WHERE order_id=? AND store_id=?', [orderId, req.storeId]);
      });
      io.to('delivery-order-' + orderId).emit('delivery:status', { orderId, status: 'assigned' });
      res.json({ success: true, job });
    } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '分配配送任务失败' }); }
  });

  app.post('/api/delivery/login', async (req, res) => {
    try {
      const username = cleanText(req.body?.username, 80);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const storeId = positiveId(req.body?.storeId);
      if (!username || !password || !storeId) return res.status(400).json({ error: '请输入门店编号、骑手账号和密码' });
      const rider = await getAsync(
        'SELECT id, merchant_id, store_id, username, password_hash, display_name, phone FROM delivery_riders WHERE store_id=? AND username=? AND active=1',
        [storeId, username]
      );
      if (!rider || !verifyPassword(password, rider.password_hash)) return res.status(401).json({ error: '账号或密码错误' });
      const store = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1', [rider.store_id, rider.merchant_id]);
      if (!store) return res.status(403).json({ error: '门店已停用' });
      const token = crypto.randomBytes(32).toString('base64url');
      await runAsync(
        'INSERT INTO delivery_rider_sessions (rider_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 7 DAY))',
        [rider.id, hashSessionToken(token)]
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, token, rider: { id: rider.id, storeId: rider.store_id, displayName: rider.display_name, phone: rider.phone } });
    } catch (_) { res.status(500).json({ error: '骑手登录失败' }); }
  });

  app.get('/api/delivery/jobs', getRider, async (req, res) => {
    try {
      const rows = await allAsync(
        `SELECT j.id, j.order_id, o.order_no, j.recipient_name, j.recipient_phone,
          j.delivery_address, j.status, j.assigned_at, j.updated_at
         FROM delivery_jobs j JOIN orders o ON o.id=j.order_id AND o.store_id=j.store_id
         WHERE j.rider_id=? AND j.store_id=? AND j.status NOT IN ('delivered','cancelled')
         ORDER BY j.updated_at DESC LIMIT 100`,
        [req.deliveryRider.id, req.deliveryRider.store_id]
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json({ jobs: rows, rider: { displayName: req.deliveryRider.display_name } });
    } catch (_) { res.status(500).json({ error: '读取配送任务失败' }); }
  });

  app.post('/api/delivery/jobs/:id/status', getRider, async (req, res) => {
    const jobId = positiveId(req.params.id);
    const nextStatus = cleanText(req.body?.status, 20);
    const transitions = { assigned: 'accepted', accepted: 'picked_up', picked_up: 'delivering', delivering: 'delivered' };
    if (!jobId || !Object.values(transitions).includes(nextStatus)) return res.status(400).json({ error: '配送状态无效' });
    try {
      const job = await getAsync(
        'SELECT id, order_id, status FROM delivery_jobs WHERE id=? AND rider_id=? AND store_id=?',
        [jobId, req.deliveryRider.id, req.deliveryRider.store_id]
      );
      if (!job || transitions[job.status] !== nextStatus) return res.status(409).json({ error: '配送状态已变化，请刷新后重试' });
      const timestampColumn = { accepted: 'accepted_at', picked_up: 'picked_up_at', delivered: 'delivered_at' }[nextStatus];
      await runAsync(
        `UPDATE delivery_jobs SET status=?, ${timestampColumn ? timestampColumn + '=UTC_TIMESTAMP(3),' : ''} updated_at=UTC_TIMESTAMP(3)
         WHERE id=? AND rider_id=? AND status=?`,
        [nextStatus, jobId, req.deliveryRider.id, job.status]
      );
      io.to('delivery-order-' + job.order_id).emit('delivery:status', { orderId: job.order_id, status: nextStatus });
      res.json({ success: true, status: nextStatus });
    } catch (_) { res.status(500).json({ error: '更新配送状态失败' }); }
  });

  app.post('/api/delivery/jobs/:id/location', getRider, async (req, res) => {
    const jobId = positiveId(req.params.id);
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const accuracy = req.body?.accuracy == null ? null : Number(req.body.accuracy);
    if (!jobId || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000))) {
      return res.status(400).json({ error: '定位数据无效' });
    }
    try {
      const job = await getAsync(
        "SELECT id, order_id FROM delivery_jobs WHERE id=? AND rider_id=? AND store_id=? AND status IN ('accepted','picked_up','delivering')",
        [jobId, req.deliveryRider.id, req.deliveryRider.store_id]
      );
      if (!job) return res.status(409).json({ error: '当前任务不在配送状态' });
      await runAsync(
        `INSERT INTO delivery_rider_locations (rider_id, merchant_id, store_id, latitude, longitude, accuracy_m, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE latitude=VALUES(latitude), longitude=VALUES(longitude),
         accuracy_m=VALUES(accuracy_m), updated_at=UTC_TIMESTAMP(3)`,
        [req.deliveryRider.id, req.deliveryRider.merchant_id, req.deliveryRider.store_id, latitude, longitude, accuracy]
      );
      const location = { orderId: job.order_id, latitude, longitude, accuracy, updatedAt: new Date().toISOString() };
      io.to('delivery-order-' + job.order_id).emit('delivery:location', location);
      res.json({ success: true, updatedAt: location.updatedAt });
    } catch (_) { res.status(500).json({ error: '保存定位失败' }); }
  });

  app.post('/api/delivery/logout', getRider, async (req, res) => {
    try {
      await runAsync('DELETE FROM delivery_rider_sessions WHERE token_hash=?', [req.deliveryRiderTokenHash]);
      res.json({ success: true });
    } catch (_) { res.status(500).json({ error: '退出登录失败' }); }
  });

  app.get('/api/public/delivery/:orderId', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const orderId = positiveId(req.params.orderId);
      const token = typeof req.get('X-Customer-Token') === 'string' ? req.get('X-Customer-Token').trim() : '';
      if (!orderId || !token || token.length > 128) return res.status(401).json({ error: '订单或顾客凭证无效' });
      const order = await getAsync('SELECT id, customer_token FROM orders WHERE id=?', [orderId]);
      if (!order || !order.customer_token || hashSessionToken(token) !== order.customer_token) return res.status(404).json({ error: '配送信息不存在' });
      const job = await getAsync(
        `SELECT j.id, j.order_id, j.recipient_name, j.recipient_phone, j.delivery_address, j.status,
          j.updated_at, r.display_name AS rider_name, r.phone AS rider_phone,
          l.latitude, l.longitude, l.accuracy_m, l.updated_at AS location_updated_at
         FROM delivery_jobs j LEFT JOIN delivery_riders r ON r.id=j.rider_id AND r.store_id=j.store_id
         LEFT JOIN delivery_rider_locations l ON l.rider_id=j.rider_id AND l.store_id=j.store_id
         WHERE j.order_id=? AND j.store_id=(SELECT store_id FROM orders WHERE id=?)`,
        [orderId, orderId]
      );
      if (!job) return res.status(404).json({ error: '该订单尚未分配配送员' });
      res.json({ job });
    } catch (_) { res.status(500).json({ error: '查询配送信息失败' }); }
  });
};
