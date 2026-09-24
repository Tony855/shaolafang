const { requireSuperAdmin } = require('./server/middleware/auth.js');
const { requireCashier } = require('./server/middleware/auth.js');
const express = require('express');
const { AsyncLocalStorage } = require('async_hooks');

// 全球通用日期时间格式 YYYY-MM-DD HH:mm:ss
function formatGlobalDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatGlobalTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const net = require('net');
let redis = null;
try { redis = require('redis'); } catch(e) { /* redis可选 */ }
const os = require('os');

// ---------- 统一配置加载（.env） ----------
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

const app = express();
app.set('trust proxy', true);

// Socket.io
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = Number(process.env.PORT || 3000);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const RUN_SCHEDULED_TASKS = process.env.RUN_SCHEDULED_TASKS === 'true';
const REDIS_URL = process.env.REDIS_URL || null;

// ===== Redis 缓存层 =====
let redisClient = null;
let redisReady = false;
async function initRedis() {
  if (!redis || !REDIS_URL) return false;
  try {
    redisClient = redis.createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis连接错误:', err.message));
    await redisClient.connect();
    redisReady = true;
    console.log('✅ Redis缓存已连接');
    return true;
  } catch(e) {
    console.log('ℹ️ Redis未启用，使用内存缓存（单服务器模式）');
    redisReady = false;
    return false;
  }
}
const memoryCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of memoryCache) {
    if (item && item.expireAt && item.expireAt < now) memoryCache.delete(key);
  }
}, 60000);
const origMemorySet = memoryCache.set.bind(memoryCache);
memoryCache.set = function(key, value, ttlSeconds) {
  const item = ttlSeconds ? { value, expireAt: Date.now() + ttlSeconds * 1000 } : { value };
  return origMemorySet(key, item);
};
const origMemoryGet = memoryCache.get.bind(memoryCache);
memoryCache.get = function(key) {
  const item = origMemoryGet(key);
  return item ? item.value : undefined;
};
const cache = {
  async get(key) {
    if (redisReady) {
      const val = await redisClient.get(key);
      return val ? JSON.parse(val) : null;
    }
    return memoryCache.get(key) || null;
  },
  async set(key, value, ttlSeconds) {
    if (redisReady) {
      if (ttlSeconds > 0) await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
      else await redisClient.set(key, JSON.stringify(value));
    } else {
      memoryCache.set(key, value, ttlSeconds);
    }
  },
  async del(key) {
    if (redisReady) await redisClient.del(key);
    else memoryCache.delete(key);
  }
};
async function checkAndSetCooldown(key, cooldownMs) {
  const last = await cache.get('cooldown:' + key);
  const now = Date.now();
  if (last && (now - last) < cooldownMs) return false;
  await cache.set('cooldown:' + key, now, Math.ceil(cooldownMs / 1000) + 1);
  return true;
}

// ---------- 获取真实客户端IP ----------
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (ips.length > 0) return ips[0];
  }
  const xri = req.headers['x-real-ip'];
  if (xri) return xri.trim();
  return req.ip || req.connection.remoteAddress || 'unknown';
}

// ---------- IP地理位置查询 ----------
const ipLocationCache = new Map();
async function getLocationByIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'unknown') return '本地/内网';
  if (ipLocationCache.has(ip)) return ipLocationCache.get(ip);
  try {
    const http = require('http');
    const url = 'http://ip-api.com/json/' + ip + '?lang=zh-CN&fields=status,country,regionName,city';
    const result = await new Promise((resolve, reject) => {
      http.get(url, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    });
    if (result.status === 'success') {
      const location = (result.country || '') + ' ' + (result.regionName || '') + ' ' + (result.city || '');
      const trimmed = location.trim() || '未知';
      ipLocationCache.set(ip, trimmed);
      return trimmed;
    }
    return '未知';
  } catch (e) { return '未知'; }
}

// ---------- 中间件 ----------
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));
app.use('/pages', express.static(path.join(__dirname, 'pages'), { dotfiles: 'deny', index: false }));
app.use('/uploads', express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false }));

app.get('/languages.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'languages.js'));
});
app.get('/languages.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'languages.min.js'));
});

// i18n 按需加载
const i18nCache = {};
app.get('/api/i18n/:lang', (req, res) => {
  const lang = req.params.lang;
  const validLangs = ['zh', 'en', 'vi', 'th', 'km'];
  if (!validLangs.includes(lang)) {
    return res.status(400).json({ error: 'Unsupported language' });
  }
  if (i18nCache[lang]) return res.json(i18nCache[lang]);
  try {
    const langContent = fs.readFileSync(path.join(__dirname, 'languages.js'), 'utf-8');
    const sandbox = { module: {}, exports: {} };
    const vm = require('vm');
    const context = vm.createContext(sandbox);
    vm.runInContext(langContent + '; this._result = LANGUAGES["' + lang + '"];', context);
    const dict = sandbox._result || {};
    i18nCache[lang] = dict;
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(dict);
  } catch (e) {
    console.error('i18n load error:', e.message);
    res.status(500).json({ error: 'Failed to load language' });
  }
});

// 页面路由
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/login', '/manage'], (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get(['/index', '/home', '/order'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/waiter', (req, res) => res.sendFile(path.join(__dirname, 'waiter.html')));
app.get('/kitchen', (req, res) => res.sendFile(path.join(__dirname, 'kitchen.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/super', (req, res) => res.sendFile(path.join(__dirname, 'super.html')));
app.get('/cashier', (req, res) => res.sendFile(path.join(__dirname, 'cashier.html')));

app.get('/login.html', (req, res) => res.redirect('/login'));
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.get('/kitchen.html', (req, res) => res.redirect('/kitchen'));
app.get('/super.html', (req, res) => res.redirect('/super'));
app.get('/waiter.html', (req, res) => res.redirect('/waiter'));
app.get('/index.html', (req, res) => res.redirect('/'));

// 二维码打印
app.get('/qr-print', async (req, res) => {
  try {
    const tableId = parseInt(req.query.tableId || '0', 10);
    const lang = ['zh', 'en', 'vi', 'th', 'km'].includes(req.query.lang) ? req.query.lang : 'zh';
    if (!tableId) return res.status(400).send('Invalid tableId');
    const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ?', [tableId]);
    if (!table) return res.status(404).send('Table not found');
    const store = await getAsync('SELECT name, qr_languages FROM stores WHERE id = ?', [table.store_id || 1]);
    const storeName = store?.name || 'FoodFlow';
    let displayLangs = ['zh'];
    if (store?.qr_languages) {
      const configured = store.qr_languages.split(',').map(s => s.trim()).filter(s => ['zh','en','vi','th','km'].includes(s));
      if (configured.length > 0) displayLangs = configured;
    }
    const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    const i18nMap = {
      zh: { table: '桌号', qrCode: '二维码', scanToOrder: '扫码点餐', download: '下载', print: '打印', orderingQrCode: '点餐二维码', copy: '复制', copied: '已复制', copyLink: '复制链接', copyFailed: '复制失败，请手动复制' },
      en: { table: 'Table', qrCode: 'QR Code', scanToOrder: 'Scan to Order', download: 'Download', print: 'Print', orderingQrCode: 'Ordering QR Code', copy: 'Copy', copied: 'Copied', copyLink: 'Copy Link', copyFailed: 'Copy failed, please copy manually' },
      vi: { table: 'Bàn', qrCode: 'Mã QR', scanToOrder: 'Quét mã để đặt hàng', download: 'Tải xuống', print: 'In', orderingQrCode: 'Mã QR đặt hàng', copy: 'Sao chép', copied: 'Đã sao chép', copyLink: 'Sao chép liên kết', copyFailed: 'Sao chép thất bại' },
      th: { table: 'โต๊ะ', qrCode: 'คิวอาร์โค้ด', scanToOrder: 'สแกนเพื่อสั่งอาหาร', download: 'ดาวน์โหลด', print: 'พิมพ์', orderingQrCode: 'คิวอาร์โค้ดสั่งอาหาร', copy: 'คัดลอก', copied: 'คัดลอกแล้ว', copyLink: 'คัดลอกลิงก์', copyFailed: 'คัดลอกล้มเหลว' },
      km: { table: 'តុ', qrCode: 'QR Code', scanToOrder: 'ស្កេនដើម្បីបញ្ជាទិញ', download: 'ទាញយក', print: 'បោះពុម្ព', orderingQrCode: 'កូដ QR បញ្ជាទិញ', copy: 'ចម្លង', copied: 'បានចម្លង', copyLink: 'ចម្លងតំណ', copyFailed: 'ការចម្លងបរាជ័យ' }
    };
    const t = i18nMap[lang] || i18nMap.zh;
    const templatePath = path.join(__dirname, 'views', 'qr-print.html');
    if (!fs.existsSync(templatePath)) return res.status(500).send('QR template missing');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template
      .replace(/{{lang}}/g, lang)
      .replace(/{{table}}/g, table.name)
      .replace(/{{storeName}}/g, storeName)
      .replace(/{{qrCode}}/g, t.qrCode)
      .replace(/{{tableLabel}}/g, t.table)
      .replace(/{{orderingQrCode}}/g, t.orderingQrCode)
      .replace(/{{scanToOrder}}/g, displayLangs.map(l => (i18nMap[l] || i18nMap.zh).scanToOrder).join('\n'))
      .replace(/{{scanToOrderLines}}/g, displayLangs.map(l => '<div class="scan-line">' + (i18nMap[l] || i18nMap.zh).scanToOrder + '</div>').join(''))
      .replace(/{{download}}/g, t.download)
      .replace(/{{print}}/g, t.print)
      .replace(/{{copy}}/g, t.copy)
      .replace(/{{copied}}/g, t.copied)
      .replace(/{{copyLink}}/g, t.copyLink)
      .replace(/{{copyFailed}}/g, t.copyFailed)
      .replace(/{{url}}/g, url)
      .replace(/{{qrDataUrl}}/g, qrDataUrl)
      .replace(/{{storeNameJson}}/g, JSON.stringify(storeName))
      .replace(/{{tableJson}}/g, JSON.stringify(table.name))
      .replace(/{{tableLabelJson}}/g, JSON.stringify(t.table))
      .replace(/{{scanToOrderJson}}/g, JSON.stringify(displayLangs.map(l => (i18nMap[l] || i18nMap.zh).scanToOrder)))
      .replace(/{{qrCodeJson}}/g, JSON.stringify(t.qrCode))
      .replace(/{{qrDataUrlJson}}/g, JSON.stringify(qrDataUrl));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('QR print error:', e);
    res.status(500).send('Failed to generate QR print page');
  }
});

// ---------- 文件上传 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeType = allowedTypes.test(file.mimetype);
    if (extName && mimeType) return cb(null, true);
    cb(new Error('只允许上传图片文件（JPG/PNG/GIF/WEBP）'));
  }
});

// ---------- MySQL 连接池 ----------
const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'ordering_system',
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
};

let pool = mysql.createPool(poolConfig);

// ---------- 数据库辅助函数 ----------
const transactionStorage = new AsyncLocalStorage();

async function runAsync(sql, params) {
  const db = transactionStorage.getStore() || pool;
  const [result] = await db.execute(sql, params);
  return { lastID: result.insertId, changes: result.affectedRows };
}

async function getAsync(sql, params) {
  const db = transactionStorage.getStore() || pool;
  const [rows] = await db.execute(sql, params);
  return rows[0] || null;
}

