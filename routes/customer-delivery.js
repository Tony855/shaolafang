'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const khqr = require('../server/services/khqr');
const { hashSessionToken } = require('../server/services/session-token');
const { calculateOrderTotalCents, toMoneyCents } = require('../server/services/order-financial');
const { enqueueCustomerTelegramNotification, enqueueStoreAdminTelegramNotification } = require('../server/services/telegram-notification-enqueue');
const { getTelegramBotUsername } = require('../server/services/telegram-bot');
const { safeErrorMetadata } = require('../server/middleware/safe-error-metadata');
const { verifyTelegramWebAppInitData } = require('../server/services/telegram-webapp-auth');
const { createStoreEntrySignature, verifyStoreEntrySignature, createTenantStoreEntrySignature, verifyTenantStoreEntrySignature } = require('../server/services/telegram-store-entry');
const { decryptBotToken } = require('../server/services/telegram-bot-credentials');

function positiveId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';
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
    getOrderCooldownMs, checkAndSetCooldown, getClientIp, formatOrder, io, logger = console } = deps;


  // Persistent browser customer identity used by delivery orders and Telegram binding.
  // The raw token is accepted only as a high-entropy bearer credential and is stored hashed.
  function getDeliveryCustomerToken(req) {
    const header = typeof req.get === 'function' ? req.get('X-Customer-Token') : req.headers?.['x-customer-token'];
    const bodyToken = typeof req.body?.customer_token === 'string' ? req.body.customer_token : '';
    const token = typeof header === 'string' && header.trim() ? header.trim() : bodyToken.trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : '';
  }

  async function getActiveDeliveryStore(storeId) {
    return getAsync(
      'SELECT s.id, s.name, s.merchant_id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
      [storeId]
    );
  }

  function logTelegramStoreResolutionRejected(stage, reason) {
    try { logger.warn('[telegram-miniapp-store-resolution] rejected', { stage, reason }); } catch (_) {}
  }

  app.get('/api/public/delivery/telegram-miniapp-stores', async (req, res) => {
    let failureStage = 'request';
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const initData = typeof req.get === 'function'
        ? String(req.get('X-Telegram-Init-Data') || '')
        : String(req.headers?.['x-telegram-init-data'] || '');
      if (!initData) {
        logTelegramStoreResolutionRejected('request', 'missing_init_data');
        return res.status(401).json({ error: 'Telegram 身份验证失败，请从门店专属链接重新打开' });
      }

      failureStage = 'bot_configuration';
      const botPath = String(req.query?.bot || '');
      let tenantMerchantId = null;
      let botToken = '';
      let secret = '';
      if (botPath) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(botPath)) return res.status(404).json({ error: 'Telegram Bot 入口无效' });
        const pathHash = crypto.createHash('sha256').update(botPath).digest('hex');
        const tenantBot = await getAsync(
          'SELECT merchant_id, client_bot_token_encrypted, webhook_secret_encrypted FROM telegram_merchant_bots WHERE webhook_path_hash=? AND client_bot_enabled=1 LIMIT 1',
          [pathHash]
        );
        if (!tenantBot?.client_bot_token_encrypted || !tenantBot?.webhook_secret_encrypted) {
          return res.status(403).json({ error: '此商户的 Telegram Bot 未启用或入口已失效' });
        }
        tenantMerchantId = positiveId(String(tenantBot.merchant_id || ''));
        if (!tenantMerchantId) return res.status(403).json({ error: 'Telegram Bot 租户配置无效' });
        botToken = decryptBotToken(tenantBot.client_bot_token_encrypted);
        secret = decryptBotToken(tenantBot.webhook_secret_encrypted);
      } else {
        const rows = await allAsync(
          'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
          ['telegram_client_bot_enabled', 'telegram_client_bot_token']
        );
        const config = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
        if (config.telegram_client_bot_enabled !== '1') {
          logTelegramStoreResolutionRejected('bot_configuration', 'legacy_bot_disabled');
          return res.status(403).json({ error: '统一 Client Bot 未启用，请使用商户自己的 Telegram Bot 入口' });
        }
        botToken = String(config.telegram_client_bot_token || '');
        secret = String(process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET || '');
      }
      const telegramIdentity = verifyTelegramWebAppInitData(initData, botToken);
      if (!telegramIdentity) {
        logTelegramStoreResolutionRejected('bot_configuration', 'init_data_invalid');
        return res.status(403).json({ error: 'Telegram Bot 身份无效或已过期，请重新打开商户入口' });
      }

      failureStage = 'entry_validation';
      const storeId = positiveId(String(req.query?.store_id || ''));
      const signature = typeof req.query?.entry === 'string' ? req.query.entry : '';
      if (secret.length < 32 || secret.length > 256) {
        logTelegramStoreResolutionRejected('entry_validation', 'signing_secret_unconfigured');
        return res.status(503).json({ error: 'Telegram 门店入口尚未完成安全配置，请联系管理员' });
      }

      if (tenantMerchantId) {
        if (!storeId && !signature) {
          failureStage = 'tenant_store_lookup';
          const stores = await allAsync(
            'SELECT s.id, s.name FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.merchant_id=? AND s.active=1 AND m.status=1 ORDER BY s.name, s.id LIMIT 100',
            [tenantMerchantId]
          );
          const list = (Array.isArray(stores) ? stores : []).map(store => ({
            id: Number(store.id),
            merchantId: tenantMerchantId,
            name: cleanText(String(store.name || ''), 100) || '商户门店',
            entry: createTenantStoreEntrySignature({ merchantId: tenantMerchantId, storeId: store.id, secret })
          })).filter(store => Number.isSafeInteger(store.id) && store.id > 0);
          if (!list.length) return res.status(404).json({ error: '此商户目前没有可点餐的门店' });
          return res.json({ stores: list });
        }
        if (!storeId || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
          return res.status(403).json({ error: '门店专属链接无效或已过期，请重新获取' });
        }
        failureStage = 'tenant_store_validation';
        const store = await getAsync(
          'SELECT s.id, s.name, s.merchant_id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1 LIMIT 1',
          [storeId, tenantMerchantId]
        );
        if (!store || !verifyTenantStoreEntrySignature({ merchantId: tenantMerchantId, storeId, secret, signature })) {
          return res.status(403).json({ error: '此门店不属于当前商户或入口签名无效' });
        }
        return res.json({ stores: [{
          id: Number(store.id), merchantId: tenantMerchantId,
          name: cleanText(String(store.name || ''), 100) || '商户门店', entry: signature
        }] });
      }

      // Legacy shared-Bot compatibility: store-specific links remain bound to
      // the store's current notification Chat ID until that merchant migrates.
      if (!storeId && !signature) {
        failureStage = 'customer_binding_lookup';
        const telegramUserId = String(telegramIdentity.user.id);
        const bindings = await allAsync(
          'SELECT b.store_id, b.merchant_id, r.chat_id, s.id, s.name FROM telegram_customer_bindings b JOIN stores s ON s.id=b.store_id AND s.merchant_id=b.merchant_id JOIN merchants m ON m.id=b.merchant_id JOIN telegram_store_admin_recipients r ON r.merchant_id=b.merchant_id AND r.store_id=b.store_id WHERE b.telegram_user_id=? AND b.is_active=1 AND b.revoked_at IS NULL AND r.is_enabled=1 AND LENGTH(r.chat_id)>0 AND s.active=1 AND m.status=1 ORDER BY b.updated_at DESC, b.id DESC LIMIT 1',
          [telegramUserId]
        );
        const binding = Array.isArray(bindings) ? bindings[0] : null;
        if (!binding) return res.status(404).json({ error: '当前 Telegram 账号尚未绑定可用门店。请先点击门店管理员提供的专属点餐链接。' });
        const resolvedStoreId = positiveId(String(binding.id || binding.store_id || ''));
        if (!resolvedStoreId || !binding.chat_id) return res.status(404).json({ error: '当前 Telegram 账号没有可用的门店入口' });
        const resolvedEntry = createStoreEntrySignature({ storeId: resolvedStoreId, chatId: String(binding.chat_id), secret });
        return res.json({ stores: [{
          id: resolvedStoreId, merchantId: Number(binding.merchant_id),
          name: cleanText(String(binding.name || ''), 100) || 'FoodFlow 门店', entry: resolvedEntry
        }] });
      }

      if (!storeId || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
        logTelegramStoreResolutionRejected('entry_validation', 'entry_invalid');
        return res.status(403).json({ error: '门店专属链接无效或已过期，请重新获取门店链接' });
      }
      failureStage = 'store_binding_lookup';
      const recipient = await getAsync(
        'SELECT r.chat_id, s.id, s.name, s.merchant_id FROM telegram_store_admin_recipients r JOIN stores s ON s.id=r.store_id AND s.merchant_id=r.merchant_id JOIN merchants m ON m.id=r.merchant_id WHERE r.store_id=? AND r.is_enabled=1 AND r.chat_id<>\\'\\' AND s.active=1 AND m.status=1 LIMIT 1',
        [storeId]
      );
      if (!recipient || !verifyStoreEntrySignature({ storeId, chatId: String(recipient.chat_id || ''), secret, signature })) {
        logTelegramStoreResolutionRejected('store_binding_lookup', recipient ? 'entry_signature_mismatch' : 'active_store_binding_missing');
        return res.status(403).json({ error: '门店群组绑定已变更或已解除，请向门店管理员获取最新专属链接' });
      }
      res.json({ stores: [{
        id: Number(recipient.id), merchantId: Number(recipient.merchant_id),
        name: cleanText(String(recipient.name || ''), 100) || 'FoodFlow 门店', entry: signature
      }] });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;
      try { logger.error('[telegram-miniapp-store-resolution] failed', { stage: failureStage, ...safeErrorMetadata(error), ...(code ? { code } : {}) }); } catch (_) {}
      res.status(503).json({ error: '暂时无法读取此门店，请稍后重试' });
    }
  });

  app.get('/api/public/delivery/customer-telegram/binding', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const storeId = positiveId(String(req.query?.store_id || ''));
      const customerToken = getDeliveryCustomerToken(req);
      if (!storeId || !customerToken) return res.status(400).json({ error: '门店或顾客身份凭证无效' });
      const store = await getActiveDeliveryStore(storeId);
      if (!store) return res.status(404).json({ error: '门店不存在或已停用' });
      const binding = await getAsync(
        'SELECT id FROM telegram_customer_bindings WHERE customer_token_hash=? AND merchant_id=? AND store_id=? AND is_active=1 AND revoked_at IS NULL',
        [hashSessionToken(customerToken), store.merchant_id, storeId]
      );
      res.json({ bound: Boolean(binding) });
    } catch (_) {
      res.status(500).json({ error: '读取 Telegram 绑定状态失败' });
    }
  });

  app.post('/api/public/delivery/customer-telegram/binding/start', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const storeId = positiveId(String(req.body?.store_id || ''));
      const customerToken = getDeliveryCustomerToken(req);
      if (!storeId || !customerToken) return res.status(400).json({ error: '门店或顾客身份凭证无效' });
      const store = await getActiveDeliveryStore(storeId);
      if (!store) return res.status(404).json({ error: '门店不存在或已停用' });
      let username = '';
      const tenantBot = await getAsync(
        'SELECT client_bot_enabled, client_bot_username, client_bot_token_encrypted, webhook_secret_encrypted FROM telegram_merchant_bots WHERE merchant_id=? LIMIT 1',
        [store.merchant_id]
      );
      if (Number(tenantBot?.client_bot_enabled) === 1 && tenantBot.client_bot_token_encrypted && tenantBot.webhook_secret_encrypted) {
        // The tenant Bot's credentials are decrypted only server-side. The signed
        // challenge remains bound to this store and merchant.
        decryptBotToken(tenantBot.client_bot_token_encrypted);
        decryptBotToken(tenantBot.webhook_secret_encrypted);
        username = String(tenantBot.client_bot_username || '');
        if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return res.status(409).json({ error: '当前商户 Telegram Bot 配置无效' });
      } else {
        const rows = await allAsync(
          'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
          ['telegram_client_bot_enabled', 'telegram_client_bot_token']
        );
        const config = Object.fromEntries((Array.isArray(rows) ? rows : []).map(row => [row.key, row.value]));
        if (config.telegram_client_bot_enabled !== '1' || !config.telegram_client_bot_token) {
          return res.status(409).json({ error: '当前商户尚未启用 Telegram 顾客入口' });
        }
        const webhookSecret = String(process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET || '');
        if (webhookSecret.length < 32 || webhookSecret.length > 256) {
          return res.status(503).json({ error: 'Telegram 绑定服务尚未完成安全配置' });
        }
        username = await getTelegramBotUsername({ token: String(config.telegram_client_bot_token) });
      }
      const ip = getClientIp(req) || 'unknown';
      const cooldownKey = 'delivery:telegram-bind:' + storeId + ':' + crypto.createHash('sha256').update(ip + ':' + hashSessionToken(customerToken)).digest('hex');
      const allowed = await checkAndSetCooldown(cooldownKey, 30000);
      if (allowed === null) return res.status(503).json({ error: '绑定服务暂时不可用，请稍后重试' });
      if (!allowed) return res.status(429).json({ error: '绑定请求过于频繁，请稍后再试' });
      const challenge = crypto.randomBytes(32).toString('base64url');
      const challengeHash = crypto.createHash('sha256').update(challenge).digest('hex');
      await runAsync(
        'DELETE FROM telegram_customer_binding_challenges WHERE expires_at < UTC_TIMESTAMP(3) OR consumed_at IS NOT NULL'
      );
      await runAsync(
        'DELETE FROM telegram_customer_binding_challenges WHERE customer_token_hash=? AND store_id=? AND consumed_at IS NULL',
        [hashSessionToken(customerToken), storeId]
      );
      await runAsync(
        'INSERT INTO telegram_customer_binding_challenges (challenge_hash, customer_token_hash, merchant_id, store_id, expires_at, created_at) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE), UTC_TIMESTAMP(3))',
        [challengeHash, hashSessionToken(customerToken), store.merchant_id, storeId]
      );
      res.json({ deepLink: `https://t.me/${username}?start=${challenge}`, expiresInSeconds: 600 });
    } catch (_) {
      res.status(503).json({ error: 'Telegram 绑定暂时不可用，请稍后重试' });
    }
  });

  app.delete('/api/public/delivery/customer-telegram/binding', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const storeId = positiveId(String(req.query?.store_id || req.body?.store_id || ''));
      const customerToken = getDeliveryCustomerToken(req);
      if (!storeId || !customerToken) return res.status(400).json({ error: '门店或顾客身份凭证无效' });
      const store = await getActiveDeliveryStore(storeId);
      if (!store) return res.status(404).json({ error: '门店不存在或已停用' });
      const identity = [hashSessionToken(customerToken), store.merchant_id, storeId];
      const result = await withTransaction(async () => {
        const bindings = await allAsync(
          'SELECT id FROM telegram_customer_bindings WHERE customer_token_hash=? AND merchant_id=? AND store_id=? AND is_active=1 FOR UPDATE',
          identity
        );
        const ids = Array.isArray(bindings) ? bindings.map(row => Number(row.id)).filter(id => Number.isSafeInteger(id) && id > 0) : [];
        if (ids.length) {
          const placeholders = ids.map(() => '?').join(',');
          await runAsync(
            "UPDATE telegram_notification_outbox SET state='dead', locked_by=NULL, locked_until=NULL, last_error_code='binding_revoked', updated_at=UTC_TIMESTAMP(3) WHERE recipient_scope='customer' AND state IN ('pending','processing') AND recipient_key IN (" + placeholders + ')',
            ids.map(id => `binding:${id}`)
          );
        }
        return runAsync(
          'UPDATE telegram_customer_bindings SET is_active=0, revoked_at=UTC_TIMESTAMP(3), updated_at=UTC_TIMESTAMP(3) WHERE customer_token_hash=? AND merchant_id=? AND store_id=? AND is_active=1',
          identity
        );
      });
      res.json({ success: true, revoked: Number(result.affectedRows) > 0 });
    } catch (_) {
      res.status(500).json({ error: '撤销 Telegram 绑定失败' });
    }
  });

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
      if (!/^[+0-9()\-\s]{6,40}$/.test(recipientPhone)) {
        return res.status(400).json({ error: '联系电话格式无效' });
      }
      if (!['cash', 'khqr'].includes(paymentMethod)) {
        return res.status(400).json({ error: '当前仅支持现金或 KHQR 支付方式' });
      }
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 200) {
        return res.status(400).json({ error: '订单菜品数量无效' });
      }
      const maxItemsRow = await getAsync("SELECT value FROM settings WHERE `key`='max_order_items'");
      const configuredMaxItems = Number(maxItemsRow?.value ?? 50);
      const maxItems = Number.isSafeInteger(configuredMaxItems) && configuredMaxItems > 0 ? Math.min(configuredMaxItems, 200) : 50;
      if (body.items.length > maxItems) return res.status(400).json({ error: `单次下单菜品不能超过 ${maxItems} 种` });

      const store = await getAsync(
        'SELECT s.id, s.name, s.merchant_id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
        [storeId]
      );
      if (!store) return res.status(404).json({ error: '门店不存在或已停用' });
      if (body.telegram_entry === true) {
        const initData = typeof req.get === 'function'
          ? String(req.get('X-Telegram-Init-Data') || '')
          : String(req.headers?.['x-telegram-init-data'] || '');
        if (!initData) return res.status(401).json({ error: 'Telegram 身份验证缺失，请从门店专属链接重新打开' });

        const signature = typeof body.store_entry === 'string' ? body.store_entry : '';
        const botPath = typeof body.bot_path === 'string' ? body.bot_path : '';
        if (botPath) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(botPath)) return res.status(403).json({ error: '商户 Telegram Bot 入口无效' });
          const pathHash = crypto.createHash('sha256').update(botPath).digest('hex');
          const tenantBot = await getAsync(
            'SELECT client_bot_token_encrypted, webhook_secret_encrypted FROM telegram_merchant_bots WHERE webhook_path_hash=? AND merchant_id=? AND client_bot_enabled=1 LIMIT 1',
            [pathHash, store.merchant_id]
          );
          if (!tenantBot?.client_bot_token_encrypted || !tenantBot?.webhook_secret_encrypted) {
            return res.status(403).json({ error: '此门店不属于当前 Telegram Bot 租户或 Bot 已停用' });
          }
          const botToken = decryptBotToken(tenantBot.client_bot_token_encrypted);
          const secret = decryptBotToken(tenantBot.webhook_secret_encrypted);
          const telegramIdentity = verifyTelegramWebAppInitData(initData, botToken);
          if (!telegramIdentity) return res.status(403).json({ error: '当前商户 Telegram Bot 身份无效或已过期' });
          if (!verifyTenantStoreEntrySignature({ merchantId: store.merchant_id, storeId, secret, signature })) {
            return res.status(403).json({ error: '门店专属入口已失效，请重新从当前商户 Bot 进入' });
          }
        } else {
          const settings = await allAsync(
            'SELECT `key`, value FROM settings WHERE `key` IN (?, ?)',
            ['telegram_client_bot_enabled', 'telegram_client_bot_token']
          );
          const config = Object.fromEntries((Array.isArray(settings) ? settings : []).map(row => [row.key, row.value]));
          const botToken = String(config.telegram_client_bot_token || '');
          const telegramIdentity = config.telegram_client_bot_enabled === '1'
            ? verifyTelegramWebAppInitData(initData, botToken)
            : null;
          if (!telegramIdentity) return res.status(403).json({ error: '统一 Client Bot 身份无效、未启用或已过期，请重新打开门店专属链接' });

          const secret = String(process.env.TELEGRAM_CLIENT_WEBHOOK_SECRET || '');
          const recipient = await getAsync(
            'SELECT chat_id FROM telegram_store_admin_recipients WHERE merchant_id=? AND store_id=? AND is_enabled=1 AND chat_id<>\\'\\' LIMIT 1',
            [store.merchant_id, storeId]
          );
          if (!recipient || !verifyStoreEntrySignature({ storeId, chatId: String(recipient.chat_id || ''), secret, signature })) {
            return res.status(403).json({ error: '门店专属入口已失效，请重新从门店 Telegram 链接进入' });
          }
        }
      }

      let items;
      try {
        items = await normalizeOrderItems(body.items, storeId);
      } catch (error) {
        if (!error?.code) return res.status(400).json({ error: error.message || '订单菜品无效' });
        throw error;
      }
      const totalCents = calculateOrderTotalCents(items);
      if (totalCents === null || totalCents <= 0) return res.status(400).json({ error: '订单金额无效' });
      const total = totalCents / 100;
      const maxQtyRow = await getAsync("SELECT value FROM settings WHERE `key`='max_item_quantity'");
      const maxQtyRaw = maxQtyRow?.value ?? '100';
      const maxQty = Number.isSafeInteger(Number(maxQtyRaw)) && Number(maxQtyRaw) > 0 ? Math.min(Number(maxQtyRaw), 1000) : 100;
      if (items.some(item => !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > maxQty)) {
        return res.status(400).json({ error: `单个菜品数量必须为 1 至 ${maxQty} 份` });
      }
      const idempotencyKey = typeof req.get === 'function' ? String(req.get('Idempotency-Key') || '').trim() : String(req.headers?.['idempotency-key'] || '').trim();
      const suppliedCustomerToken = getDeliveryCustomerToken(req);
      if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) return res.status(400).json({ error: '下单请求凭证无效，请刷新页面后重试' });
      if (!suppliedCustomerToken) return res.status(401).json({ error: '顾客身份凭证缺失，请刷新页面后重试' });

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

      const customerToken = suppliedCustomerToken;
      const customerTokenHash = hashSessionToken(customerToken);
      const idempotencyKeyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({
        storeId, merchantId: Number(store.merchant_id), customerTokenHash,
        recipientName, recipientPhone, deliveryAddress, note, paymentMethod, items
      })).digest('hex');
      let idempotentReplay = false;
      const createdAt = new Date().toISOString();
      let orderId = null;
      let orderNo = '';
      let orderRow = null;
      await withTransaction(async () => {
        const activeStore = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id AND m.status=1 WHERE s.id=? AND s.merchant_id=? AND s.active=1 FOR UPDATE',
          [storeId, store.merchant_id]
        );
        if (!activeStore) throw Object.assign(new Error('门店状态已变化，请刷新后重试'), { status: 409 });
        await runAsync(
          'INSERT IGNORE INTO delivery_order_requests (store_id, idempotency_key_hash, customer_token_hash, request_hash, order_id) VALUES (?, ?, ?, ?, NULL)',
          [storeId, idempotencyKeyHash, customerTokenHash, requestHash]
        );
        const requestRecord = await getAsync(
          'SELECT store_id, customer_token_hash, request_hash, order_id FROM delivery_order_requests WHERE store_id=? AND idempotency_key_hash=? FOR UPDATE',
          [storeId, idempotencyKeyHash]
        );
        if (!requestRecord || requestRecord.customer_token_hash !== customerTokenHash || requestRecord.request_hash !== requestHash) {
          throw Object.assign(new Error('此下单请求凭证已用于其他订单内容，请重新整理购物车后再提交'), { status: 409 });
        }
        if (requestRecord.order_id) {
          orderId = Number(requestRecord.order_id);
          orderRow = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [orderId, storeId]);
          if (!orderRow) throw Object.assign(new Error('原订单暂时无法读取，请稍后重试'), { status: 503 });
          orderNo = String(orderRow.order_no || '');
          idempotentReplay = true;
          return;
        }
        const ip = getClientIp(req) || 'unknown';
        const cooldownKey = 'delivery:' + storeId + ':' + crypto.createHash('sha256').update(ip + ':' + recipientPhone).digest('hex');
        const cooldownMs = await getOrderCooldownMs();
        const allowed = await checkAndSetCooldown(cooldownKey, cooldownMs);
        if (allowed === null) throw Object.assign(new Error('订单服务暂时不可用，请稍后重试'), { status: 503 });
        if (!allowed) throw Object.assign(new Error('提交过于频繁，请稍后再试'), { status: 429 });
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
        for (const item of items) {
          if (item.id) await runAsync(
            'UPDATE menus SET sales_count = sales_count + ? WHERE id=? AND store_id=?',
            [Number(item.quantity) || 1, item.id, storeId]
          );
        }
        orderRow = await getAsync('SELECT * FROM orders WHERE id=? AND store_id=?', [orderId, storeId]);
        if (!orderRow) throw new Error('订单创建后无法读取，请重试');
        await enqueueStoreAdminTelegramNotification({
          allAsync,
          merchantId: store.merchant_id,
          storeId,
          eventKey: `order:${orderId}:created:store`,
          event: { type: 'order.created', storeName: store.name || `Store ${storeId}`, orderNo, items, tableName: '', fulfillmentType: 'delivery', recipientName, recipientPhone, deliveryAddress, amount: total, currency: 'USD', note }
        });
        await enqueueCustomerTelegramNotification({
          allAsync,
          customerTokenHash,
          merchantId: store.merchant_id,
          storeId,
          eventKey: `order:${orderId}:created:customer`,
          event: { type: 'order.created', storeName: store.name || `Store ${storeId}`, orderNo, items, tableName: '', fulfillmentType: 'delivery', recipientName, amount: total, currency: 'USD' },
          enqueue: deps.enqueueTelegramNotification
        });
        await runAsync(
          'UPDATE delivery_order_requests SET order_id=? WHERE store_id=? AND idempotency_key_hash=? AND request_hash=?',
          [orderId, storeId, idempotencyKeyHash, requestHash]
        );
      });

      if (!idempotentReplay) {
        const staffOrder = formatOrder(orderRow);
        delete staffOrder.sessionToken;
        delete staffOrder.customerToken;
        io.to('kitchen-' + storeId).emit('order:new', staffOrder);
        io.to('waiter-' + storeId).emit('order:new', staffOrder);
        io.to('cashier-' + storeId).emit('order:new', staffOrder);
        io.to('delivery-store-' + storeId).emit('delivery:status', { orderId: Number(orderId), status: 'pending_assignment' });
      }
      res.status(idempotentReplay ? 200 : 201).json({
        success: true,
        orderId: Number(orderId),
        orderNo: String(orderRow.order_no || orderNo),
        total: Number(orderRow.total),
        currency: 'USD',
        paymentMethod: String(orderRow.pay_method || paymentMethod),
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
      "SELECT o.* FROM orders o JOIN stores s ON s.id=o.store_id AND s.merchant_id=o.merchant_id AND s.active=1 JOIN merchants m ON m.id=o.merchant_id AND m.status=1 WHERE o.id=? AND o.fulfillment_type='delivery'",
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
      let staticCurrency = String(provider.currency || '').trim().toUpperCase();
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
        notification = { orderId, orderNo: locked.order_no, total: locked.total, table: null, storeId: order.store_id, pay_method: 'khqr', pay_qr_generation_id: generationId };
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
