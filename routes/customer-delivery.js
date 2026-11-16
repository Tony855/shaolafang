'use strict';

const crypto = require('node:crypto');
const { hashSessionToken } = require('../server/services/session-token');
const { calculateOrderTotalCents } = require('../server/services/order-financial');
const { enqueueStoreAdminTelegramNotification } = require('../server/services/telegram-notification-enqueue');
const { safeErrorMetadata } = require('../server/middleware/safe-error-metadata');

function positiveId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^[1-9]\\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().replace(/[\\u0000-\\u001f\\u007f]/g, '').slice(0, max) : '';
}

module.exports = function registerCustomerDeliveryRoutes(app, deps) {
  const { getAsync, allAsync, runAsync, withTransaction, normalizeOrderItems, allocateOrderNo,
    getOrderCooldownMs, checkAndSetCooldown, getClientIp, formatOrder, io } = deps;

  app.post('/api/public/delivery/orders', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const storeId = positiveId(body.store_id);
      const recipientName = cleanText(body.recipient_name, 120);
      const recipientPhone = cleanText(body.recipient_phone, 40);
      const deliveryAddress = cleanText(body.delivery_address, 500);
      const note = cleanText(body.note, 200);
      const paymentMethod = String(body.payment_method || 'cash').trim().toLowerCase();
      if (!storeId) return res.status(400).json({ error: '门店编号无效' });
      if (!recipientName || !recipientPhone || !deliveryAddress) {
        return res.status(400).json({ error: '请填写收件人、联系电话和完整配送地址' });
      }
      if (!/^[+0-9()\\-\\s]{6,40}$/.test(recipientPhone)) {
        return res.status(400).json({ error: '联系电话格式无效' });
      }
      if (!['cash', 'khqr'].includes(paymentMethod)) {
        return res.status(400).json({ error: '当前仅支持现金或 KHQR 支付方式' });
      }
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 200) {
        return res.status(400).json({ error: '订单菜品数量无效' });
      }

      const store = await getAsync(
        'SELECT s.id, s.name, s.merchant_id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
        [storeId]
      );
      if (!store) return res.status(404).json({ error: '门店不存在或已停用' });

      const items = await normalizeOrderItems(body.items, storeId);
      const totalCents = calculateOrderTotalCents(items);
      if (totalCents === null || totalCents <= 0) return res.status(400).json({ error: '订单金额无效' });
      const total = totalCents / 100;
      const maxQtyRow = await getAsync("SELECT value FROM settings WHERE `key`='max_item_quantity'");
      const maxQtyRaw = maxQtyRow?.value ?? '100';
      const maxQty = Number.isSafeInteger(Number(maxQtyRaw)) && Number(maxQtyRaw) > 0 ? Math.min(Number(maxQtyRaw), 1000) : 100;
      if (items.some(item => !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > maxQty)) {
        return res.status(400).json({ error: `单个菜品数量必须为 1 至 ${maxQty} 份` });
      }

      const ip = getClientIp(req) || 'unknown';
      const cooldownKey = 'delivery:' + storeId + ':' + crypto.createHash('sha256').update(ip + ':' + recipientPhone).digest('hex');
      const cooldownMs = await getOrderCooldownMs();
      const allowed = await checkAndSetCooldown(cooldownKey, cooldownMs);
      if (allowed === null) return res.status(503).json({ error: '订单服务暂时不可用，请稍后重试' });
      if (!allowed) return res.status(429).json({ error: '提交过于频繁，请稍后再试' });

      const prefixRow = await getAsync("SELECT value FROM settings WHERE `key`=?", [`merchant_${store.merchant_id}_order_prefix_normal`])
        || await getAsync("SELECT value FROM settings WHERE `key`='order_prefix_normal'");
      const orderPrefix = String(prefixRow?.value || '11').padStart(2, '0').slice(-2);
      const dateKey = new Date().toISOString().slice(2, 10).replace(/-/g, '');
      const resetRow = await getAsync("SELECT value FROM settings WHERE `key`=?", [`merchant_${store.merchant_id}_order_no_reset_period`])
        || await getAsync("SELECT value FROM settings WHERE `key`='order_no_reset_period'");
      const reset = resetRow?.value || 'never';
      let sequencePrefix = orderPrefix + dateKey;
      if (reset === 'monthly') sequencePrefix = orderPrefix + dateKey.slice(0, 4);
      else if (reset === 'yearly') sequencePrefix = orderPrefix + dateKey.slice(0, 2);
      else if (reset === 'never') sequencePrefix = orderPrefix + 'GL';

      const customerToken = crypto.randomBytes(32).toString('hex');
      const customerTokenHash = hashSessionToken(customerToken);
      const createdAt = new Date().toISOString();
      let orderId = null;
      let orderNo = '';
      await withTransaction(async () => {
        const activeStore = await getAsync(
          'SELECT id FROM stores WHERE id=? AND merchant_id=? AND active=1 FOR UPDATE',
          [storeId, store.merchant_id]
        );
        if (!activeStore) throw Object.assign(new Error('门店状态已变化，请刷新后重试'), { status: 409 });
        orderNo = await allocateOrderNo(sequencePrefix);
        const inserted = await runAsync(
          "INSERT INTO orders (order_no, table_name, items, total, status, createdAt, session_token, customer_token, store_id, note, merchant_id, fulfillment_type, pay_method) VALUES (?, NULL, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?, 'delivery', ?)",
          [orderNo, JSON.stringify(items), total, createdAt, customerTokenHash, storeId, note, store.merchant_id, paymentMethod]
        );
        orderId = inserted.insertId || inserted.lastID;
        if (!Number.isSafeInteger(Number(orderId)) || Number(orderId) <= 0) {
          throw new Error('订单创建失败');
        }
        await runAsync(
          "INSERT INTO delivery_jobs (merchant_id, store_id, order_id, rider_id, recipient_name, recipient_phone, delivery_address, status) VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending_assignment')",
          [store.merchant_id, storeId, orderId, recipientName, recipientPhone, deliveryAddress]
        );
        await enqueueStoreAdminTelegramNotification({
          allAsync,
          merchantId: store.merchant_id,
          storeId,
          eventKey: `order:${orderId}:created:store`,
          event: { type: 'order.created', storeName: store.name || `Store ${storeId}`, orderNo, tableName: '', amount: total, currency: 'USD', note }
        });
      });

      const row = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [orderId, storeId]);
      const staffOrder = formatOrder(row);
      delete staffOrder.sessionToken;
      delete staffOrder.customerToken;
      io.to('kitchen-' + storeId).emit('order:new', staffOrder);
      io.to('waiter-' + storeId).emit('order:new', staffOrder);
      io.to('cashier-' + storeId).emit('order:new', staffOrder);
      io.to('delivery-store-' + storeId).emit('delivery:status', { orderId: Number(orderId), status: 'pending_assignment' });
      res.status(201).json({
        success: true,
        orderId: Number(orderId),
        orderNo,
        total,
        currency: 'USD',
        paymentMethod,
        customerToken,
        trackingUrl: `/delivery/track/${Number(orderId)}#token=${customerToken}`
      });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) console.error('[customer-delivery] order creation failed', safeErrorMetadata(error));
      res.status(status).json({ error: status === 500 ? '外卖订单暂时无法提交，请稍后重试' : error.message });
    }
  });
};