async function allAsync(sql, params) {
  const db = transactionStorage.getStore() || pool;
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function withTransaction(work) {
  const conn = await pool.getConnection();
  await conn.query('START TRANSACTION');
  try {
    const result = await transactionStorage.run(conn, work);
    await conn.query('COMMIT');
    return result;
  } catch (e) {
    await conn.query('ROLLBACK');
    throw e;
  } finally {
    conn.release();
  }
}

// ---------- 常量 ----------
async function getOrderCooldownMs() {
  try {
    const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'order_interval_seconds'");
    const seconds = parseInt(setting?.value || '30', 10);
    return Math.max(0, Math.min(3600, seconds)) * 1000;
  } catch (e) {
    return 30 * 1000;
  }
}

const createTableToken = () => crypto.randomBytes(12).toString('base64url');

function hashPassword(pwd) {
  return bcrypt.hashSync(pwd, 10);
}

function verifyPassword(pwd, hash) {
  if (!hash) return false;
  if (hash.startsWith('$2')) {
    return bcrypt.compareSync(pwd, hash);
  }
  return crypto.createHash('sha256').update(pwd).digest('hex') === hash;
}

// ---------- 登录限流器 ----------
const loginAttempts = new Map();

function getLoginAttempts(username, type) {
  const key = `${username}|${type}`;
  if (!loginAttempts.has(key)) {
    loginAttempts.set(key, { count: 0, lockUntil: 0, firstAttempt: 0 });
  }
  return loginAttempts.get(key);
}

function recordLoginAttempt(username, type) {
  const attempt = getLoginAttempts(username, type);
  attempt.count += 1;
  if (attempt.firstAttempt === 0) attempt.firstAttempt = Date.now();
  loginAttempts.set(`${username}|${type}`, attempt);
}

function resetLoginAttempts(username, type) {
  loginAttempts.delete(`${username}|${type}`);
}

async function isLoginLocked(username, type) {
  const settings = await getAsync("SELECT value FROM settings WHERE `key` = 'login_max_attempts'");
  const lockSettings = await getAsync("SELECT value FROM settings WHERE `key` = 'login_lock_minutes'");
  const maxAttempts = parseInt(settings?.value || '5', 10);
  const lockMinutes = parseInt(lockSettings?.value || '15', 10);
  const attempt = getLoginAttempts(username, type);
  if (attempt.lockUntil > Date.now()) {
    const remaining = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
    return { locked: true, remaining, maxAttempts, lockMinutes };
  }
  if (attempt.count >= maxAttempts) {
    attempt.lockUntil = Date.now() + lockMinutes * 60 * 1000;
    loginAttempts.set(`${username}|${type}`, attempt);
    return { locked: true, remaining: lockMinutes, maxAttempts, lockMinutes };
  }
  return { locked: false, maxAttempts, lockMinutes };
}

// ============================================================
//  默认凭据集中定义 + 首次初始化凭据文件
// ============================================================
const DEFAULT_CREDENTIALS = {
  superAdmin: {
    username:    process.env.INIT_SUPER_USERNAME   || 'superadmin',
    password:    process.env.INIT_SUPER_PASSWORD   || 'super123',
    displayName: '超级管理员',
  },
  merchantAdmin: {
    username:    process.env.INIT_ADMIN_USERNAME   || 'admin',
    password:    process.env.INIT_ADMIN_PASSWORD   || 'admin123',
    displayName: 'FoodFlow管理员',
  },
  waiter: {
    username:    process.env.INIT_WAITER_USERNAME  || 'waiter',
    password:    process.env.INIT_WAITER_PASSWORD  || '123456',
    displayName: '服务员A',
  },
  cashier: {
    username:    process.env.INIT_CASHIER_USERNAME || 'cashier',
    password:    process.env.INIT_CASHIER_PASSWORD || '123456',
    displayName: '收银员',
  },
};

async function writeInitialCredentialsFile(credentials) {
  const file = process.env.INIT_CRED_FILE || '/etc/foodflow/initial-credentials.txt';
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const content = Object.entries(credentials)
      .map(([k, v]) => `${k}: ${v.username} / ${v.password}`)
      .join('\n') + '\n';
    await fs.promises.writeFile(file, content, { mode: 0o600 });
    console.log(`  + 初始凭据已写入 ${file}（权限 600）`);
  } catch (e) {
    console.warn(`  ! 无法写入凭据文件 ${file}: ${e.message}（不影响服务启动）`);
  }
}

// ============================================================
//  订单号分配（并发安全，依赖调用者在事务上下文中）
// ============================================================
async function allocateOrderNo(todayPrefix) {
  const now = new Date().toISOString();
  await runAsync(
    'INSERT INTO order_sequences (prefix, current_value, updated_at) VALUES (?, 0, ?) ' +
    'ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)',
    [todayPrefix, now]
  );
  const row = await getAsync(
    'SELECT current_value FROM order_sequences WHERE prefix = ? FOR UPDATE',
    [todayPrefix]
  );
  const next = (row?.current_value || 0) + 1;
  await runAsync(
    'UPDATE order_sequences SET current_value = ?, updated_at = ? WHERE prefix = ?',
    [next, now, todayPrefix]
  );
  return todayPrefix + String(next).padStart(5, '0');
}

// ---------- 数据库初始化 ----------
async function ensureOrderTables() {
  const missingTables = await allAsync(`
    SELECT DISTINCT o.table_name AS name
    FROM orders o
    LEFT JOIN tables t ON t.name = o.table_name
    WHERE t.id IS NULL
  `);
  for (const table of missingTables) {
    await runAsync('INSERT INTO tables (name, status) VALUES (?, ?)', [table.name, 'available']);
  }
}

async function rebaseCurrencyToUSDOnce() {
  const migrated = await getAsync("SELECT value FROM settings WHERE `key` = 'currency_base_usd_v1'");
  if (migrated) return;

  const usd = await getAsync("SELECT rate FROM currencies WHERE code = 'USD'");
  const oldUsdRate = usd ? Number(usd.rate) : 0;
  if (!(oldUsdRate > 0)) {
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES ('currency_base_usd_v1', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [new Date().toISOString()]
    );
    return;
  }

  const factor = 1 / oldUsdRate;
  await withTransaction(async () => {
    const currencies = await allAsync('SELECT code, rate FROM currencies');
    for (const currency of currencies) {
      await runAsync('UPDATE currencies SET rate=? WHERE code=?', [Number(currency.rate) * factor, currency.code]);
    }
    await runAsync('UPDATE currencies SET is_default=0');
    await runAsync("UPDATE currencies SET is_default=1 WHERE code='USD'");
    const orders = await allAsync('SELECT id, items, total FROM orders');
    for (const order of orders) {
      let items;
      try { items = JSON.parse(order.items || '[]'); } catch (_) { items = []; }
      for (const item of items) {
        if (typeof item.base_price === 'number') item.base_price = Number(item.base_price) * oldUsdRate;
      }
      await runAsync(
        'UPDATE orders SET items=?, total=? WHERE id=?',
        [JSON.stringify(items), Number(order.total) * oldUsdRate, order.id]
      );
    }
    await runAsync(
      "INSERT INTO settings (`key`, value) VALUES ('currency_base_usd_v1', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [new Date().toISOString()]
    );
  });
}

async function syncTableStatus(tableName, storeId) {
  const table = await getAsync('SELECT id, status FROM tables WHERE name=? AND store_id=?', [tableName, storeId || 1]);
  if (!table) return;
  const active = await getAsync("SELECT COUNT(*) AS count FROM orders WHERE table_name=? AND store_id=? AND status=\"pending\"", [tableName, storeId || 1]);
  if (active.count > 0) {
    if (table.status !== 'occupied') {
      await runAsync('UPDATE tables SET status=? WHERE id=?', ['occupied', table.id]);
    }
  } else if (table.status === 'occupied') {
    await runAsync('UPDATE tables SET status=? WHERE id=?', ['available', table.id]);
  }
}

