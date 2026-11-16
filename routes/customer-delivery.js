'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const khqr = require('../server/services/khqr');
const { hashSessionToken } = require('../server/services/session-token');
const { calculateOrderTotalCents, toMoneyCents } = require('../server/services/order-financial');
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

function convertUsdCentsToKhr(usdCents, rateValue) {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0) return null;
  const rawRate = String(rateValue ?? '').trim();
  if (!/^\d+(?:\.\d{1,10})?$/.test(rawRate)) return null;
  const [whole, fraction = ''] = rawRate.split('.');
  const rateScaled = BigInt(whole) * 10000000000n + BigInt((fraction + '0000000000').slice(0, 10));
  if (rateScaled <= 0n) return null;
  const khr = (BigInt(usdCents) * rateScaled + 500000000000n) / 1000000000000n;
  return khr > 0n && khr <= 999999999n ? Number(khr) : null;
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

  async function authenticateDeliveryCustomer(req, orderId) {
    const token = typeof req.get('X-Customer-Token') === 'string' ? req.get('X-Customer-Token').trim() : '';
    if (!token || token.length !== 64 || !/^[a-f0-9]{64}$/.test(token)) {
      throw Object.assign(new Error('顾客订单凭证无效'), { status: 401 });
    }
    const order = await getAsync(
      "SELECT * FROM orders WHERE id=? AND fulfillment_type='delivery'",
      [orderId]
    );
    if (!order || !order.customer_token || hashSessionToken(token) !== order.customer_token) {
      throw Object.assign(new Error('订单不存在或顾客凭证无效'), { status: 404 });
    }
    return order;
  }

  app.post('/api/public/delivery/orders/:orderId/khqr', async (req, res) => {
    try {
      const orderId = positiveId(req.params.orderId);
      if (!orderId) return res.status(400).json({ error: '订单编号无效' });
      const order = await authenticateDeliveryCustomer(req, orderId);
      if (order.status !== 'pending') return res.status(409).json({ error: '订单状态不允许生成收款码' });
      if (Number(order.awaiting_confirm)) return res.status(409).json({ error: '该订单已提交收款确认，请等待门店处理' });
      const settingsRow = await getAsync('SELECT value FROM settings WHERE `key`=?', ['store_' + order.store_id + '_khqr_providers']);
      let providers = [];
      try { providers = settingsRow?.value ? JSON.parse(settingsRow.value) : []; } catch (_) { providers = []; }
      if (!Array.isArray(providers)) providers = [];
      const enabled = providers.filter(provider => provider && provider.enabled && typeof provider.payload === 'string' && provider.payload.length <= 4096);
      if (!enabled.length) return res.status(409).json({ error: '该门店尚未配置可用的 KHQR 收款码' });
      const requestedProviderId = cleanText(req.body?.provider_id, 100);
      const provider = requestedProviderId
        ? enabled.find(item => item.id === requestedProviderId)
        : (enabled.find(item => item.isDefault) || enabled[0]);
      if (!provider) return res.status(400).json({ error: '指定的 KHQR 收款码不可用' });
      let staticCurrency = provider.currency;
      if (!staticCurrency) {
        const info = khqr.extractInfo(khqr.parseTLV(provider.payload));
        staticCurrency = info.currency === '840' ? 'USD' : (info.currency === '116' ? 'KHR' : 'USD');
      }
      const requestedCurrency = String(req.body?.currency || '').trim().toUpperCase();
      const currency = ['USD', 'KHR'].includes(requestedCurrency) ? requestedCurrency : staticCurrency;
      if (!['USD', 'KHR'].includes(currency)) return res.status(409).json({ error: '该收款码币种暂不支持在线收款' });
      const baseCents = toMoneyCents(order.total);
      if (baseCents === null || baseCents <= 0) return res.status(400).json({ error: '订单金额无效' });
      let amount = baseCents / 100;
      if (currency === 'KHR') {
        const rateRows = await allAsync('SELECT code, rate FROM currencies WHERE merchant_id=?', [order.merchant_id]);
        const rateRow = rateRows.find(row => String(row.code).toUpperCase() === 'KHR');
        amount = convertUsdCentsToKhr(baseCents, rateRow?.rate);
        if (amount === null) return res.status(409).json({ error: 'KHR 汇率缺失或无效，请联系门店' });
      }
      const expiresRow = await getAsync('SELECT value FROM settings WHERE `key`=?', ['store_' + order.store_id + '_khqr_expire_minutes']);
      const expireMinutes = Math.max(1, Math.min(60, parseInt(expiresRow?.value || '10', 10) || 10));
      const expiresAt = new Date(Date.now() + expireMinutes * 60000).toISOString();
      const generationId = crypto.randomBytes(24).toString('hex');
      const payload = khqr.buildDynamicPayload(provider.payload, amount, currency, order.order_no || String(order.id));
      const qrDataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
      await withTransaction(async () => {
        const locked = await getAsync(
          "SELECT status, total, awaiting_confirm, pay_khqr_ref, pay_expires_at FROM orders WHERE id=? AND store_id=? AND fulfillment_type='delivery' FOR UPDATE",
          [orderId, order.store_id]
        );
        if (!locked || locked.status !== 'pending' || toMoneyCents(locked.total) !== baseCents) {
          throw Object.assign(new Error('订单状态或金额已变化，无法生成收款码'), { status: 409 });
        }
        if (Number(locked.awaiting_confirm)) throw Object.assign(new Error('订单已提交收款确认'), { status: 409 });
        if (locked.pay_khqr_ref) {
          const expiry = Date.parse(locked.pay_expires_at || '');
          if (!Number.isFinite(expiry) || expiry > Date.now()) {
            throw Object.assign(new Error('订单已有有效收款码，请先完成或等待过期'), { status: 409 });
          }
        }
        const updated = await runAsync(
          "UPDATE orders SET pay_method='khqr', pay_khqr_ref=?, pay_expires_at=?, pay_qr_generation_id=? WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=0",
          [payload, expiresAt, generationId, orderId, order.store_id]
        );
        if (!updated?.affectedRows) throw Object.assign(new Error('订单状态已变化，无法生成收款码'), { status: 409 });
      });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ qr_payload: payload, qr_data_url: qrDataUrl, qr_generation_id: generationId, amount, currency, merchant_name: provider.merchantName || '', provider_label: provider.label || '', expires_at: expiresAt });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) console.error('[customer-delivery] KHQR generation failed', safeErrorMetadata(error));
      res.status(status).json({ error: status === 500 ? '暂时无法生成收款码，请稍后重试' : error.message });
    }
  });

  app.post('/api/public/delivery/orders/:orderId/payment-notify', async (req, res) => {
    try {
      const orderId = positiveId(req.params.orderId);
      if (!orderId) return res.status(400).json({ error: '订单编号无效' });
      const order = await authenticateDeliveryCustomer(req, orderId);
      const generationId = typeof req.body?.qr_generation_id === 'string' ? req.body.qr_generation_id.trim() : '';
      if (!/^[a-f0-9]{48}$/.test(generationId)) return res.status(400).json({ error: '二维码标识无效' });
      let notification = null;
      await withTransaction(async () => {
        const locked = await getAsync(
          "SELECT id, status, table_name, order_no, total, pay_khqr_ref, pay_expires_at, pay_qr_generation_id, awaiting_confirm FROM orders WHERE id=? AND store_id=? AND fulfillment_type='delivery' FOR UPDATE",
          [orderId, order.store_id]
        );
        if (!locked || locked.status !== 'pending' || !locked.pay_khqr_ref ||
            locked.pay_qr_generation_id !== generationId || Number(locked.awaiting_confirm)) {
          throw Object.assign(new Error('收款码已失效或订单状态已变化'), { status: 409 });
        }
        const expiry = Date.parse(locked.pay_expires_at || '');
        if (!Number.isFinite(expiry) || expiry <= Date.now()) {
          throw Object.assign(new Error('收款码已过期，请重新生成'), { status: 410 });
        }
        const changed = await runAsync(
          "UPDATE orders SET awaiting_confirm=1 WHERE id=? AND store_id=? AND status='pending' AND awaiting_confirm=0 AND pay_qr_generation_id=?",
          [orderId, order.store_id, generationId]
        );
        if (!changed?.affectedRows) throw Object.assign(new Error('收款确认已被其他请求提交'), { status: 409 });
        notification = { orderId, orderNo: locked.order_no, total: locked.total, table: null, storeId: order.store_id };
        await runAsync(
          'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['customer', 0, 'delivery_customer', 'delivery_khqr_notify', JSON.stringify({ order_id: orderId, qr_generation_id: generationId }), getClientIp(req), new Date().toISOString()]
        );
      });
      io.to('cashier-' + order.store_id).emit('khqr:awaiting', notification);
      res.json({ success: true, status: 'awaiting_confirm' });
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) console.error('[customer-delivery] KHQR notification failed', safeErrorMetadata(error));
      res.status(status).json({ error: status === 500 ? '提交收款确认失败，请稍后重试' : error.message });
    }
  });

};
