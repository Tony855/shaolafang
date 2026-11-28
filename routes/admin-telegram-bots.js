'use strict';

const crypto = require('node:crypto');
const { normalizeRouteError } = require('../server/utils/http-error');
const { validateBotToken, getTelegramBotUsername } = require('../server/services/telegram-bot');
const { encryptBotToken, fingerprintBotToken } = require('../server/services/telegram-bot-credentials');

function flag(value, fallback, label) {
  if (value === undefined) return fallback;
  if ([true, 1, '1'].includes(value)) return 1;
  if ([false, 0, '0'].includes(value)) return 0;
  throw Object.assign(new Error(label + ' 参数无效'), { status: 400 });
}

module.exports = function registerTenantTelegramBotRoutes(app, deps) {
  const {
    getAsync, runAsync, withTransaction, requireAdminKey, requirePermission,
    getClientIp, getTelegramBotUsername: getUsername = getTelegramBotUsername
  } = deps;

  function getMerchantId(req) {
    const id = Number(req.merchantId);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('商户信息无效'), { status: 403 });
    if (req.isPrimaryAdmin !== true) throw Object.assign(new Error('只有租户主管理员可以管理 Telegram Bot 凭据'), { status: 403 });
    return id;
  }

  function publicConfig(row) {
    return {
      configured: Boolean(row),
      client: {
        enabled: Number(row?.client_bot_enabled) === 1,
        tokenConfigured: Boolean(row?.client_bot_token_encrypted),
        username: row?.client_bot_username || null
      },
      admin: {
        enabled: Number(row?.admin_bot_enabled) === 1,
        tokenConfigured: Boolean(row?.admin_bot_token_encrypted),
        username: row?.admin_bot_username || null
      }
    };
  }

  async function audit(req, merchantId, action, details) {
    const actor = req.adminId
      ? await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=?', [req.adminId, merchantId])
      : null;
    await runAsync(
      'INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['merchant_admin', req.adminId || null, actor?.username || '', action, 'telegram_merchant_bot', merchantId,
        JSON.stringify(details), typeof getClientIp === 'function' ? getClientIp(req) : '', new Date().toISOString()]
    );
  }

  app.get('/api/admin/telegram/bot', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = getMerchantId(req);
      const row = await getAsync(
        'SELECT client_bot_enabled, client_bot_token_encrypted, client_bot_username, admin_bot_enabled, admin_bot_token_encrypted, admin_bot_username FROM telegram_merchant_bots WHERE merchant_id=? LIMIT 1',
        [merchantId]
      );
      res.setHeader('Cache-Control', 'no-store, private');
      res.json(publicConfig(row));
    } catch (error) {
      const safe = normalizeRouteError(error, 'Telegram Bot 配置读取失败');
      res.status(safe.status).json({ error: safe.message });
    }
  });

  app.put('/api/admin/telegram/bot', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
    try {
      const merchantId = getMerchantId(req);
      const body = req.body || {};
      const suppliedClientToken = body.clientBotToken === undefined ? null : String(body.clientBotToken || '').trim();
      const suppliedAdminToken = body.adminBotToken === undefined ? null : String(body.adminBotToken || '').trim();
      const clearClient = body.clearClientBotToken === true;
      const clearAdmin = body.clearAdminBotToken === true;
      if (suppliedClientToken && !validateBotToken(suppliedClientToken)) {
        return res.status(400).json({ error: 'Client Bot Token 格式无效' });
      }
      if (suppliedAdminToken && !validateBotToken(suppliedAdminToken)) {
        return res.status(400).json({ error: 'Admin Bot Token 格式无效' });
      }
      if ((suppliedClientToken && clearClient) || (suppliedAdminToken && clearAdmin)) {
        return res.status(400).json({ error: '不能同时设置和清除同一个 Bot Token' });
      }

      const clientUsername = suppliedClientToken ? await getUsername({ token: suppliedClientToken }) : null;
      const adminUsername = suppliedAdminToken ? await getUsername({ token: suppliedAdminToken }) : null;
      let saved;
      await withTransaction(async () => {
        const merchant = await getAsync('SELECT id FROM merchants WHERE id=? AND status=1 FOR UPDATE', [merchantId]);
        if (!merchant) throw Object.assign(new Error('商户不存在或已停用'), { status: 403 });
        const current = await getAsync(
          'SELECT * FROM telegram_merchant_bots WHERE merchant_id=? FOR UPDATE',
          [merchantId]
        );

        const clientTokenEncrypted = clearClient ? null
          : suppliedClientToken ? encryptBotToken(suppliedClientToken) : current?.client_bot_token_encrypted || null;
        const clientFingerprint = clearClient ? null
          : suppliedClientToken ? fingerprintBotToken(suppliedClientToken) : current?.client_bot_token_fingerprint || null;
        const resolvedClientUsername = clearClient ? null
          : suppliedClientToken ? clientUsername : current?.client_bot_username || null;
        const adminTokenEncrypted = clearAdmin ? null
          : suppliedAdminToken ? encryptBotToken(suppliedAdminToken) : current?.admin_bot_token_encrypted || null;
        const adminFingerprint = clearAdmin ? null
          : suppliedAdminToken ? fingerprintBotToken(suppliedAdminToken) : current?.admin_bot_token_fingerprint || null;
        const resolvedAdminUsername = clearAdmin ? null
          : suppliedAdminToken ? adminUsername : current?.admin_bot_username || null;
        if (clientFingerprint && clientFingerprint === adminFingerprint) {
          throw Object.assign(new Error('Client Bot 和 Admin Bot 必须使用不同的 Bot Token'), { status: 409 });
        }
        const clientEnabled = clearClient ? 0 : flag(body.clientBotEnabled, Number(current?.client_bot_enabled || 0), 'Client Bot 状态');
        const adminEnabled = clearAdmin ? 0 : flag(body.adminBotEnabled, Number(current?.admin_bot_enabled || 0), 'Admin Bot 状态');

        if (clientEnabled && !clientTokenEncrypted) throw Object.assign(new Error('启用 Client Bot 前必须配置 Token'), { status: 409 });
        if (adminEnabled && !adminTokenEncrypted) throw Object.assign(new Error('启用 Admin Bot 前必须配置 Token'), { status: 409 });
        if (!clientTokenEncrypted && !adminTokenEncrypted) {
          throw Object.assign(new Error('至少配置一个租户 Bot Token'), { status: 400 });
        }

        const pathToken = current ? null : crypto.randomBytes(32).toString('base64url');
        const pathHash = current ? current.webhook_path_hash : crypto.createHash('sha256').update(pathToken).digest('hex');
        const pathEncrypted = current ? current.webhook_path_token_encrypted : encryptBotToken(pathToken);
        const webhookSecretEncrypted = current ? current.webhook_secret_encrypted
          : encryptBotToken(crypto.randomBytes(32).toString('base64url'));

        let botConfigId = current ? Number(current.id) : null;
        if (current) {
          await runAsync(
            'UPDATE telegram_merchant_bots SET client_bot_token_encrypted=?, client_bot_token_fingerprint=?, client_bot_username=?, client_bot_enabled=?, admin_bot_token_encrypted=?, admin_bot_token_fingerprint=?, admin_bot_username=?, admin_bot_enabled=?, updated_at=UTC_TIMESTAMP(3) WHERE id=? AND merchant_id=?',
            [clientTokenEncrypted, clientFingerprint, resolvedClientUsername, clientEnabled,
              adminTokenEncrypted, adminFingerprint, resolvedAdminUsername, adminEnabled, current.id, merchantId]
          );
        } else {
          const inserted = await runAsync(
            'INSERT INTO telegram_merchant_bots (merchant_id, client_bot_token_encrypted, client_bot_token_fingerprint, client_bot_username, client_bot_enabled, admin_bot_token_encrypted, admin_bot_token_fingerprint, admin_bot_username, admin_bot_enabled, webhook_path_hash, webhook_path_token_encrypted, webhook_secret_encrypted, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
            [merchantId, clientTokenEncrypted, clientFingerprint, resolvedClientUsername, clientEnabled,
              adminTokenEncrypted, adminFingerprint, resolvedAdminUsername, adminEnabled,
              pathHash, pathEncrypted, webhookSecretEncrypted]
          );
          botConfigId = Number(inserted?.lastID ?? inserted?.insertId);
        }
        if (!Number.isSafeInteger(botConfigId) || botConfigId <= 0) {
          throw new Error('租户 Telegram Bot 配置保存结果无效');
        }
        await runAsync('DELETE FROM telegram_merchant_bot_token_registry WHERE bot_config_id=?', [botConfigId]);
        if (clientFingerprint) {
          await runAsync('INSERT INTO telegram_merchant_bot_token_registry (token_fingerprint, bot_config_id, profile, created_at) VALUES (?, ?, \'client\', UTC_TIMESTAMP(3))', [clientFingerprint, botConfigId]);
        }
        if (adminFingerprint) {
          await runAsync('INSERT INTO telegram_merchant_bot_token_registry (token_fingerprint, bot_config_id, profile, created_at) VALUES (?, ?, \'admin\', UTC_TIMESTAMP(3))', [adminFingerprint, botConfigId]);
        }
        saved = await getAsync(
          'SELECT client_bot_enabled, client_bot_token_encrypted, client_bot_username, admin_bot_enabled, admin_bot_token_encrypted, admin_bot_username FROM telegram_merchant_bots WHERE merchant_id=? LIMIT 1',
          [merchantId]
        );
        await audit(req, merchantId, current ? 'update_telegram_merchant_bot' : 'create_telegram_merchant_bot', {
          client_enabled: Boolean(clientEnabled), client_token_changed: Boolean(suppliedClientToken || clearClient),
          admin_enabled: Boolean(adminEnabled), admin_token_changed: Boolean(suppliedAdminToken || clearAdmin)
        });
      });

      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ success: true, config: publicConfig(saved) });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
        return res.status(409).json({ error: '该 Telegram Bot Token 已被其他租户使用' });
      }
      const safe = normalizeRouteError(error, 'Telegram Bot 配置保存失败，所有更改已回滚');
      res.status(safe.status).json({ error: safe.message });
    }
  });
};