async function initDatabase() {
  try {
    await pool.getConnection();
  } catch (err) {
    if (err.code === 'ER_BAD_DB_ERROR') {
      const tempPool = mysql.createPool({
        host: poolConfig.host,
        user: poolConfig.user,
        password: poolConfig.password,
        port: poolConfig.port,
        waitForConnections: true,
        connectionLimit: 1,
        charset: 'utf8mb4',
      });
      const conn = await tempPool.getConnection();
      await conn.query(`CREATE DATABASE IF NOT EXISTS \`${poolConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      conn.release();
      await tempPool.end();
      pool = mysql.createPool(poolConfig);
    } else {
      throw err;
    }
  }

  // 基础表结构
  await runAsync(`
    CREATE TABLE IF NOT EXISTS menus (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      emoji VARCHAR(50),
      price DECIMAL(10,2) NOT NULL,
      category VARCHAR(255),
      \`desc\` TEXT,
      image VARCHAR(255),
      currency_code VARCHAR(10) NOT NULL DEFAULT 'USD',
      name_en VARCHAR(255),
      desc_en TEXT,
      active TINYINT NOT NULL DEFAULT 1,
      unit VARCHAR(50) NOT NULL DEFAULT '份',
      show_dual TINYINT NOT NULL DEFAULT 0,
      secondary_currency_code VARCHAR(10),
      store_id INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const menusColumns = await allAsync('SHOW COLUMNS FROM menus');
  const menusColNames = menusColumns.map(c => c.Field);
  if (!menusColNames.includes('sales_count')) {
    await runAsync('ALTER TABLE menus ADD COLUMN sales_count INT NOT NULL DEFAULT 0');
  }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS currencies (
      id INT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL DEFAULT 1,
      code VARCHAR(10) NOT NULL,
      symbol VARCHAR(10) NOT NULL,
      name VARCHAR(255) NOT NULL,
      rate DECIMAL(10,4) NOT NULL DEFAULT 1,
      is_default TINYINT NOT NULL DEFAULT 0,
      UNIQUE KEY unique_merchant_code (merchant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS menu_categories (
      id INT PRIMARY KEY AUTO_INCREMENT,
      store_id INT NOT NULL DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      UNIQUE KEY unique_store_name (store_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      createdAt VARCHAR(50) NOT NULL,
      success TINYINT NOT NULL DEFAULT 0,
      ip VARCHAR(50),
      message TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const loginLogsColumns = await allAsync('SHOW COLUMNS FROM login_logs');
  const loginLogsColNames = loginLogsColumns.map(c => c.Field);
  if (!loginLogsColNames.includes('username')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN username VARCHAR(100) DEFAULT NULL');
  }
  if (!loginLogsColNames.includes('location')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN location VARCHAR(255) DEFAULT NULL');
  }
  if (!loginLogsColNames.includes('merchant_id')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN merchant_id INT DEFAULT NULL');
  }
  if (!loginLogsColNames.includes('login_type')) {
    await runAsync('ALTER TABLE login_logs ADD COLUMN login_type VARCHAR(50) DEFAULT NULL');
  }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      admin_id INT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      ip VARCHAR(50),
      user_agent TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS super_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      super_admin_id INT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      ip VARCHAR(50),
      user_agent TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      actor_type VARCHAR(50) NOT NULL,
      actor_id INT,
      actor_username VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id INT,
      details TEXT,
      ip VARCHAR(50),
      created_at VARCHAR(50) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS scan_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_name VARCHAR(50) NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      store_id INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS waiters (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      can_order TINYINT NOT NULL DEFAULT 1,
      can_mark_item TINYINT NOT NULL DEFAULT 1,
      can_complete_order TINYINT NOT NULL DEFAULT 1,
      active TINYINT NOT NULL DEFAULT 1,
      store_id INT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS waiter_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      waiter_id INT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS cashier_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      cashier_id BIGINT NOT NULL,
      store_id INT NOT NULL DEFAULT 1,
      merchant_id INT NOT NULL DEFAULT 1,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      INDEX idx_token (token),
      INDEX idx_cashier (cashier_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS stores (
      id INT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(50) UNIQUE,
      address TEXT,
      active TINYINT NOT NULL DEFAULT 1,
      INDEX idx_merchant (merchant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS tables (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'available',
      qr_token VARCHAR(255),
      store_id INT NOT NULL DEFAULT 1,
      UNIQUE KEY unique_store_table (store_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_name VARCHAR(50) NOT NULL,
      items LONGTEXT NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      createdAt VARCHAR(50) NOT NULL,
      session_token VARCHAR(255),
      store_id INT NOT NULL DEFAULT 1,
      note VARCHAR(200) DEFAULT '',
      customer_token VARCHAR(255) DEFAULT ''
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try {
    await runAsync("ALTER TABLE orders ADD COLUMN note VARCHAR(200) DEFAULT ''");
  } catch (e) {
    if (!/duplicate column/i.test(e.message || '')) throw e;
  }
  try {
    await runAsync('ALTER TABLE orders ADD COLUMN order_no VARCHAR(20) DEFAULT NULL');
    await runAsync('ALTER TABLE orders ADD UNIQUE INDEX idx_order_no (order_no)');
  } catch (e) {
    if (!/duplicate column|Duplicate key/i.test(e.message || '')) throw e;
  }
  try {
    await runAsync(`ALTER TABLE orders ADD COLUMN customer_token VARCHAR(255) DEFAULT ''`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message || '')) console.log('  ! customer_token:', e.message);
  }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ====== 订单号序号表（新增，PR #2） ======
  await runAsync(`
    CREATE TABLE IF NOT EXISTS order_sequences (
      prefix VARCHAR(32) NOT NULL PRIMARY KEY,
      current_value INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at VARCHAR(50) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS waiter_calls (
      id VARCHAR(32) PRIMARY KEY,
      table_name VARCHAR(50) NOT NULL,
      store_id INT NOT NULL DEFAULT 1,
      session_token VARCHAR(255),
      type VARCHAR(20) DEFAULT 'call',
      message VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',
      handled_by VARCHAR(100),
      handled_at VARCHAR(50),
      created_at VARCHAR(50) NOT NULL,
      INDEX idx_store_status (store_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try { await runAsync('ALTER TABLE waiter_calls ADD COLUMN type VARCHAR(20) DEFAULT "call"'); } catch (e) { /* 已存在 */ }
  try { await runAsync('ALTER TABLE waiter_calls ADD COLUMN message VARCHAR(255)'); } catch (e) { /* 已存在 */ }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS reservations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_name VARCHAR(50) NOT NULL,
      store_id INT NOT NULL DEFAULT 1,
      customer_name VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      reservation_time VARCHAR(50) NOT NULL,
      guests INT DEFAULT 1,
      status VARCHAR(20) DEFAULT 'pending',
      created_at VARCHAR(50) NOT NULL,
      INDEX idx_store_time (store_id, reservation_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS printers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(20) DEFAULT 'network',
      ip_address VARCHAR(50),
      port INT DEFAULT 9100,
      paper_width INT DEFAULT 58,
      brand VARCHAR(50) DEFAULT 'generic',
      is_default TINYINT DEFAULT 0,
      active TINYINT DEFAULT 1,
      store_id INT NOT NULL DEFAULT 1,
      INDEX idx_store (store_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS merchants (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(50) UNIQUE NOT NULL,
      contact_name VARCHAR(100),
      contact_phone VARCHAR(50),
      max_stores INT NOT NULL DEFAULT 1,
      status TINYINT NOT NULL DEFAULT 1,
      expire_date DATE,
      settings JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS merchant_admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_merchant (merchant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 添加 merchant_id 字段（兼容旧表）
  const tablesToAlter = ['stores', 'menus', 'tables', 'orders', 'waiters', 'printers', 'waiter_calls', 'reservations', 'scan_sessions', 'currencies', 'menu_categories'];
  for (const tbl of tablesToAlter) {
    try {
      await runAsync(`ALTER TABLE ${tbl} ADD COLUMN merchant_id INT NOT NULL DEFAULT 1`);
    } catch (e) {
      if (!/duplicate column/i.test(e.message || '')) console.log(`  ! ${tbl}: ${e.message}`);
    }
  }

  // 商户管理员权限字段
  const adminPermFields = ['can_manage_menu', 'can_manage_table', 'can_manage_order', 'can_delete_order', 'can_edit_order', 'can_manage_store', 'can_manage_waiter', 'can_manage_currency', 'can_manage_printer', 'can_manage_admin', 'can_view_logs', 'can_manage_cashier'];
  for (const field of adminPermFields) {
    try {
      await runAsync(`ALTER TABLE merchant_admins ADD COLUMN ${field} TINYINT NOT NULL DEFAULT 1`);
    } catch (e) {
      if (!/duplicate column/i.test(e.message || '')) console.log(`  ! merchant_admins.${field}: ${e.message}`);
    }
  }

  // ===== 初始化基础数据 =====
  const initialCredentials = {};

  // 超级管理员
  const superAdminCount = await getAsync('SELECT COUNT(*) AS count FROM super_admins');
  if (superAdminCount.count === 0) {
    const c = DEFAULT_CREDENTIALS.superAdmin;
    const superHash = hashPassword(c.password);
    await runAsync(
      "INSERT INTO super_admins (username, password_hash, display_name) VALUES (?, ?, ?)",
      [c.username, superHash, c.displayName]
    );
    console.log(`  + 已创建超级管理员：${c.username} / ${c.password}`);
    initialCredentials.superAdmin = c;
  }

  // 默认商户
  const merchantCount = await getAsync('SELECT COUNT(*) AS count FROM merchants');
  if (merchantCount.count === 0) {
    const defaultMerchantCode = 'FF0001';
    await runAsync("INSERT INTO merchants (name, code, contact_name, contact_phone, max_stores, status) VALUES (?, ?, ?, ?, ?, 1)",
      ['FoodFlow', defaultMerchantCode, '管理员', '', 5]);
    const defaultMerchantId = (await getAsync('SELECT id FROM merchants WHERE code=?', [defaultMerchantCode])).id;
    console.log('  + 已创建默认商户：FoodFlow (id=' + defaultMerchantId + ')');

    // 商户管理员
    const ac = DEFAULT_CREDENTIALS.merchantAdmin;
    const adminHash = hashPassword(ac.password);
    await runAsync(
      "INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name) VALUES (?, ?, ?, ?)",
      [defaultMerchantId, ac.username, adminHash, ac.displayName]
    );
    console.log(`  + 已创建商户管理员：${ac.username} / ${ac.password}`);
    initialCredentials.merchantAdmin = ac;

    // 默认店铺
    await runAsync("INSERT INTO stores (merchant_id, name, code, address, active) VALUES (?, ?, ?, ?, 1)",
      [defaultMerchantId, 'FoodFlow总店', 'ff-main', '']);
    const defaultStoreId = (await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [defaultMerchantId])).id;
    console.log('  + 已创建默认店铺：FoodFlow总店 (id=' + defaultStoreId + ')');

    // 默认货币
    for (const currency of [
      ['USD', '$', '美元', 1, 1], ['CNY', '¥', '人民币', 7, 0], ['VND', '₫', '越南盾', 25000, 0],
      ['THB', '฿', '泰铢', 32, 0], ['KHR', '៛', '柬埔寨瑞尔', 4000, 0]
    ]) {
      await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)',
        [defaultMerchantId, ...currency]);
    }
    console.log('  + 已创建默认货币：USD/CNY/VND/THB/KHR');

    // 默认分类
    const categories = [['热销', 0], ['主食', 1], ['小吃', 2], ['饮料', 3], ['甜点', 4]];
    for (const [catName, sort] of categories) {
      await runAsync('INSERT INTO menu_categories (name, sort, store_id) VALUES (?, ?, ?)', [catName, sort, defaultStoreId]);
    }
    console.log('  + 已创建默认菜品分类：热销/主食/小吃/饮料/甜点');

    // 默认菜品
    const defaultMenus = [
      ['招牌烧腊饭', '🍱', 8.5, '热销', '招牌烧腊配米饭', '份'],
      ['蜜汁叉烧饭', '🍖', 9.0, '热销', '蜜汁叉烧配米饭', '份'],
      ['白切鸡饭', '🍗', 7.5, '主食', '白切鸡配米饭', '份'],
      ['排骨饭', '🍖', 8.0, '主食', '红烧排骨配米饭', '份'],
      ['春卷', '🥟', 3.5, '小吃', '酥脆春卷', '份'],
      ['炸鸡翅', '🍗', 4.0, '小吃', '香酥炸鸡翅', '份'],
      ['柠檬茶', '🍋', 2.5, '饮料', '冰镇柠檬茶', '杯'],
      ['咖啡', '☕', 3.0, '饮料', '现磨咖啡', '杯'],
      ['芒果布丁', '🍮', 3.5, '甜点', '新鲜芒果布丁', '份'],
      ['双皮奶', '🥛', 3.0, '甜点', '传统双皮奶', '份']
    ];
    for (const [name, emoji, price, category, desc, unit] of defaultMenus) {
      await runAsync('INSERT INTO menus (name, emoji, price, category, `desc`, unit, active, store_id, currency_code) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
        [name, emoji, price, category, desc, unit, defaultStoreId, 'USD']);
    }
    console.log('  + 已创建默认菜品：10道示例菜品');

    // 默认桌号
    const defaultTables = ['A01', 'A02', 'A03', 'A04', 'A05', 'B01', 'B02', 'B03', 'B04', 'B05'];
    for (const tableName of defaultTables) {
      await runAsync('INSERT INTO tables (name, status, store_id) VALUES (?, ?, ?)', [tableName, 'available', defaultStoreId]);
    }
    console.log('  + 已创建默认桌号：A01-A05, B01-B05');

    // 默认服务员
    const wc = DEFAULT_CREDENTIALS.waiter;
    const waiterHash = hashPassword(wc.password);
    await runAsync(
      'INSERT INTO waiters (username, password_hash, display_name, can_order, can_mark_item, can_complete_order, active, store_id) VALUES (?, ?, ?, 1, 1, 1, 1, ?)',
      [wc.username, waiterHash, wc.displayName, defaultStoreId]
    );
    console.log(`  + 已创建默认服务员：${wc.username} / ${wc.password}`);
    initialCredentials.waiter = wc;

    // 说明：默认收银员不再预置。
    // cashier_sessions 只存登录 session，收银员账号本身存在 settings 表的
    // cashiers_<storeId> JSON 中，由管理员在后台「收银员管理」添加。
  }

  // 迁移：qr_languages
  try {
    const cols = await pool.query('SHOW COLUMNS FROM stores LIKE ?', ['qr_languages']);
    if (!cols[0] || cols[0].length === 0) {
      await runAsync('ALTER TABLE stores ADD COLUMN qr_languages VARCHAR(50) DEFAULT NULL');
      console.log('  + 迁移 stores: 添加 qr_languages 字段');
    }
  } catch (e) { console.log('  stores qr_languages 迁移跳过:', e.message); }

  // 全局设置默认值
  const backupInterval = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
  if (!backupInterval) await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_interval_hours', '24')");
  const dualCurrency = await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
  if (!dualCurrency) await runAsync("INSERT INTO settings (`key`, value) VALUES ('dual_currency_enabled', '1')");
  const secondaryCurrency = await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
  if (!secondaryCurrency) await runAsync("INSERT INTO settings (`key`, value) VALUES ('secondary_currency_code', 'KHR')");
  else if (secondaryCurrency.value === 'CNY') await runAsync("UPDATE settings SET value='USD' WHERE `key`='secondary_currency_code'");
  const newOrderSound = await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
  if (!newOrderSound) await runAsync("INSERT INTO settings (`key`, value) VALUES ('new_order_sound_enabled', '1')");
  const adminPassword = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_password'");
  if (!adminPassword) await runAsync("INSERT INTO settings (`key`, value) VALUES ('admin_password', ?)", [hashPassword('admin123')]);

  const prefixDefaults = {
    'order_prefix_normal': '11',
    'order_prefix_refund': '01',
    'order_prefix_discount': '21',
    'order_prefix_vip': '61',
    'kitchen_auto_hide_minutes': '30',
    'qr_session_timeout': '45',
    'order_interval_seconds': '8',
    'waiter_refresh_interval': '5',
    'login_max_attempts': '5',
    'login_lock_minutes': '5',
    'call_limit_enabled': '1',
    'call_limit_max': '3',
    'call_limit_window_minutes': '10',
    'call_limit_cooldown_minutes': '5',
    'log_retention_days': '90',
    'auto_clean_log_enabled': '1',
    'max_order_items': '50',
    'max_item_quantity': '100',
    'max_order_note_length': '200'
  };
  for (const [key, value] of Object.entries(prefixDefaults)) {
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=value", [key, value]);
  }
  console.log('  + System settings defaults initialized');

  await runAsync("INSERT INTO settings (`key`, value) VALUES ('dual_currency_enabled', '1') ON DUPLICATE KEY UPDATE value='1'");
  await runAsync("INSERT INTO settings (`key`, value) VALUES ('secondary_currency_code', 'KHR') ON DUPLICATE KEY UPDATE value='KHR'");

  await rebaseCurrencyToUSDOnce();
  await ensureOrderTables();
  const tablesWithoutTokens = await allAsync("SELECT id FROM tables WHERE qr_token IS NULL OR qr_token = ''");
  for (const table of tablesWithoutTokens) await runAsync('UPDATE tables SET qr_token=? WHERE id=?', [createTableToken(), table.id]);
  const allTables = await allAsync('SELECT name, store_id FROM tables');
  for (const t of allTables) await syncTableStatus(t.name, t.store_id);

  // 写入初始凭据文件
  if (Object.keys(initialCredentials).length > 0) {
    await writeInitialCredentialsFile(initialCredentials);
  }

  await runAsync("INSERT INTO settings (`key`, value) VALUES ('db_migration_completed', '1') ON DUPLICATE KEY UPDATE value='1'");
  console.log('  ✓ 数据库迁移完成');
}

// ---------- ESC/POS 打印工具 ----------
class EscPosBuilder {
  constructor(paperWidth) {
    this.width = paperWidth || 58;
    this.charsPerLine = this.width === 80 ? 48 : 32;
    this.buffer = Buffer.alloc(0);
  }
  _append(bytes) { this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]); return this; }
  init() { return this._append([0x1b, 0x40]); }
  align(n) { return this._append([0x1b, 0x61, n]); }
  font(n) { return this._append([0x1b, 0x4d, n]); }
  bold(on) { return this._append([0x1b, 0x45, on ? 1 : 0]); }
  doubleHeight(on) { return this._append([0x1b, 0x21, on ? 0x10 : 0x00]); }
  doubleWidth(on) { return this._append([0x1b, 0x21, on ? 0x20 : 0x00]); }
  big(on) { return this._append([0x1b, 0x21, on ? 0x30 : 0x00]); }
  underline(on) { return this._append([0x1b, 0x2d, on ? 1 : 0]); }
  text(str) { return this._append(Buffer.from(str, 'utf8')); }
  line(str) { return this.text(str || '').newline(); }
  newline(n = 1) { for (let i = 0; i < n; i++) this._append([0x0a]); return this; }
  feed(n = 3) { return this._append([0x1b, 0x4a, n]); }
  cut(mode = 1) { this.feed(3); return this._append([0x1d, 0x56, mode ? 1 : 0]); }
  separator(char = '-') { return this.line(char.repeat(this.charsPerLine)); }
  twoColumn(left, right) {
    const leftStr = String(left || '');
    const rightStr = String(right || '');
    const leftWidth = [...leftStr].reduce((sum, c) => sum + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0);
    const rightWidth = [...rightStr].reduce((sum, c) => sum + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0);
    const spaces = Math.max(1, this.charsPerLine - leftWidth - rightWidth);
    return this.line(leftStr + ' '.repeat(spaces) + rightStr);
  }
  barcode(code, type = 2) {
    this._append([0x1d, 0x6b, type]);
    this._append(Buffer.from(code, 'ascii'));
    this._append([0x00]);
    return this;
  }
  qrCode(text) {
    const data = Buffer.from(text, 'utf8');
    const len = data.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x08]);
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x41, 0x32, 0x00]);
    this._append([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]);
    this._append(data);
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
    return this;
  }
  cashDrawer() { return this._append([0x1b, 0x70, 0x00, 0x40, 0xff]); }
  build() { return this.buffer; }
}

function buildReceipt(order, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);
  pos.init();
  pos.align(1);
  pos.big(true);
  pos.line(store?.name || 'FoodFlow');
  pos.big(false);
  pos.newline();
  if (store?.address) { pos.font(1); pos.line(store.address); pos.font(0); }
  pos.separator('=');
  pos.newline();
  pos.align(0);
  pos.twoColumn('订单号:', `#${order.id}`);
  pos.twoColumn('桌号:', order.table);
  pos.twoColumn('时间:', formatGlobalDateTime(order.createdAt));
  if (order.note) pos.line(`备注: ${order.note}`);
  pos.separator();
  pos.line('菜品');
  pos.separator('-');
  for (const item of order.items) {
    const name = item.name.length > 16 ? item.name.slice(0, 15) + '..' : item.name;
    pos.twoColumn(`${item.emoji || ''}${name} x${item.quantity}`, `$${((Number(item.base_price) || Number(item.price) || 0) * item.quantity).toFixed(2)}`);
  }
  pos.separator();
  pos.align(2);
  pos.bold(true);
  pos.line(`合计: $${Number(order.total).toFixed(2)}`);
  pos.bold(false);
  pos.newline();
  pos.align(1);
  pos.line('谢谢惠顾，欢迎再次光临！');
  pos.newline(2);
  try { pos.qrCode(`order:${order.id}`); pos.newline(); } catch (e) {}
  pos.cut(1);
  return pos.build();
}

function buildBatchReceipt(orders, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);
  const tableName = orders[0]?.table_name || '';
  const total = orders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
  pos.init();
  pos.align(1); pos.big(true);
  pos.line(store?.name || 'FoodFlow');
  pos.big(false); pos.newline();
  if (store?.address) { pos.font(1); pos.line(store.address); pos.font(0); }
  pos.separator('='); pos.newline();
  pos.align(0);
  pos.twoColumn('桌号:', tableName);
  pos.twoColumn('订单数:', String(orders.length));
  pos.twoColumn('时间:', formatGlobalDateTime(new Date().toISOString()));
  pos.separator();
  const mergedItems = {};
  for (const o of orders) {
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
    for (const item of items) {
      const key = item.name;
      if (!mergedItems[key]) mergedItems[key] = { ...item };
      else mergedItems[key].quantity += item.quantity;
    }
  }
  pos.line('菜品清单');
  pos.separator('-');
  for (const item of Object.values(mergedItems)) {
    const name = item.name.length > 16 ? item.name.slice(0, 15) + '..' : item.name;
    pos.twoColumn((item.emoji || '') + name + ' x' + item.quantity, '$' + ((Number(item.base_price) || Number(item.price) || 0) * item.quantity).toFixed(2));
  }
  pos.separator();
  pos.align(2); pos.bold(true);
  pos.line('合计: $' + total.toFixed(2));
  pos.bold(false); pos.newline();
  pos.align(1);
  pos.line('谢谢惠顾，欢迎再次光临！');
  pos.newline(2); pos.cut(1);
  return pos.build();
}

