/* ============================================================
   routes/super.js — 超级管理员路由
   ============================================================ */
const crypto = require('crypto');
const express = require('express');
const { needsRehash } = require('../server/middleware/password');
const os = require('os');
const fs = require('fs');

const { initMerchantSettings, initStoreSettings } = require('../server/services/settings-init');

function boundedInteger(value, fallback, min, max) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'string' && value.trim() === '')) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

module.exports = function(app, deps) {
  const { getAsync, runAsync, allAsync, isLoginLocked, recordLoginAttempt, resetLoginAttempts, verifyPassword, hashPassword, getClientIp, getLocationByIp, requireSuperAdmin, logAudit, collectBackupData, autoBackupDatabase, withTransaction } = deps;

app.post('/api/super/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'super_admin', '请输入用户名和密码']);
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const lockStatus = await isLoginLocked(username, 'super_admin');
    if (lockStatus.locked) {
      return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
    }
    const ipWhitelistSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'super_ip_whitelist'");
    const clientIp = getClientIp(req);
    if (ipWhitelistSetting && ipWhitelistSetting.value && ipWhitelistSetting.value.trim()) {
      const whitelist = ipWhitelistSetting.value.split(',').map(ip => ip.trim()).filter(Boolean);
      if (whitelist.length > 0 && !whitelist.includes(clientIp)) {
        await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, 'super_admin', 'IP不在白名单内']);
        return res.status(403).json({ error: '当前IP不允许登录超级管理员后台' });
      }
    }
    const superAdmin = await getAsync('SELECT * FROM super_admins WHERE username=?', [username]);
    if (!superAdmin) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, 'super_admin', '用户名不存在']);
      recordLoginAttempt(username, 'super_admin');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const isValid = verifyPassword(password, superAdmin.password_hash);
    if (!isValid) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, 'super_admin', '密码错误']);
      recordLoginAttempt(username, 'super_admin');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (needsRehash(superAdmin.password_hash)) {
      const upgradedHash = hashPassword(password);
      await runAsync('UPDATE super_admins SET password_hash=? WHERE id=? AND password_hash=?', [upgradedHash, superAdmin.id, superAdmin.password_hash]);
    }
    resetLoginAttempts(username, 'super_admin');
    await runAsync('UPDATE super_admins SET last_login_at=NOW() WHERE id=?', [superAdmin.id]);
    const superLocation = await getLocationByIp(clientIp);
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, location, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, superLocation, 'super_admin', '超级管理员登录成功: ' + username]);
    const token = crypto.randomBytes(32).toString('hex');
    const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'super_idle_timeout'");
    const configuredTimeoutMinutes = Number(timeoutSetting?.value ?? 60);
    const timeoutMinutes = Number.isSafeInteger(configuredTimeoutMinutes) && configuredTimeoutMinutes > 0 ? Math.min(configuredTimeoutMinutes, 1440) : 60;
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    await runAsync('INSERT INTO super_sessions (super_admin_id, token, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [superAdmin.id, token, expiresAt, new Date().toISOString(), clientIp, req.get('User-Agent') || '']);
    res.json({ success: true, token, admin: { id: superAdmin.id, username: superAdmin.username, display_name: superAdmin.display_name } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ===== 商户管理 CRUD =====
app.get('/api/super/merchants', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await allAsync(`SELECT m.*, 
      (SELECT COUNT(*) FROM stores WHERE merchant_id=m.id) as store_count,
      (SELECT username FROM merchant_admins WHERE merchant_id=m.id LIMIT 1) as admin_username,
      (SELECT display_name FROM merchant_admins WHERE merchant_id=m.id LIMIT 1) as admin_display_name
      FROM merchants m ORDER BY m.code ASC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/merchants', requireSuperAdmin, async (req, res) => {
  try {
    const { name, code, username, password, contact_name, contact_phone, max_stores, country } = req.body || {};
    const merchantName = typeof name === 'string' ? name.trim() : '';
    const adminUsername = typeof username === 'string' ? username.trim() : '';
    if (!merchantName || merchantName.length > 120) return res.status(400).json({ error: '商户名称必填且不能超过 120 个字符' });
    if (!adminUsername || adminUsername.length > 100) return res.status(400).json({ error: '登录账号必填且不能超过 100 个字符' });
    const storeLimit = max_stores === undefined || max_stores === null || max_stores === '' ? 1 : Number(max_stores);
    if (!Number.isSafeInteger(storeLimit) || storeLimit < 1 || storeLimit > 1000) {
      return res.status(400).json({ error: '门店数量上限必须为 1 至 1000 的整数' });
    }
    const adminPassword = (password && String(password).trim())
      ? String(password).trim()
      : crypto.randomBytes(24).toString('base64url');
    if (adminPassword.length < 12 || adminPassword.length > 128) {
      return res.status(400).json({ error: '管理员密码长度必须为 12 至 128 个字符' });
    }

    const userExists = await getAsync('SELECT id FROM merchant_admins WHERE username=?', [adminUsername]);
    if (userExists) return res.status(400).json({ error: '登录账号已存在' });
    let merchantCode = (typeof code === 'string' && code.trim()) ? code.trim() : '';
    if (merchantCode.length > 40) return res.status(400).json({ error: '商户编码不能超过 40 个字符' });
    if (merchantCode) {
      const codeExists = await getAsync('SELECT id FROM merchants WHERE code=?', [merchantCode]);
      if (codeExists) return res.status(400).json({ error: '商户编码已存在' });
    } else {
      const now = new Date();
      const monthPrefix = String(now.getFullYear()).slice(-2) + String(now.getMonth() + 1).padStart(2, '0');
      const monthCountRow = await getAsync("SELECT COUNT(*) AS cnt FROM merchants WHERE code LIKE ?", [monthPrefix + '%']);
      let seq = Number(monthCountRow?.cnt || 0) + 1;
      do {
        merchantCode = monthPrefix + String(seq).padStart(4, '0');
        seq++;
      } while (await getAsync('SELECT id FROM merchants WHERE code=?', [merchantCode]));
    }

    const countryCode = String(country || '').trim().toUpperCase().slice(0, 4);
    const adminHash = hashPassword(adminPassword);
    let newMerchantId;
    await withTransaction(async () => {
      const result = await runAsync(
        'INSERT INTO merchants (name, code, contact_name, contact_phone, max_stores, status, country) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [merchantName, merchantCode, String(contact_name || '').slice(0, 120), String(contact_phone || '').slice(0, 40), storeLimit, countryCode]
      );
      newMerchantId = result.lastID;
      await runAsync(
        'INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name) VALUES (?, ?, ?, ?)',
        [newMerchantId, adminUsername, adminHash, merchantName + '管理员']
      );
      for (const currency of [
        ['USD', '$', '美元', 1, 1], ['CNY', '¥', '人民币', 7, 0], ['VND', '₫', '越南盾', 25000, 0],
        ['THB', '฿', '泰铢', 32, 0], ['KHR', '៛', '柬埔寨瑞尔', 4000, 0]
      ]) {
        await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)', [newMerchantId, ...currency]);
      }
      const storeRes = await runAsync(
        'INSERT INTO stores (merchant_id, name, code, address, active) VALUES (?, ?, ?, ?, 1)',
        [newMerchantId, merchantName + '总店', merchantCode.toLowerCase() + '-main', '']
      );
      await initMerchantSettings(runAsync, newMerchantId);
      await initStoreSettings(runAsync, storeRes.lastID);
      await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'create_merchant', 'merchant', newMerchantId,
        `创建商户「${merchantName}」(编码: ${merchantCode}, 账号: ${adminUsername})`, getClientIp(req));
    });
    res.status(201).json({ success: true, id: newMerchantId, adminUsername, defaultPassword: adminPassword });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '商户编码或登录账号已存在，请刷新后重试' });
    res.status(500).json({ error: '创建商户失败' });
  }
});
app.put('/api/super/merchants/:id', requireSuperAdmin, async (req, res) => {
  try {
    const { name, username, password, contact_name, contact_phone, max_stores, status, country } = req.body || {};
    const merchantId = req.params.id;

    await withTransaction(async () => {
      const current = await getAsync('SELECT country FROM merchants WHERE id=? FOR UPDATE', [merchantId]);
      if (!current) {
        const error = new Error('商户不存在');
        error.statusCode = 404;
        throw error;
      }

      const primaryAdmin = await getAsync('SELECT id, username FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1 FOR UPDATE', [merchantId]);
      const nextUsername = typeof username === 'string' ? username.trim() : '';
      if (primaryAdmin && nextUsername && nextUsername !== primaryAdmin.username) {
        const exists = await getAsync('SELECT id FROM merchant_admins WHERE username=? AND id<>?', [nextUsername, primaryAdmin.id]);
        if (exists) {
          const error = new Error('登录账号已被使用');
          error.statusCode = 409;
          throw error;
        }
      }

      const nextCountry = country !== undefined
        ? String(country).trim().toUpperCase().slice(0, 4)
        : (current.country || '');
      await runAsync(
        'UPDATE merchants SET name=?, contact_name=?, contact_phone=?, max_stores=?, status=?, country=? WHERE id=?',
        [name, contact_name || '', contact_phone || '', max_stores || 1, status ?? 1, nextCountry, merchantId]
      );

      if (primaryAdmin) {
        if (nextUsername && nextUsername !== primaryAdmin.username) {
          await runAsync('UPDATE merchant_admins SET username=? WHERE id=?', [nextUsername, primaryAdmin.id]);
        }
        if (typeof password === 'string' && password.trim()) {
          const hash = hashPassword(password.trim());
          await runAsync('UPDATE merchant_admins SET password_hash=? WHERE id=?', [hash, primaryAdmin.id]);
        }
      }

      const updatedMerchant = await getAsync('SELECT name, code FROM merchants WHERE id=?', [merchantId]);
      await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'update_merchant', 'merchant', merchantId,
        `编辑商户「${updatedMerchant?.name || '未知'}」的信息`, getClientIp(req));
    });

    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({
      error: e.statusCode === 404 || e.statusCode === 409 ? e.message : '更新商户失败，所有更改已回滚'
    });
  }
});
app.delete('/api/super/merchants/:id', requireSuperAdmin, async (req, res) => {
  try {
    if (req.params.id === '1') return res.status(400).json({ error: '不能删除默认商户' });

    await withTransaction(async () => {
      // Lock the merchant row so the deletion is based on one consistent snapshot.
      const merchant = await getAsync('SELECT * FROM merchants WHERE id=? FOR UPDATE', [req.params.id]);
      if (!merchant) {
        const error = new Error('商户不存在');
        error.statusCode = 404;
        throw error;
      }
      const storeIds = (await allAsync('SELECT id FROM stores WHERE merchant_id=?', [req.params.id])).map(s => s.id);

      // Remove store-scoped records before deleting their parent stores.
      if (storeIds.length > 0) {
        const placeholders = storeIds.map(() => '?').join(',');
        for (const tbl of ['menus', 'tables', 'orders', 'waiters', 'printers', 'reservations', 'waiter_calls', 'scan_sessions', 'menu_categories']) {
          await runAsync(`DELETE FROM \`${tbl}\` WHERE store_id IN (${placeholders})`, storeIds);
        }
      }

      // Remove sessions before administrator accounts, then merchant-scoped data.
      await runAsync('DELETE FROM admin_sessions WHERE admin_id IN (SELECT id FROM merchant_admins WHERE merchant_id=?)', [req.params.id]);
      await runAsync('DELETE FROM cashier_sessions WHERE merchant_id=?', [req.params.id]);
      for (const sid of storeIds) {
        await runAsync("DELETE FROM settings WHERE `key` = ?", ['cashiers_' + sid]);
      }
      await runAsync("DELETE FROM settings WHERE `key` LIKE ?", [`merchant_${req.params.id}_%`]);
      await runAsync('DELETE FROM merchant_admins WHERE merchant_id=?', [req.params.id]);
      await runAsync('DELETE FROM currencies WHERE merchant_id=?', [req.params.id]);
      await runAsync('DELETE FROM login_logs WHERE merchant_id=?', [req.params.id]);
      await runAsync('DELETE FROM stores WHERE merchant_id=?', [req.params.id]);
      await runAsync('DELETE FROM merchants WHERE id=?', [req.params.id]);

      await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'delete_merchant', 'merchant', req.params.id,
        `删除商户「${merchant.name || '未知'}」(编码: ${merchant.code || '-'})`, getClientIp(req));
    });

    res.json({ success: true });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.statusCode === 404 ? e.message : '删除商户失败，所有更改已回滚' });
  }
});