function buildKitchenTicket(order, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);
  pos.init();
  pos.align(1);
  pos.big(true);
  pos.line('后厨订单');
  pos.big(false);
  pos.newline();
  pos.separator('=');
  pos.align(0);
  pos.twoColumn('桌号:', order.table);
  pos.twoColumn('订单号:', `#${order.id}`);
  pos.twoColumn('时间:', formatGlobalTime(order.createdAt));
  if (order.note) pos.line(`备注: ${order.note}`);
  pos.separator();
  const pendingItems = order.items.filter(i => i.itemStatus !== 'done');
  for (const item of pendingItems) {
    pos.bold(true);
    pos.line(`${item.emoji || ''} ${item.name} x${item.quantity}`);
    pos.bold(false);
  }
  pos.newline(3);
  pos.cut(1);
  return pos.build();
}

async function printToNetworkPrinter(data, ip, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timeout = 10000;
    socket.setTimeout(timeout);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('打印机连接超时')); });
    socket.on('error', (err) => { reject(new Error(`打印机连接失败: ${err.message}`)); });
    socket.connect(port || 9100, ip, () => {
      socket.write(data, () => {
        setTimeout(() => { socket.destroy(); resolve(true); }, 500);
      });
    });
  });
}

// ---------- 辅助函数 ----------
function formatOrder(row) {
  let items = row.items;
  let dataCorrupted = false;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (_) {
      console.warn(`订单 ${row.id} 的 items 解析失败，原始内容:`, items);
      items = []; dataCorrupted = true;
    }
  } else if (!Array.isArray(items)) {
    items = []; dataCorrupted = true;
  }
  for (const item of items) {
    if (!item.itemStatus) item.itemStatus = 'pending';
  }
  return {
    id: row.id,
    table: row.table_name,
    order_no: row.order_no || '',
    table_name: row.table_name,
    items,
    total: row.total,
    status: row.status,
    createdAt: row.createdAt,
    sessionToken: row.session_token || '',
    customerToken: row.customer_token || '',
    note: row.note || '',
    dataCorrupted
  };
}

async function normalizeOrderItems(items, storeId) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('订单至少需要一道菜品');
  const normalized = [];
  for (const item of items) {
    const menuId = Number(item.id);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(menuId) || !Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('菜品或数量无效');
    }
    const menuItem = await getAsync('SELECT * FROM menus WHERE id = ? AND store_id = ?', [menuId, storeId || 1]);
    if (!menuItem) throw new Error(`菜品不存在（ID: ${menuId}）`);
    const store = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [menuItem.store_id || 1]);
    if (!store) throw new Error(`菜品所属店铺不存在（ID: ${menuItem.store_id}）`);
    const currency = await getAsync('SELECT code, rate FROM currencies WHERE code=? AND merchant_id=?', [menuItem.currency_code || 'USD', store.merchant_id]);
    if (!currency || !(Number(currency.rate) > 0)) throw new Error(`菜品货币无效（${menuItem.currency_code || 'CNY'}）`);
    normalized.push({
      id: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,
      currency_code: currency.code,
      base_price: Number(menuItem.price) / Number(currency.rate),
      quantity,
      emoji: menuItem.emoji || '🍽️',
      itemStatus: item.itemStatus || 'pending',
      show_dual: item.show_dual || menuItem.show_dual || (item.secondary_currency_code || menuItem.secondary_currency_code ? 1 : 0),
      secondary_currency_code: item.secondary_currency_code || menuItem.secondary_currency_code || '',
      unit: item.unit || menuItem.unit || '份'
    });
  }
  return normalized;
}

async function assertTableExists(table, storeId) {
  const normalized = String(table || '').trim();
  if (!normalized) throw new Error('请选择桌号');
  const existing = await getAsync('SELECT name FROM tables WHERE name = ? AND store_id = ?', [normalized, storeId || 1]);
  if (!existing) throw new Error('桌号不存在');
  return normalized;
}

async function verifyLegacyAdminPassword(inputPwd) {
  const row = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_password'");
  if (!row || !row.value) return false;
  return verifyPassword(inputPwd, row.value);
}

async function getWaiterFromRequest(req) {
  const token = req.get('X-Waiter-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token=?', [token]);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [session.waiter_id]);
}

async function getCashierFromRequest(req) {
  const token = req.get('X-Cashier-Token') || req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const session = await getAsync('SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token=?', [token]);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  const cashiersData = await getAsync('SELECT value FROM settings WHERE `key` = ?', ['cashiers_' + session.store_id]);
  if (!cashiersData) return null;
  let cashiers = [];
  try { cashiers = JSON.parse(cashiersData.value); } catch (e) { return null; }
  const cashier = cashiers.find(c => String(c.id) === String(session.cashier_id) && c.active);
  if (!cashier) return null;
  return { ...cashier, store_id: session.store_id, merchant_id: session.merchant_id };
}

async function authenticateAdmin(req) {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token) {
    const session = await getAsync('SELECT * FROM admin_sessions WHERE token=?', [token]);
    if (session) {
      if (new Date(session.expires_at).getTime() <= Date.now()) {
        await runAsync('DELETE FROM admin_sessions WHERE token=?', [token]).catch(() => {});
        return { error: '登录已过期，请重新登录' };
      }
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [session.admin_id]);
      if (admin) {
        const merchant = await getAsync('SELECT * FROM merchants WHERE id=? AND status=1', [admin.merchant_id]);
        if (merchant) {
          let requestedStoreId = parseInt(req.get('X-Store-Id') || '0', 10);
          let validStoreId = null;
          if (requestedStoreId > 0) {
            const storeCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [requestedStoreId, admin.merchant_id]);
            if (storeCheck) validStoreId = requestedStoreId;
            else {
              const firstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
              if (!firstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
              validStoreId = firstStore.id;
            }
          } else {
            const firstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
            if (!firstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
            validStoreId = firstStore.id;
          }
          const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
          const timeoutMinutes = parseInt(timeoutSetting?.value || '30', 10);
          const newExpires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
          runAsync('UPDATE admin_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(() => {});
          return { adminId: admin.id, merchantId: admin.merchant_id, storeId: validStoreId, sessionToken: token };
        }
      }
    }
    try {
      const payload = JSON.parse(Buffer.from(token, 'base64').toString());
      if (payload.adminId) {
        const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [payload.adminId]);
        if (admin) {
          const merchant = await getAsync('SELECT * FROM merchants WHERE id=? AND status=1', [admin.merchant_id]);
          if (merchant) {
            let legacyStoreId = parseInt(req.get('X-Store-Id') || '0', 10);
            let legacyValidStoreId = null;
            if (legacyStoreId > 0) {
              const legacyStoreCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [legacyStoreId, admin.merchant_id]);
              if (legacyStoreCheck) legacyValidStoreId = legacyStoreId;
              else {
                const legacyFirstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
                if (!legacyFirstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
                legacyValidStoreId = legacyFirstStore.id;
              }
            } else {
              const legacyFirstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
              if (!legacyFirstStore) return { error: '该商户尚未创建店铺，请联系超级管理员' };
              legacyValidStoreId = legacyFirstStore.id;
            }
            return { adminId: admin.id, merchantId: admin.merchant_id, storeId: legacyValidStoreId };
          }
        }
      }
    } catch (e) { /* 不是旧格式token */ }
  }
  const providedKey = req.get('X-Admin-Key');
  const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_access_key'");
  if (providedKey && setting && providedKey === setting.value) {
    return { storeId: parseInt(req.get('X-Store-Id') || '1', 10) };
  }
  return null;
}

async function requireAdminKey(req, res, next) {
  const result = await authenticateAdmin(req);
  if (result && result.error) return res.status(401).json({ error: result.error });
  if (result) {
    req.adminId = result.adminId;
    req.merchantId = result.merchantId;
    req.adminSessionToken = result.sessionToken;
    req.storeId = result.storeId || 0;
    if (!req.storeId) {
      return res.status(401).json({ error: '未选择有效店铺，请重新登录' });
    }
    try {
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=?', [result.adminId]);
      if (admin) {
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [result.merchantId]);
        req.isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
        req.adminPermissions = {
          can_manage_menu: req.isPrimaryAdmin || admin.can_manage_menu ? 1 : 0,
          can_manage_table: req.isPrimaryAdmin || admin.can_manage_table ? 1 : 0,
          can_manage_order: req.isPrimaryAdmin || admin.can_manage_order ? 1 : 0,
          can_delete_order: req.isPrimaryAdmin || admin.can_delete_order ? 1 : 0,
          can_edit_order: req.isPrimaryAdmin || admin.can_edit_order ? 1 : 0,
          can_manage_store: req.isPrimaryAdmin || admin.can_manage_store ? 1 : 0,
          can_manage_waiter: req.isPrimaryAdmin || admin.can_manage_waiter ? 1 : 0,
          can_manage_currency: req.isPrimaryAdmin || admin.can_manage_currency ? 1 : 0,
          can_manage_printer: req.isPrimaryAdmin || admin.can_manage_printer ? 1 : 0,
          can_manage_admin: req.isPrimaryAdmin || admin.can_manage_admin ? 1 : 0,
          can_view_logs: req.isPrimaryAdmin || admin.can_view_logs ? 1 : 0
        };
      }
    } catch (e) { console.warn('加载管理员权限失败:', e.message); }
    return next();
  }
  return res.status(401).json({ error: '未登录或登录已过期' });
}

function requirePermission(permKey) {
  return function(req, res, next) {
    if (req.isPrimaryAdmin || (req.adminPermissions && req.adminPermissions[permKey])) {
      return next();
    }
    return res.status(403).json({ error: '没有操作权限' });
  };
}

async function logAudit(actorType, actorId, actorUsername, action, targetType, targetId, details, ip) {
  try {
    await runAsync('INSERT INTO audit_logs (actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [actorType, actorId || null, actorUsername || '', action, targetType || null, targetId || null, details || '', ip || '', new Date().toISOString()]);
  } catch (e) { console.warn('审计日志记录失败:', e.message); }
}

async function requireAdminOrWaiter(req, res, next) {
  const adminResult = await authenticateAdmin(req);
  if (adminResult && adminResult.error) return res.status(401).json({ error: adminResult.error });
  if (adminResult) {
    req.adminId = adminResult.adminId;
    req.merchantId = adminResult.merchantId;
    req.isAdmin = true;
    req.adminSessionToken = adminResult.sessionToken;
    req.storeId = adminResult.storeId;
    try {
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=?', [adminResult.adminId]);
      if (admin) {
        const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [adminResult.merchantId]);
        req.isPrimaryAdmin = primaryAdmin && primaryAdmin.id === admin.id;
        req.adminPermissions = {
          can_manage_menu: req.isPrimaryAdmin || admin.can_manage_menu ? 1 : 0,
          can_manage_table: req.isPrimaryAdmin || admin.can_manage_table ? 1 : 0,
          can_manage_order: req.isPrimaryAdmin || admin.can_manage_order ? 1 : 0,
          can_delete_order: req.isPrimaryAdmin || admin.can_delete_order ? 1 : 0,
          can_edit_order: req.isPrimaryAdmin || admin.can_edit_order ? 1 : 0,
          can_manage_store: req.isPrimaryAdmin || admin.can_manage_store ? 1 : 0,
          can_manage_waiter: req.isPrimaryAdmin || admin.can_manage_waiter ? 1 : 0,
          can_manage_currency: req.isPrimaryAdmin || admin.can_manage_currency ? 1 : 0,
          can_manage_printer: req.isPrimaryAdmin || admin.can_manage_printer ? 1 : 0,
          can_manage_admin: req.isPrimaryAdmin || admin.can_manage_admin ? 1 : 0,
          can_view_logs: req.isPrimaryAdmin || admin.can_view_logs ? 1 : 0
        };
      }
    } catch (e) { console.warn('加载管理员权限失败:', e.message); }
    return next();
  }
  const authHeader = req.get('Authorization') || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
  const token = req.get('X-Waiter-Token') || bearerToken;
  if (token) {
    const session = await getAsync('SELECT waiter_id, expires_at FROM waiter_sessions WHERE token=?', [token]);
    if (session && new Date(session.expires_at).getTime() > Date.now()) {
      const waiter = await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [session.waiter_id]);
      if (waiter) {
        req.waiter = waiter;
        req.waiterStoreId = waiter.store_id || 1;
        req.isAdmin = false;
        const expiresTime = new Date(session.expires_at).getTime();
        if (expiresTime - Date.now() < 60 * 60 * 1000) {
          const wTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'waiter_session_timeout'");
          const wTimeoutHours = parseInt(wTimeoutSetting?.value || '12', 10);
          const newExpires = new Date(Date.now() + wTimeoutHours * 60 * 60 * 1000).toISOString();
          runAsync('UPDATE waiter_sessions SET expires_at=? WHERE token=?', [newExpires, token]).catch(()=>{});
        }
        return next();
      }
    }
  }
  return res.status(401).json({ error: '无操作权限' });
}

// ---------- 自动备份 ----------
async function collectBackupData() {
  const tables = ['menus', 'tables', 'orders', 'currencies', 'menu_categories', 'settings', 'login_logs', 'audit_logs', 'scan_sessions', 'waiters', 'waiter_sessions', 'stores', 'waiter_calls', 'reservations', 'printers', 'merchants', 'merchant_admins', 'super_admins'];
  const data = { exportedAt: new Date().toISOString(), tables: {} };
  for (const table of tables) {
    data.tables[table] = await allAsync(`SELECT * FROM \`${table}\``);
  }
  return data;
}

async function autoBackupDatabase() {
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const data = await collectBackupData();
  const filename = path.join(backupDir, `auto-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  await runAsync("INSERT INTO settings (`key`, value) VALUES ('last_backup_at', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [new Date().toISOString()]);
}

async function maybeAutoBackup() {
  const intervalRow = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
  const intervalHours = Number(intervalRow?.value || 24);
  const lastRow = await getAsync("SELECT value FROM settings WHERE `key` = 'last_backup_at'");
  const lastTime = lastRow ? new Date(lastRow.value).getTime() : 0;
  if (Date.now() - lastTime >= intervalHours * 60 * 60 * 1000) {
    await autoBackupDatabase();
  }
}

// 自动清理日志（已修复字段名：login_logs.createdAt 是驼峰）
async function autoCleanLogs() {
  try {
    const enabledRow = await getAsync("SELECT value FROM settings WHERE `key` = 'auto_clean_log_enabled'");
    if (!enabledRow || (enabledRow.value !== '1' && enabledRow.value !== 'true')) return;

    const daysRow = await getAsync("SELECT value FROM settings WHERE `key` = 'log_retention_days'");
    const retentionDays = parseInt(daysRow?.value || '30', 10);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const cleanLoginRow = await getAsync("SELECT value FROM settings WHERE `key` = 'clean_login_log'");
    const cleanAuditRow = await getAsync("SELECT value FROM settings WHERE `key` = 'clean_audit_log'");

    let cleaned = 0;

    // login_logs 的时间字段是 createdAt（驼峰）
    if (!cleanLoginRow || cleanLoginRow.value === '1' || cleanLoginRow.value === 'true') {
      try {
        const result = await runAsync('DELETE FROM login_logs WHERE createdAt < ?', [cutoff]);
        cleaned += result.affectedRows || 0;
      } catch (e) {
        console.warn('清理登录日志失败:', e.message);
      }
    }

    if (!cleanAuditRow || cleanAuditRow.value === '1' || cleanAuditRow.value === 'true') {
      try {
        const result = await runAsync('DELETE FROM audit_logs WHERE created_at < ?', [cutoff]);
        cleaned += result.affectedRows || 0;
      } catch (e) {
        console.warn('清理审计日志失败:', e.message);
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 自动清理日志: 删除 ${cleaned} 条过期日志（保留 ${retentionDays} 天）`);
    }
  } catch (e) {
    console.warn('自动清理日志失败:', e.message);
  }
}

// ============================================================
//  路由
// ============================================================

// ----- 公开接口 -----