app.post('/api/super/merchants/:id/reset-password', requireSuperAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    const newPwd = (password === undefined || password === null || String(password).trim() === '')
      ? crypto.randomBytes(24).toString('base64url')
      : String(password);
    if (newPwd.length < 12 || newPwd.length > 128) {
      return res.status(400).json({ error: '新密码长度必须为 12 至 128 个字符' });
    }
    const merchant = await getAsync('SELECT id FROM merchants WHERE id=?', [req.params.id]);
    if (!merchant) return res.status(404).json({ error: '商户不存在' });
    const hash = hashPassword(newPwd);
    await withTransaction(async () => {
      await runAsync('UPDATE merchant_admins SET password_hash=? WHERE merchant_id=?', [hash, req.params.id]);
      await runAsync('DELETE FROM admin_sessions WHERE admin_id IN (SELECT id FROM merchant_admins WHERE merchant_id=?)', [req.params.id]);
    });
    const merchantForLog = await getAsync('SELECT name, code FROM merchants WHERE id=?', [req.params.id]);
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'reset_merchant_password', 'merchant', req.params.id,
      `重置商户「${merchantForLog?.name || '未知'}」的管理员密码`, getClientIp(req));
    res.json({ success: true, newPassword: newPwd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超管仪表盘统计
app.get('/api/super/stats', requireSuperAdmin, async (req, res) => {
  try {
    const merchantCount = await getAsync('SELECT COUNT(*) as count FROM merchants');
    const storeCount = await getAsync('SELECT COUNT(*) as count FROM stores');
    const orderCount = await getAsync('SELECT COUNT(*) as count FROM orders');
    const todayOrders = await getAsync("SELECT COUNT(*) as count FROM orders WHERE SUBSTRING(createdAt, 1, 10)=CURDATE()");
    const todayRevenue = await getAsync("SELECT COALESCE(SUM(total - COALESCE(refund_amount,0)),0) as total FROM orders WHERE SUBSTRING(COALESCE(settled_at, createdAt), 1, 10)=CURDATE() AND status='done'");
    const monthRevenue = await getAsync("SELECT COALESCE(SUM(total - COALESCE(refund_amount,0)),0) as total FROM orders WHERE YEAR(COALESCE(settled_at, createdAt))=YEAR(CURDATE()) AND MONTH(COALESCE(settled_at, createdAt))=MONTH(CURDATE()) AND status='done'");
    const yearRevenue = await getAsync("SELECT COALESCE(SUM(total - COALESCE(refund_amount,0)),0) as total FROM orders WHERE YEAR(COALESCE(settled_at, createdAt))=YEAR(CURDATE()) AND status='done'");
    const monthOrders = await getAsync("SELECT COUNT(*) as count FROM orders WHERE YEAR(createdAt)=YEAR(CURDATE()) AND MONTH(createdAt)=MONTH(CURDATE())");
    const yearOrders = await getAsync("SELECT COUNT(*) as count FROM orders WHERE YEAR(createdAt)=YEAR(CURDATE())");
    const now = new Date().toISOString();
    const onlineClients = await getAsync('SELECT COUNT(*) as count FROM scan_sessions WHERE expires_at > ?', [now]);
    const totalScanSessions = await getAsync('SELECT COUNT(*) as count FROM scan_sessions');
    const todayScanSessions = await getAsync("SELECT COUNT(*) as count FROM scan_sessions WHERE DATE(created_at)=CURDATE()");
    res.json({
      merchantCount: merchantCount.count,
      storeCount: storeCount.count,
      orderCount: orderCount.count,
      todayOrders: todayOrders.count,
      todayRevenue: Number(todayRevenue.total) || 0,
      monthRevenue: Number(monthRevenue.total) || 0,
      monthOrders: monthOrders.count,
      yearRevenue: Number(yearRevenue.total) || 0,
      yearOrders: yearOrders.count,
      onlineClients: onlineClients.count,
      totalScanSessions: totalScanSessions.count,
      todayScanSessions: todayScanSessions.count
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 超管：按门店综合统计
app.get('/api/super/store-breakdown', requireSuperAdmin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const today = new Date().toISOString().split('T')[0];
    const rows = await allAsync(`
      SELECT s.id AS store_id, s.name AS store_name, m.name AS merchant_name,
        (SELECT COUNT(*) FROM orders o WHERE o.store_id=s.id) AS total_orders,
        (SELECT COUNT(*) FROM orders o WHERE o.store_id=s.id AND SUBSTRING(o.createdAt,1,10)=?) AS today_orders,
        (SELECT COALESCE(SUM(o.total - COALESCE(o.refund_amount,0)),0) FROM orders o WHERE o.store_id=s.id AND SUBSTRING(COALESCE(o.settled_at,o.createdAt),1,10)=? AND o.status='done') AS today_revenue,
        (SELECT COUNT(*) FROM orders o WHERE o.store_id=s.id AND YEAR(o.createdAt)=YEAR(CURDATE()) AND MONTH(o.createdAt)=MONTH(CURDATE())) AS month_orders,
        (SELECT COALESCE(SUM(o.total - COALESCE(o.refund_amount,0)),0) FROM orders o WHERE o.store_id=s.id AND YEAR(COALESCE(o.settled_at,o.createdAt))=YEAR(CURDATE()) AND MONTH(COALESCE(o.settled_at,o.createdAt))=MONTH(CURDATE()) AND o.status='done') AS month_revenue,
        (SELECT COUNT(*) FROM orders o WHERE o.store_id=s.id AND YEAR(o.createdAt)=YEAR(CURDATE())) AS year_orders,
        (SELECT COALESCE(SUM(o.total - COALESCE(o.refund_amount,0)),0) FROM orders o WHERE o.store_id=s.id AND YEAR(COALESCE(o.settled_at,o.createdAt))=YEAR(CURDATE()) AND o.status='done') AS year_revenue,
        (SELECT COUNT(*) FROM scan_sessions ss WHERE ss.store_id=s.id) AS total_sessions,
        (SELECT COUNT(*) FROM scan_sessions ss WHERE ss.store_id=s.id AND ss.expires_at>?) AS online_count
      FROM stores s
      LEFT JOIN merchants m ON m.id=s.merchant_id
      ORDER BY s.id
    `, [today, today, now]);
    res.json({ stores: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/online-sessions', requireSuperAdmin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const rows = await allAsync(`
      SELECT s.id AS store_id, s.name AS store_name, m.name AS merchant_name,
             COUNT(ss.token) AS online_count,
             COUNT(CASE WHEN o.id IS NOT NULL AND o.status='pending' THEN 1 END) AS pending_orders
      FROM stores s
      LEFT JOIN merchants m ON m.id = s.merchant_id
      LEFT JOIN scan_sessions ss ON ss.store_id = s.id AND ss.expires_at > ?
      LEFT JOIN orders o ON o.table_name = ss.table_name AND o.store_id = s.id AND o.status = 'pending'
      GROUP BY s.id, s.name, m.name
      ORDER BY online_count DESC, s.id
    `, [now]);
    res.json({ sessions: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/online-sessions/:storeId', requireSuperAdmin, async (req, res) => {
  try {
    const storeId = parseInt(req.params.storeId, 10);
    const now = new Date().toISOString();
    const store = await getAsync('SELECT s.*, m.name AS merchant_name FROM stores s LEFT JOIN merchants m ON m.id=s.merchant_id WHERE s.id=?', [storeId]);
    if (!store) return res.status(404).json({ error: '门店不存在' });
    const sessions = await allAsync(`
      SELECT ss.table_name, ss.token, ss.created_at, ss.expires_at,
             (SELECT o.order_no FROM orders o WHERE o.table_name=ss.table_name AND o.store_id=ss.store_id AND o.status='pending' ORDER BY o.id DESC LIMIT 1) AS active_order_no,
             (SELECT o.total FROM orders o WHERE o.table_name=ss.table_name AND o.store_id=ss.store_id AND o.status='pending' ORDER BY o.id DESC LIMIT 1) AS active_order_total
      FROM scan_sessions ss
      WHERE ss.store_id=? AND ss.expires_at > ?
      ORDER BY ss.created_at DESC
    `, [storeId, now]);
    res.json({ store: { id: store.id, name: store.name, merchant_name: store.merchant_name }, sessions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/server-stats', requireSuperAdmin, async (req, res) => {
  try {
    function getCpuTimes() {
      const cpus = os.cpus();
      let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
      for (const cpu of cpus) {
        user += cpu.times.user; nice += cpu.times.nice; sys += cpu.times.sys;
        idle += cpu.times.idle; irq += cpu.times.irq;
      }
      return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq };
    }
    const start = getCpuTimes();
    await new Promise(r => setTimeout(r, 300));
    const end = getCpuTimes();
    const idleDiff = end.idle - start.idle;
    const totalDiff = end.total - start.total;
    const cpuUsage = totalDiff > 0 ? ((1 - idleDiff / totalDiff) * 100).toFixed(1) : 0;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = ((usedMem / totalMem) * 100).toFixed(1);
    let diskUsage = 0, diskTotal = 0, diskUsed = 0;
    try {
      const stats = fs.statfsSync('/');
      diskTotal = stats.blocks * stats.bsize;
      diskUsed = (stats.blocks - stats.bfree) * stats.bsize;
      diskUsage = diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(1) : 0;
    } catch (e) { diskUsage = 0; }
    const uptimeSeconds = os.uptime();
    const uptimeDays = Math.floor(uptimeSeconds / 86400);
    const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
    const uptimeMins = Math.floor((uptimeSeconds % 3600) / 60);
    const processMem = process.memoryUsage();
    const loadAvg = os.loadavg();
    res.json({
      cpu: { usage: parseFloat(cpuUsage), cores: os.cpus().length, model: os.cpus()[0]?.model || 'Unknown' },
      memory: {
        total: totalMem, used: usedMem, free: freeMem, usage: parseFloat(memUsage),
        processRss: processMem.rss, processHeapUsed: processMem.heapUsed, processHeapTotal: processMem.heapTotal
      },
      disk: { total: diskTotal, used: diskUsed, free: diskTotal - diskUsed, usage: parseFloat(diskUsage) },
      system: {
        hostname: os.hostname(), platform: os.platform(), arch: os.arch(),
        uptime: uptimeSeconds,
        uptimeFormatted: `${uptimeDays}天 ${uptimeHours}时 ${uptimeMins}分`,
        loadAvg: loadAvg.map(v => v.toFixed(2)),
        nodeVersion: process.version
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/stores', requireSuperAdmin, async (req, res) => {
  try {
    const stores = await allAsync('SELECT s.*, m.name as merchant_name FROM stores s LEFT JOIN merchants m ON s.merchant_id = m.id ORDER BY s.id');
    res.json(stores);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/login-logs', requireSuperAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const logs = await allAsync('SELECT l.*, m.name as merchant_name FROM login_logs l LEFT JOIN merchants m ON l.merchant_id = m.id ORDER BY l.id DESC LIMIT ?', [limit]);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/settings', requireSuperAdmin, async (req, res) => {
  try {
    const rows = await allAsync("SELECT `key`, value FROM settings WHERE `key` IN ('super_idle_timeout', 'admin_idle_timeout', 'cashier_idle_timeout', 'kitchen_idle_timeout', 'qr_session_timeout', 'order_interval_seconds', 'waiter_refresh_interval', 'waiter_session_timeout', 'cashier_session_timeout', 'max_order_items', 'max_item_quantity', 'max_order_note_length', 'login_max_attempts', 'login_lock_minutes', 'super_ip_whitelist', 'call_limit_enabled', 'call_limit_max', 'call_limit_window_minutes', 'call_limit_cooldown_minutes', 'auto_clean_log_enabled', 'log_retention_days', 'clean_login_log', 'clean_audit_log', 'kitchen_auto_hide_minutes')");
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({
      super_idle_timeout: parseInt(settings.super_idle_timeout || '60', 10),
      admin_idle_timeout: parseInt(settings.admin_idle_timeout || '30', 10),
      cashier_idle_timeout: parseInt(settings.cashier_idle_timeout || '30', 10),
      kitchen_idle_timeout: parseInt(settings.kitchen_idle_timeout || '120', 10),
      qr_session_timeout: parseInt(settings.qr_session_timeout || '45', 10),
      waiter_session_timeout: parseInt(settings.waiter_session_timeout || '12', 10),
      cashier_session_timeout: parseInt(settings.cashier_session_timeout || '12', 10),
      order_interval_seconds: parseInt(settings.order_interval_seconds || '30', 10),
      waiter_refresh_interval: parseInt(settings.waiter_refresh_interval || '8', 10),
      max_order_items: parseInt(settings.max_order_items || '50', 10),
      max_item_quantity: parseInt(settings.max_item_quantity || '100', 10),
      max_order_note_length: parseInt(settings.max_order_note_length || '200', 10),
      login_max_attempts: parseInt(settings.login_max_attempts || '5', 10),
      login_lock_minutes: parseInt(settings.login_lock_minutes || '15', 10),
      super_ip_whitelist: settings.super_ip_whitelist || '',
      call_limit_enabled: (settings.call_limit_enabled || '1') !== '0',
      call_limit_max: parseInt(settings.call_limit_max || '3', 10),
      call_limit_window_minutes: parseInt(settings.call_limit_window_minutes || '5', 10),
      call_limit_cooldown_minutes: parseInt(settings.call_limit_cooldown_minutes || '10', 10),
      auto_clean_log_enabled: (settings.auto_clean_log_enabled || '0') !== '0',
      log_retention_days: parseInt(settings.log_retention_days || '30', 10),
      clean_login_log: (settings.clean_login_log || '1') !== '0',
      clean_audit_log: (settings.clean_audit_log || '1') !== '0',
      kitchen_auto_hide_minutes: parseInt(settings.kitchen_auto_hide_minutes || '10', 10),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/super/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { super_idle_timeout, admin_idle_timeout, cashier_idle_timeout, kitchen_idle_timeout, qr_session_timeout, order_interval_seconds, waiter_refresh_interval, waiter_session_timeout, cashier_session_timeout, max_order_items, max_item_quantity, max_order_note_length, login_max_attempts, login_lock_minutes, super_ip_whitelist, call_limit_enabled, call_limit_max, call_limit_window_minutes, call_limit_cooldown_minutes, auto_clean_log_enabled, log_retention_days, clean_login_log, clean_audit_log, kitchen_auto_hide_minutes } = req.body || {};
    await withTransaction(async () => {
    if (super_idle_timeout !== undefined) {
      const mins = boundedInteger(super_idle_timeout, 60, 1, 1440);
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('super_idle_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (admin_idle_timeout !== undefined) {
      const mins = boundedInteger(admin_idle_timeout, 30, 1, 1440);
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('admin_idle_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (qr_session_timeout !== undefined) {
      const mins = boundedInteger(qr_session_timeout, 45, 0, 1440);
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('qr_session_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (cashier_idle_timeout !== undefined) {
      const mins = boundedInteger(cashier_idle_timeout, 30, 1, 1440);
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('cashier_idle_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (kitchen_idle_timeout !== undefined) {
      const mins = boundedInteger(kitchen_idle_timeout, 120, 1, 1440);
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('kitchen_idle_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    if (waiter_session_timeout !== undefined) {
      const hours = boundedInteger(waiter_session_timeout, 12, 1, 168);
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('waiter_session_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(hours), String(hours)]);
    }

    if (cashier_session_timeout !== undefined) {
      const hours = boundedInteger(cashier_session_timeout, 12, 1, 168);
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('cashier_session_timeout', ?) ON DUPLICATE KEY UPDATE value=?", [String(hours), String(hours)]);
    }
    if (order_interval_seconds !== undefined) {
      const secs = Math.max(0, Math.min(3600, parseInt(order_interval_seconds, 10) || 30));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('order_interval_seconds', ?) ON DUPLICATE KEY UPDATE value=?", [String(secs), String(secs)]);
    }
    if (waiter_refresh_interval !== undefined) {
      const secs = Math.max(3, Math.min(300, parseInt(waiter_refresh_interval, 10) || 8));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('waiter_refresh_interval', ?) ON DUPLICATE KEY UPDATE value=?", [String(secs), String(secs)]);
    }
    if (max_order_items !== undefined) {
      const val = Math.max(1, Math.min(200, parseInt(max_order_items, 10) || 50));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('max_order_items', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (max_item_quantity !== undefined) {
      const val = Math.max(1, Math.min(999, parseInt(max_item_quantity, 10) || 100));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('max_item_quantity', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (max_order_note_length !== undefined) {
      const val = Math.max(10, Math.min(1000, parseInt(max_order_note_length, 10) || 200));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('max_order_note_length', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (login_max_attempts !== undefined) {
      const val = Math.max(1, Math.min(20, parseInt(login_max_attempts, 10) || 5));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('login_max_attempts', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (login_lock_minutes !== undefined) {
      const val = Math.max(1, Math.min(1440, parseInt(login_lock_minutes, 10) || 15));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('login_lock_minutes', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (super_ip_whitelist !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('super_ip_whitelist', ?) ON DUPLICATE KEY UPDATE value=?", [String(super_ip_whitelist || ''), String(super_ip_whitelist || '')]);
    }
    if (call_limit_enabled !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_enabled', ?) ON DUPLICATE KEY UPDATE value=?", [call_limit_enabled ? '1' : '0', call_limit_enabled ? '1' : '0']);
    }
    if (call_limit_max !== undefined) {
      const val = Math.max(1, Math.min(20, parseInt(call_limit_max, 10) || 3));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_max', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (call_limit_window_minutes !== undefined) {
      const val = Math.max(1, Math.min(60, parseInt(call_limit_window_minutes, 10) || 5));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_window_minutes', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (call_limit_cooldown_minutes !== undefined) {
      const val = Math.max(1, Math.min(120, parseInt(call_limit_cooldown_minutes, 10) || 10));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('call_limit_cooldown_minutes', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (auto_clean_log_enabled !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('auto_clean_log_enabled', ?) ON DUPLICATE KEY UPDATE value=?", [auto_clean_log_enabled ? '1' : '0', auto_clean_log_enabled ? '1' : '0']);
    }
    if (log_retention_days !== undefined) {
      const val = Math.max(1, Math.min(365, parseInt(log_retention_days, 10) || 30));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('log_retention_days', ?) ON DUPLICATE KEY UPDATE value=?", [String(val), String(val)]);
    }
    if (clean_login_log !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('clean_login_log', ?) ON DUPLICATE KEY UPDATE value=?", [clean_login_log ? '1' : '0', clean_login_log ? '1' : '0']);
    }
    if (clean_audit_log !== undefined) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('clean_audit_log', ?) ON DUPLICATE KEY UPDATE value=?", [clean_audit_log ? '1' : '0', clean_audit_log ? '1' : '0']);
    }
    if (kitchen_auto_hide_minutes !== undefined) {
      const mins = Math.max(0, Math.min(120, parseInt(kitchen_auto_hide_minutes, 10) || 10));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('kitchen_auto_hide_minutes', ?) ON DUPLICATE KEY UPDATE value=?", [String(mins), String(mins)]);
    }
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'update_settings', 'settings', null,
      '更新系统全局设置', getClientIp(req));
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/audit-logs', requireSuperAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const logs = await allAsync('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/logout', requireSuperAdmin, async (req, res) => {
  try {
    if (req.superSessionToken) {
      await runAsync('DELETE FROM super_sessions WHERE token=?', [req.superSessionToken]).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/change-password', requireSuperAdmin, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
    if (newPassword.length < 12 || newPassword.length > 128) return res.status(400).json({ error: '新密码长度必须为 12 至 128 个字符' });
    if (!verifyPassword(oldPassword, req.superAdmin.password_hash)) {
      return res.status(401).json({ error: '旧密码错误' });
    }
    const hash = hashPassword(newPassword);
    await withTransaction(async () => {
      await runAsync('UPDATE super_admins SET password_hash=? WHERE id=?', [hash, req.superAdmin.id]);
      await runAsync('DELETE FROM super_sessions WHERE super_admin_id=? AND token<>?', [req.superAdmin.id, req.superSessionToken || '']);
      await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'change_password', 'super_admin', req.superAdmin.id, '修改超级管理员登录密码', getClientIp(req));
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/backup/export', requireSuperAdmin, async (req, res) => {
  try {
    const data = await collectBackupData();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="foodflow-full-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/backup/import', requireSuperAdmin, express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const data = req.body;
    const tables = ['merchants', 'stores', 'tables', 'menu_categories', 'menus', 'currencies', 'order_sequences', 'orders', 'settings', 'login_logs', 'audit_logs', 'waiters', 'waiter_calls', 'reservations', 'printers', 'merchant_admins', 'super_admins'];
    if (!data || !data.tables || typeof data.tables !== 'object' || Array.isArray(data.tables)) {
      return res.status(400).json({ error: '备份文件格式无效' });
    }
    // Older backups may not contain the order sequence table; restore it as empty for compatibility.
    if (data.tables.order_sequences === undefined) data.tables.order_sequences = [];
    // Reject incomplete or malformed backups before deleting a single production row.
    for (const table of tables) {
      if (!Array.isArray(data.tables[table])) {
        return res.status(400).json({ error: `备份缺少有效数据表：${table}` });
      }
      if (data.tables[table].length > 100000) {
        return res.status(413).json({ error: `数据表 ${table} 的记录数超过导入限制` });
      }
      if (data.tables[table].some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        return res.status(400).json({ error: `数据表 ${table} 包含无效记录` });
      }
    }
    await withTransaction(async () => {
      for (const table of tables) {
        const rows = data.tables[table];
        const columns = await allAsync(`SHOW COLUMNS FROM \`${table}\``);
        const allowedColumns = new Set(columns.map(column => column.Field));
        for (const row of rows) {
          const rowKeys = Object.keys(row);
          const invalidKeys = rowKeys.filter(key => !allowedColumns.has(key));
          if (invalidKeys.length) {
            throw new Error(`备份表 ${table} 包含未知字段：${invalidKeys.join(', ')}`);
          }
        }
      }
      for (const table of [...tables].reverse()) {
        await runAsync(`DELETE FROM \`${table}\``);
      }
      for (const table of tables) {
        const rows = data.tables[table];
        for (const row of rows) {
          // Preserve primary keys so store_id, merchant_id and order references remain intact.
          const keys = Object.keys(row);
          if (!keys.length) continue;
          const placeholders = keys.map(() => '?').join(', ');
          const values = keys.map(key => row[key]);
          await runAsync(`INSERT INTO \`${table}\` (${keys.map(key => `\`${key}\``).join(', ')}) VALUES (${placeholders})`, values);
        }
      }
      // Never restore live authentication/QR sessions from a backup; invalidate all old tokens.
      for (const sessionTable of ['scan_sessions', 'waiter_sessions', 'cashier_sessions', 'admin_sessions', 'super_sessions']) {
        await runAsync(`DELETE FROM \`${sessionTable}\``);
      }
    });
    res.json({ success: true, message: '备份已导入；所有旧登录和扫码会话已失效' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/super/backup/settings', requireSuperAdmin, async (req, res) => {
  try {
    const intervalRow = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
    const lastBackupRow = await getAsync("SELECT value FROM settings WHERE `key` = 'last_backup_at'");
    const retentionRow = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_retention_days'");
    res.json({
      intervalHours: parseInt(intervalRow?.value || '24', 10),
      retentionDays: parseInt(retentionRow?.value || '30', 10),
      lastBackupAt: lastBackupRow?.value || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/super/backup/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { intervalHours, retentionDays } = req.body || {};
    if (intervalHours !== undefined) {
      const hours = Math.max(1, Math.min(168, parseInt(intervalHours, 10) || 24));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_interval_hours', ?) ON DUPLICATE KEY UPDATE value=?", [String(hours), String(hours)]);
    }
    if (retentionDays !== undefined) {
      const days = Math.max(1, Math.min(3650, parseInt(retentionDays, 10) || 120));
      await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_retention_days', ?) ON DUPLICATE KEY UPDATE value=?", [String(days), String(days)]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/backup/now', requireSuperAdmin, async (req, res) => {
  try {
    await autoBackupDatabase();
    res.json({ success: true, message: '备份已生成' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/super/reset-data', requireSuperAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '请提供超级管理员密码' });
    if (!verifyPassword(password, req.superAdmin.password_hash)) {
      return res.status(401).json({ error: '密码错误，重置失败' });
    }

    // Keep all destructive DML and its audit record atomic. MySQL ALTER TABLE
    // implicitly commits, so auto-increment maintenance must happen afterwards.
    await withTransaction(async () => {
      await runAsync('DELETE FROM orders');
      await runAsync('DELETE FROM waiter_calls');
      await runAsync('DELETE FROM scan_sessions');
      await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'reset_all_data', 'system', null, '重置所有订单数据', getClientIp(req));
    });

    let sequenceReset = true;
    try {
      await runAsync('ALTER TABLE orders AUTO_INCREMENT = 1');
    } catch (error) {
      sequenceReset = false;
    }
    try {
      await runAsync('ALTER TABLE scan_sessions AUTO_INCREMENT = 1');
    } catch (error) {
      sequenceReset = false;
    }
    res.json({
      success: true,
      message: sequenceReset ? '所有订单数据已重置' : '数据已重置，但部分自增序号未能重置',
      sequenceReset
    });
  } catch (e) { res.status(500).json({ error: '数据重置失败，所有删除操作已回滚' }); }
});


// ===== 商户支付方式配置 =====
app.get('/api/super/merchants/:id/payment-methods', requireSuperAdmin, async (req, res) => {
  try {
    const mid = parseInt(req.params.id, 10);
    const row = await getAsync("SELECT value FROM settings WHERE `key`=?", [`merchant_${mid}_payment_methods`]);
    const methods = {};
    // 内置 4 种默认全开
    const builtin = ['cash', 'wechat', 'alipay', 'card'];
    builtin.forEach(k => { methods[k] = true; });
    // 该商户所有 KHQR bank 默认全开
    const banks = await getMerchantBanks(mid);
    banks.forEach(b => { methods[b] = true; });
    // 已有配置覆盖
    if (row && row.value) {
      try {
        const saved = JSON.parse(row.value);
        Object.keys(saved).forEach(k => { methods[k] = saved[k] !== false; });
      } catch (e) {}
    }
    res.json({ methods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 辅助：读取该商户所有 store 下配置的 KHQR bank 名（去重、小写、无空格）
async function getMerchantBanks(merchantId) {
  const stores = await allAsync("SELECT id FROM stores WHERE merchant_id=?", [merchantId]);
  const bankSet = new Set();
  for (const st of stores) {
    const row = await getAsync("SELECT value FROM settings WHERE `key`=?", [`store_${st.id}_khqr_providers`]);
    if (!row || !row.value) continue;
    try {
      const list = JSON.parse(row.value);
      (list || []).forEach(p => {
        if (p && p.bank) {
          const key = String(p.bank).toLowerCase().replace(/[^a-z0-9]/g, '');
          if (key) bankSet.add(key);
        }
      });
    } catch (e) {}
  }
  return Array.from(bankSet);
}

app.put('/api/super/merchants/:id/payment-methods', requireSuperAdmin, async (req, res) => {
  try {
    const mid = parseInt(req.params.id, 10);
    const src = (req.body && req.body.methods) || {};
    const clean = {};
    // 内置 4 种
    const builtin = ['cash', 'wechat', 'alipay', 'card'];
    builtin.forEach(k => { clean[k] = src[k] !== false; });
    // 动态 bank 键（与当前商户可用的 bank 列表取交集，防止脏数据）
    const banks = await getMerchantBanks(mid);
    banks.forEach(b => { clean[b] = src[b] !== false; });
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      [`merchant_${mid}_payment_methods`, JSON.stringify(clean)]
    );
    try {
      await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username,
        'update_payment_methods', 'merchant', mid, JSON.stringify(clean), getClientIp(req));
    } catch (_) {}
    res.json({ success: true, methods: clean });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新增：返回该商户所有可用的支付方式（内置 + 动态 bank）
app.get('/api/super/merchants/:id/available-methods', requireSuperAdmin, async (req, res) => {
  try {
    const mid = parseInt(req.params.id, 10);
    const builtin = [
      { key: 'cash',   label: '现金',       icon: '💵' },
      { key: 'wechat', label: '微信支付',   icon: '💚' },
      { key: 'alipay', label: '支付宝',     icon: '💙' },
      { key: 'card',   label: '刷卡',       icon: '💳' },
    ];
    const banks = await getMerchantBanks(mid);
    const bankMethods = banks.map(b => ({
      key: b,
      label: b.toUpperCase(),
      icon: '',
      isBank: true,
    }));
    res.json({ builtin, banks: bankMethods });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

};