app.get('/api/public/config', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const store = await getAsync('SELECT merchant_id FROM stores WHERE id=?', [storeId]);
    const merchantId = store?.merchant_id || 1;

    const currencies = await allAsync(
      'SELECT code, symbol, name, rate, is_default FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code',
      [merchantId]
    );

    const dualRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_dual_currency_enabled`])
                 || await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
    const secondaryRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_secondary_currency_code`])
                      || await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
    const secondaryCurrency = currencies.find(c => c.code === secondaryRow?.value) || null;

    const soundRow = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${merchantId}_new_order_sound_enabled`])
                  || await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");

    // 一次性读取所有 constraints 相关 setting
    const keys = [
      'waiter_refresh_interval',
      'kitchen_auto_hide_minutes',
      'max_order_items',
      'max_item_quantity',
      'max_order_note_length',
      'order_interval_seconds',
      'call_limit_enabled',
      'call_limit_max',
      'call_limit_window_minutes',
      'call_limit_cooldown_minutes',
    ];
    const placeholders = keys.map(() => '?').join(',');
    const rows = await allAsync(
      `SELECT \`key\`, value FROM settings WHERE \`key\` IN (${placeholders})`,
      keys
    );
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });

    // 结构化约束对象（前端唯一权威来源）
    const constraints = {
      order: {
        maxItemTypes:   parseInt(s.max_order_items || '50', 10),
        maxPerItem:     parseInt(s.max_item_quantity || '100', 10),
        maxNoteLength:  parseInt(s.max_order_note_length || '200', 10),
        minIntervalSec: parseInt(s.order_interval_seconds || '30', 10),
      },
      call: {
        enabled:         (s.call_limit_enabled || '1') !== '0',
        maxPerWindow:    parseInt(s.call_limit_max || '3', 10),
        windowMinutes:   parseInt(s.call_limit_window_minutes || '5', 10),
        cooldownMinutes: parseInt(s.call_limit_cooldown_minutes || '10', 10),
      },
    };

    res.json({
      currencies,
      defaultCurrency: currencies.find(c => c.is_default) || currencies[0] || { code: 'USD', symbol: '$', rate: 1 },
      dualCurrency: { enabled: dualRow?.value === '1', currency: secondaryCurrency },
      newOrderSoundEnabled: soundRow ? soundRow.value === '1' : true,

      // 统一约束对象
      constraints,

      // 兼容旧前端：保留扁平字段
      waiter_refresh_interval:   parseInt(s.waiter_refresh_interval || '8', 10),
      kitchen_auto_hide_minutes: parseInt(s.kitchen_auto_hide_minutes || '10', 10),
      max_order_items:           constraints.order.maxItemTypes,
      max_item_quantity:         constraints.order.maxPerItem,
      max_order_note_length:     constraints.order.maxNoteLength,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/store-info', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const store = await getAsync('SELECT id, name, address FROM stores WHERE id=? AND active=1', [storeId]);
    if (!store) return res.status(404).json({ error: '店铺不存在' });
    res.json(store);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/categories', async (req, res) => {
  try {
    const storeId = parseInt(req.query.store_id || '1', 10);
    const rows = await allAsync('SELECT id, name, sort FROM menu_categories WHERE store_id=? ORDER BY sort', [storeId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'ordering-system', timestamp: new Date().toISOString() }));

// ----- 商户管理员登录 -----
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username || '', 'merchant_admin', '请输入用户名和密码']);
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const lockStatus = await isLoginLocked(username, 'merchant_admin');
    if (lockStatus.locked) {
      return res.status(429).json({ error: `登录失败次数过多，请${lockStatus.remaining}分钟后再试` });
    }
    const admin = await getAsync('SELECT * FROM merchant_admins WHERE username=? AND active=1', [username]);
    if (!admin) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'merchant_admin', '用户名不存在']);
      recordLoginAttempt(username, 'merchant_admin');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const isValid = verifyPassword(password, admin.password_hash);
    if (!isValid) {
      await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, login_type, message) VALUES (?, 0, ?, ?, ?, ?)', [new Date().toISOString(), getClientIp(req), username, 'merchant_admin', '密码错误']);
      recordLoginAttempt(username, 'merchant_admin');
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const merchant = await getAsync('SELECT * FROM merchants WHERE id=?', [admin.merchant_id]);
    if (!merchant || merchant.status !== 1) {
      return res.status(403).json({ error: '商户账号已被禁用，请联系超级管理员' });
    }
    resetLoginAttempts(username, 'merchant_admin');
    await runAsync('UPDATE merchant_admins SET last_login_at=NOW() WHERE id=?', [admin.id]);
    const clientIp = getClientIp(req);
    const location = await getLocationByIp(clientIp);
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, username, location, merchant_id, login_type, message) VALUES (?, 1, ?, ?, ?, ?, ?, ?)', [new Date().toISOString(), clientIp, username, location, admin.merchant_id, 'merchant_admin', '商户管理员登录成功: ' + username]);
    const token = crypto.randomBytes(32).toString('hex');
    const timeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
    const timeoutMinutes = parseInt(timeoutSetting?.value || '30', 10);
    const expiresAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    await runAsync('INSERT INTO admin_sessions (admin_id, token, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [admin.id, token, expiresAt, new Date().toISOString(), clientIp, req.get('User-Agent') || '']);
    const primaryAdmin = await getAsync('SELECT id FROM merchant_admins WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
    const isPrimary = primaryAdmin && primaryAdmin.id === admin.id;
    res.json({ success: true, token, merchantId: admin.merchant_id, merchantName: merchant.name, adminId: admin.id, username: admin.username, displayName: admin.display_name, isPrimary,
      permissions: {
        can_manage_menu: isPrimary || admin.can_manage_menu ? 1 : 0,
        can_manage_table: isPrimary || admin.can_manage_table ? 1 : 0,
        can_manage_order: isPrimary || admin.can_manage_order ? 1 : 0,
        can_delete_order: isPrimary || admin.can_delete_order ? 1 : 0,
        can_edit_order: isPrimary || admin.can_edit_order ? 1 : 0,
        can_manage_store: isPrimary || admin.can_manage_store ? 1 : 0,
        can_manage_waiter: isPrimary || admin.can_manage_waiter ? 1 : 0,
        can_manage_currency: isPrimary || admin.can_manage_currency ? 1 : 0,
        can_manage_printer: isPrimary || admin.can_manage_printer ? 1 : 0,
        can_manage_admin: isPrimary || admin.can_manage_admin ? 1 : 0,
        can_view_logs: isPrimary || admin.can_view_logs ? 1 : 0,
        can_manage_cashier: isPrimary || admin.can_manage_cashier ? 1 : 0
      }
    });
  } catch (e) {
    await runAsync('INSERT INTO login_logs (createdAt, success, ip, message) VALUES (?, 0, ?, ?)', [new Date().toISOString(), getClientIp(req), e.message]).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// ===== 超级管理员登录 =====
// ----- 超管路由 -----
require('./routes/super.js')(app, { getAsync, runAsync, allAsync, isLoginLocked, recordLoginAttempt, resetLoginAttempts, verifyPassword, hashPassword, getClientIp, getLocationByIp, requireSuperAdmin, logAudit });


// ----- 系统日志+登出+改密码 -----
require('./routes/admin-system.js')(app, { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, verifyPassword, hashPassword, logAudit, getClientIp });


// ----- 服务员登录 -----
// ----- 服务员+收银员 -----
require('./routes/cashier.js')(app, { getAsync, runAsync, allAsync, isLoginLocked, recordLoginAttempt, resetLoginAttempts, verifyPassword, getClientIp, requireCashier, formatOrder, syncTableStatus, buildBatchReceipt, printToNetworkPrinter, io });


// ----- 服务员概览 -----
// ----- 订单核心路由 -----
require('./routes/orders.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, printToNetworkPrinter });

// ----- 订单打印 -----
app.get('/api/orders/:id(\\d+)/print', requireAdminOrWaiter, async (req, res) => {
  try {
    const row = await getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    if (row.store_id !== printStoreId) return res.status(403).json({ error: '无权访问此订单' });
    const order = formatOrder(row);
    const store = await getAsync('SELECT name, address FROM stores WHERE id=?', [row.store_id || 1]);
    res.json({
      order,
      store: store || { name: 'FoodFlow', address: '' },
      printedAt: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 打印机管理 -----
app.get('/api/admin/printers', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM printers WHERE store_id=? ORDER BY id', [req.storeId || 1]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/printers', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const { name, type, ip_address, port, paper_width, brand, is_default } = req.body || {};
    if (!name) return res.status(400).json({ error: '打印机名称必填' });
    if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [req.storeId || 1]);
    const result = await runAsync(
      'INSERT INTO printers (name, type, ip_address, port, paper_width, brand, is_default, active, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [name, type || 'network', ip_address || '', port || 9100, paper_width || 58, brand || 'generic', is_default ? 1 : 0, req.storeId || 1]
    );
    res.status(201).json(await getAsync('SELECT * FROM printers WHERE id=?', [result.lastID]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '打印机不存在' });
    const { name, type, ip_address, port, paper_width, brand, is_default, active } = req.body || {};
    if (is_default) await runAsync('UPDATE printers SET is_default=0 WHERE store_id=?', [current.store_id]);
    await runAsync(
      'UPDATE printers SET name=?, type=?, ip_address=?, port=?, paper_width=?, brand=?, is_default=?, active=? WHERE id=? AND store_id=?',
      [name || current.name, type || current.type, ip_address ?? current.ip_address, port || current.port, paper_width || current.paper_width, brand || current.brand, is_default !== undefined ? (is_default ? 1 : 0) : current.is_default, active !== undefined ? (active ? 1 : 0) : current.active, id, req.storeId]
    );
    res.json(await getAsync('SELECT * FROM printers WHERE id=? AND store_id=?', [id, req.storeId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/printers/:id', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const current = await getAsync('SELECT id FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
    if (!current) return res.status(404).json({ error: '打印机不存在' });
    await runAsync('DELETE FROM printers WHERE id=? AND store_id=?', [id, req.storeId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id(\\d+)/print', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const printStoreId = req.isAdmin ? (req.storeId || 1) : (req.waiterStoreId || 1);
    const row = await getAsync('SELECT * FROM orders WHERE id = ? AND store_id = ?', [id, printStoreId]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const order = formatOrder(row);
    const store = await getAsync('SELECT name, address FROM stores WHERE id=? AND merchant_id=?', [row.store_id || 1, req.merchantId || 1]);
    const printerId = req.body?.printer_id;
    let printer;
    if (printerId) {
      printer = await getAsync('SELECT * FROM printers WHERE id=? AND store_id=? AND active=1', [printerId, row.store_id]);
    } else {
      printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [row.store_id || 1]);
    }
    const printData = buildReceipt(order, store, printer);
    if (printer && printer.type === 'network' && printer.ip_address) {
      try {
        await printToNetworkPrinter(printData, printer.ip_address, printer.port);
        return res.json({ success: true, printed: true, printer: printer.name });
      } catch (e) {
        return res.status(502).json({ success: false, error: e.message, printData: printData.toString('base64') });
      }
    }
    res.json({ success: true, printed: false, printData: printData.toString('base64'), message: '请使用前端打印' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id(\\d+)/print-kitchen', requireAdminOrWaiter, async (req, res) => {
  try {
    const id = req.params.id;
    const row = await getAsync('SELECT * FROM orders WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: '订单不存在' });
    const order = formatOrder(row);
    const store = await getAsync('SELECT name, address FROM stores WHERE id=?', [row.store_id || 1]);
    const printer = await getAsync('SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1', [row.store_id || 1]);
    const printData = buildKitchenTicket(order, store, printer);
    if (printer && printer.type === 'network' && printer.ip_address) {
      try {
        await printToNetworkPrinter(printData, printer.ip_address, printer.port);
        return res.json({ success: true, printed: true });
      } catch (e) {
        return res.status(502).json({ success: false, error: e.message, printData: printData.toString('base64') });
      }
    }
    res.json({ success: true, printed: false, printData: printData.toString('base64') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings/auto-print', requireAdminKey, async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`auto_print_receipt_${storeId}`]);
    const enabled = row ? (row.value === '1' || row.value === 'true') : true;
    res.json({ enabled: enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/order-prefixes', requireAdminKey, async (req, res) => {
  try {
    const keys = ['order_prefix_normal', 'order_prefix_refund', 'order_prefix_discount', 'order_prefix_vip', 'order_no_reset_period'];
    const rows = await allAsync("SELECT `key`, value FROM settings WHERE `key` IN (?)", [keys]);
    const result = {};
    for (const r of rows) result[r.key] = r.value;
    result.order_prefix_normal = result.order_prefix_normal || '11';
    result.order_prefix_refund = result.order_prefix_refund || '01';
    result.order_prefix_discount = result.order_prefix_discount || '21';
    result.order_prefix_vip = result.order_prefix_vip || '61';
    result.order_no_reset_period = result.order_no_reset_period || 'daily';
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/order-prefixes', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const { normal, refund, discount, vip, daily_reset } = req.body || {};
    const pairs = [
      ['order_prefix_normal', (normal || '11').padStart(2, '0').slice(-2)],
      ['order_prefix_refund', (refund || '01').padStart(2, '0').slice(-2)],
      ['order_prefix_discount', (discount || '21').padStart(2, '0').slice(-2)],
      ['order_prefix_vip', (vip || '61').padStart(2, '0').slice(-2)],
      ['order_no_reset_period', ['daily','monthly','yearly','never'].includes(daily_reset) ? daily_reset : 'daily']
    ];
    for (const [k, v] of pairs) {
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [k, v]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/settings/auto-print', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const storeId = req.storeId || 1;
    const { enabled } = req.body || {};
    const key = `auto_print_receipt_${storeId}`;
    const existing = await getAsync("SELECT value FROM settings WHERE `key` = ?", [key]);
    if (existing) {
      await runAsync("UPDATE settings SET value = ? WHERE `key` = ?", [enabled ? '1' : '0', key]);
    } else {
      await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?)", [key, enabled ? '1' : '0']);
    }
    res.json({ success: true, enabled: enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/printers/test', requireAdminKey, requirePermission('can_manage_printer'), async (req, res) => {
  try {
    const { printer_id } = req.body || {};
    const printer = await getAsync('SELECT * FROM printers WHERE id=? AND active=1', [printer_id]);
    if (!printer) return res.status(404).json({ error: '打印机不存在或未启用' });
    if (printer.type !== 'network' || !printer.ip_address) {
      return res.status(400).json({ error: '仅支持网络打印机测试' });
    }
    const pos = new EscPosBuilder(printer.paper_width || 58);
    pos.init();
    pos.align(1);
    pos.big(true);
    pos.line('测试打印');
    pos.big(false);
    pos.newline();
    pos.line(`打印机: ${printer.name}`);
    pos.line(`品牌: ${printer.brand}`);
    pos.line(`纸宽: ${printer.paper_width}mm`);
    pos.line(`时间: ${formatGlobalDateTime(new Date())}`);
    pos.newline();
    pos.separator();
    pos.line('如果您看到此内容，说明打印机正常工作！');
    pos.newline(2);
    pos.cut(1);
    await printToNetworkPrinter(pos.build(), printer.ip_address, printer.port);
    res.json({ success: true, message: '测试打印已发送' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 数据导出 -----
app.get('/api/admin/export/:type', requireAdminKey, async (req, res) => {
  try {
    const type = req.params.type;
    let rows = [], filename = '', headers = [];
    if (type === 'orders') {
      rows = await allAsync('SELECT * FROM orders WHERE store_id=? ORDER BY id DESC LIMIT 1000', [req.storeId]);
      filename = `orders_${new Date().toISOString().slice(0,10)}.csv`;
      headers = ['订单号','桌号','状态','金额','备注','下单时间'];
    } else if (type === 'menu') {
      rows = await allAsync('SELECT * FROM menus WHERE store_id=? ORDER BY id', [req.storeId]);
      filename = `menu_${new Date().toISOString().slice(0,10)}.csv`;
      headers = ['ID','名称','英文名','价格','货币','分类','单位','状态'];
    } else if (type === 'sales') {
      rows = await allAsync(`
        SELECT m.id, m.name, m.price, SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)) AS total_qty,
               SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS DECIMAL(10,2)) * m.price) AS total_revenue
        FROM orders o
        JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
          ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
        JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
        WHERE o.store_id=? AND o.status = 'done'
        GROUP BY m.id, m.name, m.price
        ORDER BY total_qty DESC
      `, [req.storeId]);
      filename = `sales_${new Date().toISOString().slice(0,10)}.csv`;
      headers = ['菜品ID','菜品名称','单价','销量','销售额'];
    } else {
      return res.status(400).json({ error: '不支持的导出类型' });
    }
    const csvRows = [headers.join(',')];
    for (const row of rows) {
      if (type === 'orders') {
        csvRows.push([row.id, row.table_name, row.status, row.total, `"${(row.note||'').replace(/"/g,'""')}"`, row.createdAt].join(','));
      } else if (type === 'menu') {
        csvRows.push([row.id, `"${row.name}"`, `"${row.name_en||''}"`, row.price, row.currency_code, `"${row.category||''}"`, row.unit, row.active].join(','));
      } else if (type === 'sales') {
        csvRows.push([row.id, `"${row.name}"`, row.price, row.total_qty || 0, row.total_revenue || 0].join(','));
      }
    }
    const csv = '\uFEFF' + csvRows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 每日营业报表 -----
app.get('/api/admin/reports/daily', requireAdminKey, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const startOfDay = new Date(date + 'T00:00:00.000Z');
    const endOfDay = new Date(date + 'T23:59:59.999Z');
    const orderStats = await getAsync(`
      SELECT
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS completed_orders,
        SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled_orders,
        SUM(CASE WHEN status='done' THEN total ELSE 0 END) AS total_revenue,
        AVG(CASE WHEN status='done' THEN total END) AS avg_order_value
      FROM orders
      WHERE store_id=? AND createdAt >= ? AND createdAt <= ?
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
    const tableRevenue = await allAsync(`
      SELECT table_name, COUNT(*) AS orders, SUM(total) AS revenue
      FROM orders
      WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
      GROUP BY table_name
      ORDER BY revenue DESC
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
    const dishRanking = await allAsync(`
      SELECT m.name, m.emoji,
             SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)
               - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS UNSIGNED), 0)) AS quantity
      FROM orders o
      JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
        ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
      JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
      WHERE o.store_id=? AND o.status='done' AND o.createdAt >= ? AND o.createdAt <= ?
      GROUP BY m.id, m.name, m.emoji
      HAVING quantity > 0
      ORDER BY quantity DESC
      LIMIT 10
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
    const hourlyStats = await allAsync(`
      SELECT CONCAT(LPAD(HOUR(createdAt),2,'0'), ':', LPAD(FLOOR(MINUTE(createdAt)/10)*10, 2, '0')) AS time_bucket,
             COUNT(*) AS orders, SUM(total) AS revenue
      FROM orders
      WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt < ?
      GROUP BY time_bucket
      ORDER BY time_bucket
    `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
    res.json({
      date,
      summary: {
        totalOrders: orderStats?.total_orders || 0,
        completedOrders: orderStats?.completed_orders || 0,
        canceledOrders: orderStats?.canceled_orders || 0,
        totalRevenue: Number(orderStats?.total_revenue || 0),
        avgOrderValue: Number(orderStats?.avg_order_value || 0),
      },
      tableRevenue,
      dishRanking,
      hourlyStats,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/reports/summary', requireAdminKey, async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const todayStats = await getAsync(`
      SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
      FROM orders WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
    `, [req.storeId, todayStart.toISOString(), todayEnd.toISOString()]);
    const monthStats = await getAsync(`
      SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
      FROM orders WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
    `, [req.storeId, monthStart.toISOString(), monthEnd.toISOString()]);
    const topDishes = await allAsync(`
      SELECT m.id, m.name, m.emoji, m.price, m.category,
             SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)
               - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS UNSIGNED), 0)) AS sales_count
      FROM orders o
      JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
        ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
      JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
      WHERE o.store_id=? AND o.status='done' AND o.createdAt >= ? AND o.createdAt <= ?
      GROUP BY m.id, m.name, m.emoji, m.price, m.category
      HAVING sales_count > 0
      ORDER BY sales_count DESC LIMIT 10
    `, [req.storeId, monthStart.toISOString(), monthEnd.toISOString()]);
    res.json({
      today: { revenue: Number(todayStats?.revenue || 0), orders: todayStats?.orders || 0 },
      month: { revenue: Number(monthStats?.revenue || 0), orders: monthStats?.orders || 0 },
      topDishes,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/info', requireAdminKey, async (req, res) => {
  try {
    const admin = await getAsync('SELECT id, username, display_name, merchant_id, created_at, last_login_at, active FROM merchant_admins WHERE id=?', [req.adminId]);
    const merchant = await getAsync('SELECT id, name, code, contact_name, contact_phone, max_stores, status, created_at FROM merchants WHERE id=?', [admin?.merchant_id]);
    const storeCount = await getAsync('SELECT COUNT(*) as count FROM stores WHERE merchant_id=?', [admin?.merchant_id]);
    res.json({ admin, merchant, storeCount: storeCount?.count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/global-config', async (req, res) => {
  try {
    const idleSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_idle_timeout'");
    const qrSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const intervalSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'order_interval_seconds'");
    const cashierIdle = await getAsync("SELECT value FROM settings WHERE `key` = 'cashier_idle_timeout'");
    const kitchenIdle = await getAsync("SELECT value FROM settings WHERE `key` = 'kitchen_idle_timeout'");
    res.json({
      admin_idle_timeout: parseInt(idleSetting?.value || '30', 10),
      qr_session_timeout: parseInt(qrSetting?.value || '45', 10),
      order_interval_seconds: parseInt(intervalSetting?.value || '30', 10),
      cashier_idle_timeout: parseInt(cashierIdle?.value || '30', 10),
      kitchen_idle_timeout: parseInt(kitchenIdle?.value || '120', 10),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 催单 -----
app.post('/api/orders/:id(\\d+)/urge', async (req, res) => {
  try {
    const id = req.params.id;
    const order = await getAsync('SELECT * FROM orders WHERE id=?', [id]);
    if (!order) return res.status(404).json({ error: '订单不存在' });
    if (order.status !== 'pending') return res.status(400).json({ error: '订单已完成或已取消' });
    const callId = crypto.randomBytes(16).toString('hex');
    await runAsync(
      'INSERT INTO waiter_calls (id, table_name, type, message, status, store_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [callId, order.table_name, 'urge', `订单 #${id} 顾客催单`, 'pending', order.store_id || 1, new Date().toISOString()]
    );
    io.to('kitchen-' + (order.store_id || 1)).emit('order:urge', { orderId: id, table: order.table_name });
    io.to('waiter-' + (order.store_id || 1)).emit('order:urge', { orderId: id, table: order.table_name });
    res.json({ success: true, message: '已通知后厨，请稍候' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 商户管理员管理 -----
app.get('/api/admin/admins', requireAdminKey, async (req, res) => {
  try {
    const rows = await allAsync('SELECT id, username, display_name, active, last_login_at, created_at, (id = (SELECT MIN(id) FROM merchant_admins ma2 WHERE ma2.merchant_id = merchant_admins.merchant_id)) AS is_primary, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs FROM merchant_admins WHERE merchant_id=? ORDER BY id', [req.merchantId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/admins', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
  try {
    const { username, password, display_name, active } = req.body || {};
    if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写管理员资料' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    const exists = await getAsync('SELECT id FROM merchant_admins WHERE username=?', [String(username).trim()]);
    if (exists) return res.status(400).json({ error: '用户名已存在' });
    const result = await runAsync(
      'INSERT INTO merchant_admins (merchant_id, username, password_hash, display_name, active) VALUES (?, ?, ?, ?, ?)',
      [req.merchantId, String(username).trim(), hashPassword(password), display_name, active ? 1 : 0]
    );
    await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'create_admin', 'merchant_admin', result.lastID, `创建管理员: ${username}`, getClientIp(req));
    res.status(201).json(await getAsync('SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs FROM merchant_admins WHERE id=?', [result.lastID]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { display_name, active, password, permissions } = req.body || {};
    const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    if (!admin) return res.status(404).json({ error: '管理员不存在' });
    const primaryAdminId = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [req.merchantId]);
    const isPrimaryAdmin = primaryAdminId && primaryAdminId.min_id === admin.id;
    if (isPrimaryAdmin) return res.status(400).json({ error: '主管理员拥有全部权限，不可修改权限和状态' });
    if (id === req.adminId && active === 0) return res.status(400).json({ error: '不能禁用当前登录账号' });
    const fields = [];
    const values = [];
    if (display_name !== undefined) { fields.push('display_name=?'); values.push(display_name); }
    if (active !== undefined) { fields.push('active=?'); values.push(active ? 1 : 0); }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      fields.push('password_hash=?'); values.push(hashPassword(password));
    }
    if (permissions && typeof permissions === 'object') {
      const permFields = ['can_manage_menu', 'can_manage_table', 'can_manage_order', 'can_delete_order', 'can_edit_order', 'can_manage_store', 'can_manage_waiter', 'can_manage_currency', 'can_manage_printer', 'can_manage_admin', 'can_view_logs'];
      for (const field of permFields) {
        if (permissions[field] !== undefined) {
          fields.push(field + '=?');
          values.push(permissions[field] ? 1 : 0);
        }
      }
    }
    if (fields.length) {
      values.push(id);
      values.push(req.merchantId);
      await runAsync(`UPDATE merchant_admins SET ${fields.join(',')} WHERE id=? AND merchant_id=?`, values);
    }
    await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'update_admin', 'merchant_admin', id, `更新管理员: ${admin.username}`, getClientIp(req));
    res.json(await getAsync('SELECT id, username, display_name, active, created_at, can_manage_menu, can_manage_table, can_manage_order, can_delete_order, can_edit_order, can_manage_store, can_manage_waiter, can_manage_currency, can_manage_printer, can_manage_admin, can_view_logs FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/admins/:id', requireAdminKey, requirePermission('can_manage_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.adminId) return res.status(400).json({ error: '不能删除当前登录账号' });
    const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    if (admin) {
      const primaryAdminIdDel = await getAsync('SELECT MIN(id) AS min_id FROM merchant_admins WHERE merchant_id=?', [req.merchantId]);
      if (primaryAdminIdDel && primaryAdminIdDel.min_id === admin.id) return res.status(400).json({ error: '主管理员不可删除' });
    }
    if (!admin) return res.status(404).json({ error: '管理员不存在' });
    await runAsync('DELETE FROM merchant_admins WHERE id=? AND merchant_id=?', [id, req.merchantId]);
    await logAudit('merchant_admin', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'delete_admin', 'merchant_admin', id, `删除管理员: ${admin.username}`, getClientIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 收银员管理 -----
async function getCashiers(storeId) {
  const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", ['cashiers_' + storeId]);
  if (!row || !row.value) return [];
  try { return JSON.parse(row.value); } catch (e) { return []; }
}
async function saveCashiers(storeId, cashiers) {
  const exists = await getAsync("SELECT value FROM settings WHERE `key` = ?", ['cashiers_' + storeId]);
  if (exists) {
    await runAsync("UPDATE settings SET value=? WHERE `key`=?", [JSON.stringify(cashiers), 'cashiers_' + storeId]);
  } else {
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?)", ['cashiers_' + storeId, JSON.stringify(cashiers)]);
  }
}

app.get('/api/admin/cashiers', requireAdminKey, async (req, res) => {
  try {
    const cashiers = await getCashiers(req.storeId);
    const safe = cashiers.map(c => ({ id: c.id, username: c.username, display_name: c.display_name, active: c.active, permissions: c.permissions, created_at: c.created_at }));
    res.json({ cashiers: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/cashiers', requireAdminKey, async (req, res) => {
  try {
    const { username, password, display_name, permissions, active } = req.body || {};
    if (!username || !password || !display_name) return res.status(400).json({ error: '请完整填写收银员资料' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    const cashiers = await getCashiers(req.storeId);
    if (cashiers.find(c => c.username === String(username).trim())) return res.status(400).json({ error: '用户名已存在' });
    const newCashier = {
      id: Date.now(),
      username: String(username).trim(),
      display_name,
      password_hash: hashPassword(password),
      active: active !== false,
      permissions: {
        can_settle: permissions?.can_settle !== false,
        can_cancel: permissions?.can_cancel !== false,
        can_refund: permissions?.can_refund === true,
        can_view_report: permissions?.can_view_report !== false
      },
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    };
    cashiers.push(newCashier);
    await saveCashiers(req.storeId, cashiers);
    await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'create_cashier', 'cashier', newCashier.id, '创建收银员: ' + username, getClientIp(req));
    res.status(201).json({ success: true, cashier: { id: newCashier.id, username: newCashier.username, display_name: newCashier.display_name, active: newCashier.active, permissions: newCashier.permissions, created_at: newCashier.created_at } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/cashiers/:id', requireAdminKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { display_name, password, permissions, active } = req.body || {};
    const cashiers = await getCashiers(req.storeId);
    const idx = cashiers.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: '收银员不存在' });
    if (display_name !== undefined) cashiers[idx].display_name = display_name;
    if (active !== undefined) cashiers[idx].active = active !== false;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
      cashiers[idx].password_hash = hashPassword(password);
    }
    if (permissions && typeof permissions === 'object') {
      if (permissions.can_settle !== undefined) cashiers[idx].permissions.can_settle = permissions.can_settle !== false;
      if (permissions.can_cancel !== undefined) cashiers[idx].permissions.can_cancel = permissions.can_cancel !== false;
      if (permissions.can_refund !== undefined) cashiers[idx].permissions.can_refund = permissions.can_refund === true;
      if (permissions.can_view_report !== undefined) cashiers[idx].permissions.can_view_report = permissions.can_view_report !== false;
    }
    await saveCashiers(req.storeId, cashiers);
    await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'update_cashier', 'cashier', id, '更新收银员: ' + cashiers[idx].username, getClientIp(req));
    res.json({ success: true, cashier: { id: cashiers[idx].id, username: cashiers[idx].username, display_name: cashiers[idx].display_name, active: cashiers[idx].active, permissions: cashiers[idx].permissions, created_at: cashiers[idx].created_at } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/cashiers/:id', requireAdminKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cashiers = await getCashiers(req.storeId);
    const idx = cashiers.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: '收银员不存在' });
    const username = cashiers[idx].username;
    cashiers.splice(idx, 1);
    await saveCashiers(req.storeId, cashiers);
    await logAudit('cashier', req.adminId, (await getAsync('SELECT username FROM merchant_admins WHERE id=?', [req.adminId]))?.username || '', 'delete_cashier', 'cashier', id, '删除收银员: ' + username, getClientIp(req));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 商户操作日志 -----
app.get('/api/admin/audit-logs', requireAdminKey, requirePermission('can_view_logs'), async (req, res) => {
  try {
    const rows = await allAsync(
      "SELECT id, actor_type, actor_id, actor_username, action, target_type, target_id, details, ip, created_at FROM audit_logs WHERE actor_type='merchant_admin' AND actor_id IN (SELECT id FROM merchant_admins WHERE merchant_id=?) ORDER BY id DESC LIMIT 200",
      [req.merchantId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 管理员操作 -----
app.post('/api/admin/change-password', requireAdminKey, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: '请提供旧密码和新密码（新密码至少6位）' });
    }

    // 验证当前登录管理员的密码，并只修改自己的密码
    const admin = await getAsync('SELECT id, username, password_hash FROM merchant_admins WHERE id=?', [req.adminId]);
    if (!admin) {
      return res.status(401).json({ error: '管理员不存在' });
    }
    if (!verifyPassword(oldPassword, admin.password_hash)) {
      return res.status(401).json({ error: '旧密码错误' });
    }

    const hash = hashPassword(newPassword);
    await runAsync('UPDATE merchant_admins SET password_hash=? WHERE id=?', [hash, req.adminId]);
    await logAudit('merchant_admin', req.adminId, admin.username, 'change_password', 'merchant_admin', req.adminId, '修改管理员密码', getClientIp(req));

    res.json({ success: true, message: '密码已更新' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-data', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '请输入管理员密码' });
    const merchantId = req.merchantId;
    if (!merchantId) return res.status(400).json({ error: '商户信息缺失' });
    const admin = await getAsync('SELECT password_hash FROM merchant_admins WHERE id=?', [req.adminId]);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      return res.status(401).json({ error: '密码错误，重置失败' });
    }
    await runAsync('DELETE FROM orders WHERE merchant_id = ?', [merchantId]);
    await runAsync('DELETE FROM waiter_calls WHERE merchant_id = ?', [merchantId]);
    await runAsync('DELETE FROM scan_sessions WHERE merchant_id = ?', [merchantId]);
    await runAsync('DELETE FROM reservations WHERE merchant_id = ?', [merchantId]);
    res.json({ success: true, message: '订单数据已重置' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 超级管理员数据备份与恢复 -----
app.get('/api/super/backup/export', requireSuperAdmin, async (req, res) => {
  try {
    const data = await collectBackupData();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="foodflow-full-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/super/backup/import', requireSuperAdmin, async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.tables || typeof data.tables !== 'object') return res.status(400).json({ error: '备份文件格式无效' });
    await withTransaction(async () => {
      for (const table of ['menus', 'tables', 'orders', 'currencies', 'menu_categories', 'login_logs', 'audit_logs', 'scan_sessions', 'waiters', 'waiter_sessions', 'stores', 'waiter_calls', 'reservations', 'printers', 'merchants', 'merchant_admins', 'super_admins']) {
        const rows = Array.isArray(data.tables[table]) ? data.tables[table] : [];
        await runAsync(`DELETE FROM \`${table}\``);
        for (const row of rows) {
          const keys = Object.keys(row).filter(k => !['id'].includes(k));
          const placeholders = keys.map(() => '?').join(', ');
          const values = keys.map(k => row[k]);
          if (keys.length) {
            await runAsync(`INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${placeholders})`, values);
          }
        }
      }
    });
    res.json({ success: true, message: '备份已导入' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/super/backup/settings', requireSuperAdmin, async (req, res) => {
  try {
    const intervalRow = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
    const lastBackupRow = await getAsync("SELECT value FROM settings WHERE `key` = 'last_backup_at'");
    res.json({ intervalHours: parseInt(intervalRow?.value || '24', 10), lastBackupAt: lastBackupRow?.value || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/super/backup/settings', requireSuperAdmin, async (req, res) => {
  try {
    const { intervalHours } = req.body || {};
    const hours = Math.max(1, Math.min(168, parseInt(intervalHours, 10) || 24));
    await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_interval_hours', ?) ON DUPLICATE KEY UPDATE value=?", [String(hours), String(hours)]);
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
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: '请提供超级管理员密码' });
    if (!verifyPassword(password, req.superAdmin.password_hash)) {
      return res.status(401).json({ error: '密码错误，重置失败' });
    }
    await runAsync('DELETE FROM orders');
    await runAsync('ALTER TABLE orders AUTO_INCREMENT = 1');
    await runAsync('DELETE FROM waiter_calls');
    await runAsync('DELETE FROM scan_sessions');
    await runAsync('ALTER TABLE scan_sessions AUTO_INCREMENT = 1');
    await logAudit('super_admin', req.superAdmin.id, req.superAdmin.username, 'reset_all_data', 'system', null, '重置所有订单数据', getClientIp(req));
    res.json({ success: true, message: '所有订单数据已重置' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- 货币管理 -----
app.get('/api/currencies', requireAdminKey, async (req, res) => {
  try { res.json(await allAsync('SELECT * FROM currencies WHERE merchant_id=? ORDER BY is_default DESC, code', [req.merchantId])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/currencies', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const { code, symbol, name, rate, is_default } = req.body;
    if (!code || !symbol || !name || !(Number(rate) > 0)) return res.status(400).json({ error: '货币资料不完整' });
    await withTransaction(async () => {
      if (is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
      const result = await runAsync('INSERT INTO currencies (merchant_id, code, symbol, name, rate, is_default) VALUES (?, ?, ?, ?, ?, ?)', [req.merchantId, String(code).toUpperCase(), symbol, name, Number(rate), is_default ? 1 : 0]);
      res.status(201).json(await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [result.lastID, req.merchantId]));
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [req.params.id, req.merchantId]);
    if (!current) return res.status(404).json({ error: '货币不存在' });
    const next = { ...current, ...req.body };
    if (!(Number(next.rate) > 0)) return res.status(400).json({ error: '汇率必须大于 0' });
    await withTransaction(async () => {
      if (next.is_default) await runAsync('UPDATE currencies SET is_default=0 WHERE merchant_id=?', [req.merchantId]);
      await runAsync('UPDATE currencies SET code=?,symbol=?,name=?,rate=?,is_default=? WHERE id=? AND merchant_id=?', [String(next.code).toUpperCase(), next.symbol, next.name, Number(next.rate), next.is_default ? 1 : 0, current.id, req.merchantId]);
    });
    res.json(await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [current.id, req.merchantId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/currencies/:id', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const current = await getAsync('SELECT * FROM currencies WHERE id=? AND merchant_id=?', [req.params.id, req.merchantId]);
    if (!current) return res.status(404).json({ error: '货币不存在' });
    if (current.is_default) return res.status(409).json({ error: '默认货币不能删除，请先设置其他默认货币' });
    await runAsync('DELETE FROM currencies WHERE id=? AND merchant_id=?', [current.id, req.merchantId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 显示设置 -----
app.get('/api/admin/display-settings', requireAdminKey, async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const enabled = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_dual_currency_enabled`]);
    const secondary = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_secondary_currency_code`]);
    const enabledFallback = enabled || await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
    const secondaryFallback = secondary || await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
    res.json({ enabled: enabledFallback?.value === '1', secondaryCurrencyCode: secondaryFallback?.value || 'USD' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/display-settings', requireAdminKey, requirePermission('can_manage_currency'), async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const enabled = req.body.enabled ? '1' : '0';
    const secondary = String(req.body.secondaryCurrencyCode || 'USD');
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_dual_currency_enabled`, enabled]);
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_secondary_currency_code`, secondary]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 新订单提示音设置 -----
app.get('/api/admin/notification-settings', requireAdminKey, async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const row = await getAsync("SELECT value FROM settings WHERE `key` = ?", [`merchant_${mid}_new_order_sound_enabled`]);
    const fallback = row || await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
    res.json({ enabled: fallback ? fallback.value === '1' : true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/notification-settings', requireAdminKey, requirePermission('can_manage_store'), async (req, res) => {
  try {
    const mid = req.merchantId || 1;
    const enabled = req.body.enabled ? '1' : '0';
    await runAsync("INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [`merchant_${mid}_new_order_sound_enabled`, enabled]);
    res.json({ success: true, enabled: enabled === '1' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- 二维码 -----
app.get('/api/qrcode/:table', async (req, res) => {
  const tableName = String(req.params.table || '').trim();
  try {
    const table = await getAsync('SELECT name, qr_token FROM tables WHERE name = ?', [tableName]);
    if (!table) return res.status(404).json({ error: '桌号不存在' });
    const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ qrDataUrl, url, table: tableName });
  } catch (e) {
    res.status(500).json({ error: '生成二维码失败' });
  }
});

app.get('/api/tables/:id/qrcode', requireAdminKey, async (req, res) => {
  try {
    const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ? AND store_id = ?', [req.params.id, req.storeId]);
    if (!table) return res.status(404).json({ error: '桌号不存在' });
    const store = await getAsync('SELECT name FROM stores WHERE id = ?', [table.store_id || 1]);
    const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ qrDataUrl, url, table: table.name, storeName: store?.name || '' });
  } catch (e) {
    res.status(500).json({ error: '生成二维码失败' });
  }
});

// ----- 顾客二维码桌码解析 -----
app.get('/api/public/table-token/:token', async (req, res) => {
  try {
    const table = await getAsync('SELECT name, store_id FROM tables WHERE qr_token=?', [req.params.token]);
    if (!table) return res.status(404).json({ error: '无效或已失效的桌码' });
    const sessionToken = crypto.randomBytes(24).toString('base64url');
    const qrTimeoutSetting = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const qrTimeoutMinutes = parseInt(qrTimeoutSetting?.value || '45', 10);
    const expiresAt = qrTimeoutMinutes > 0
      ? new Date(Date.now() + qrTimeoutMinutes * 60 * 1000).toISOString()
      : new Date('9999-12-31T23:59:59Z').toISOString();
    await runAsync('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, ?)', [table.name, sessionToken, expiresAt, new Date().toISOString(), table.store_id || 1]);
    const customerToken = crypto.randomBytes(16).toString('base64url');
    res.json({ table: table.name, storeId: table.store_id || 1, sessionToken, customerToken, expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/table-session/:token/orders', async (req, res) => {
  try {
    const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [req.params.token]);
    if (!session) return res.status(404).json({ error: '扫码会话不存在，请重新扫码' });
    if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '二维码已过期，请重新扫码' });
    const qrTimeoutS = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const qrTimeoutMins = parseInt(qrTimeoutS?.value || '45', 10);
    if (qrTimeoutMins > 0) {
      const newQrExpires = new Date(Date.now() + qrTimeoutMins * 60 * 1000).toISOString();
      runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [newQrExpires, req.params.token]).catch(()=>{});
    }
    const customerToken = req.query.ct || '';
    let rows;
    if (customerToken) {
      rows = await allAsync("SELECT * FROM orders WHERE table_name=? AND store_id=? AND customer_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.table_name, session.store_id || 1, customerToken]);
    } else {
      rows = await allAsync("SELECT * FROM orders WHERE table_name=? AND store_id=? AND session_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.table_name, session.store_id || 1, req.params.token]);
    }
    res.json({ table: session.table_name, orders: rows.map(formatOrder) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/table-session/:token/info', async (req, res) => {
  try {
    const session = await getAsync('SELECT table_name, expires_at, store_id FROM scan_sessions WHERE token=?', [req.params.token]);
    if (!session) return res.status(404).json({ error: '会话不存在' });
    if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: '会话已过期' });
    const qrTimeoutS2 = await getAsync("SELECT value FROM settings WHERE `key` = 'qr_session_timeout'");
    const qrTimeoutMins2 = parseInt(qrTimeoutS2?.value || '45', 10);
    let expiresAt2 = session.expires_at;
    if (qrTimeoutMins2 > 0) {
      expiresAt2 = new Date(Date.now() + qrTimeoutMins2 * 60 * 1000).toISOString();
      runAsync('UPDATE scan_sessions SET expires_at=? WHERE token=?', [expiresAt2, req.params.token]).catch(()=>{});
    }
    res.json({ table: session.table_name, storeId: session.store_id || 1, sessionToken: req.params.token, expiresAt: expiresAt2 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/public/table-session/:token', async (req, res) => {
  try {
    await runAsync('DELETE FROM scan_sessions WHERE token=?', [req.params.token]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 全局错误处理 ----------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API 接口不存在', path: req.path });
});

app.use((err, req, res, next) => {
  console.error('未处理的错误:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误', message: err.message });
});

// ============================================================
//  Socket.io 握手鉴权
// ============================================================
io.use(async (socket, next) => {
  try {
    const token = (socket.handshake.query.token || '').trim();
    const requestedStoreId = parseInt(socket.handshake.query.storeId, 10) || 1;

    // 无 token：视为顾客端，允许连接但只能进公共房间
    if (!token) {
      socket.data.role = 'public';
      socket.data.storeId = requestedStoreId;
      return next();
    }

    // 1) 服务员/后厨（共用 waiter_sessions）
    const waiterSession = await getAsync('SELECT waiter_id FROM waiter_sessions WHERE token=?', [token]);
    if (waiterSession) {
      const waiter = await getAsync('SELECT * FROM waiters WHERE id=? AND active=1', [waiterSession.waiter_id]);
      if (waiter) {
        socket.data.role = 'waiter';
        socket.data.storeId = waiter.store_id || 1;
        socket.data.waiterId = waiter.id;
        return next();
      }
    }

    // 2) 收银员
    const cashierSession = await getAsync('SELECT cashier_id, store_id FROM cashier_sessions WHERE token=?', [token]);
    if (cashierSession) {
      socket.data.role = 'cashier';
      socket.data.storeId = cashierSession.store_id || 1;
      socket.data.cashierId = cashierSession.cashier_id;
      return next();
    }

    // 3) 管理员
    const adminSession = await getAsync('SELECT admin_id FROM admin_sessions WHERE token=?', [token]);
    if (adminSession) {
      const admin = await getAsync('SELECT * FROM merchant_admins WHERE id=? AND active=1', [adminSession.admin_id]);
      if (admin) {
        socket.data.role = 'admin';
        socket.data.adminId = admin.id;
        socket.data.merchantId = admin.merchant_id;
        const storeCheck = await getAsync('SELECT id FROM stores WHERE id=? AND merchant_id=?', [requestedStoreId, admin.merchant_id]);
        if (storeCheck) {
          socket.data.storeId = requestedStoreId;
        } else {
          const firstStore = await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [admin.merchant_id]);
          socket.data.storeId = firstStore?.id || 1;
        }
        return next();
      }
    }

    // 有 token 但查不到对应会话
    return next(new Error('unauthorized: token invalid or expired'));
  } catch (e) {
    console.error('[socket] auth error:', e);
    return next(new Error('auth failed'));
  }
});

io.on('connection', (socket) => {
  const { role, storeId } = socket.data;
  console.log(`[socket] connected role=${role} store=${storeId} id=${socket.id}`);

  if (role === 'waiter') {
    socket.join('waiter-' + storeId);
    socket.join('kitchen-' + storeId);
  } else if (role === 'cashier') {
    socket.join('cashier-' + storeId);
  } else if (role === 'admin') {
    socket.join('waiter-' + storeId);
    socket.join('kitchen-' + storeId);
    socket.join('cashier-' + storeId);
  } else if (role === 'public') {
    socket.join('public-store-' + storeId);
  }

  socket.on('disconnect', () => { /* 可选日志 */ });
});

// ---------- 启动 ----------
const isInitOnly = process.argv.includes('--init-only');

initDatabase().then(async () => {
  if (isInitOnly) {
    process.exit(0);
  }
  await initRedis();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`📁 数据库: MySQL (${poolConfig.database})`);
    if (RUN_SCHEDULED_TASKS) {
      console.log('⏰ 定时任务已启用（自动备份、日志清理）');
      maybeAutoBackup().catch(err => console.error('自动备份失败:', err.message));
      setInterval(() => {
        maybeAutoBackup().catch(err => console.error('自动备份失败:', err.message));
      }, 5 * 60 * 1000);
      autoCleanLogs().catch(err => console.error('日志清理失败:', err.message));
      setInterval(() => {
        autoCleanLogs().catch(err => console.error('日志清理失败:', err.message));
      }, 24 * 60 * 60 * 1000);
    } else {
      console.log('⏭️ 定时任务未启用（设置 RUN_SCHEDULED_TASKS=true 启用）');
    }
  });
}).catch(err => {
  console.error('❌ 数据库初始化失败:', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => pool.end().then(() => process.exit(0)));
}

process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});
