const express = require('express');
const { resolveListenHost } = require('./server/config/listen-host');
const { getClusterStartupError } = require('./server/config/cluster-requirements');
const { createRequestBodyParsers } = require('./server/middleware/request-body-parsers');
const { createSafeErrorHandler } = require('./server/middleware/safe-error-handler');
// ★ 关键：pool / helpers / constants 必须在文件顶部 require（TDZ 问题）
const poolModule = require('./server/db/pool');
const { poolConfig, setPool } = poolModule;
const { runAsync, getAsync, allAsync, withTransaction } = require('./server/db/helpers');
const { createLoginRateLimiter } = require('./server/services/login-rate-limit');
const { createScanSessionRateLimiter } = require('./server/services/scan-session-rate-limit');
const { createCooldownChecker } = require('./server/services/cooldown');
const { migrateSessionTokenStorage } = require('./server/services/session-token');
const { ensureSuperAdminActiveSchema } = require('./server/db/migrations/super-admin-active');
const { ensureFinancialMonthCloseSchema, ensureFinancialExceptionWorkflowSchema } = require('./server/db/migrations/financial-month-close');
const { ensureFinancialExceptionAlertSchema } = require('./server/db/migrations/financial-exception-alerts');
const { ensureFinancialReconciliationQueueIndex } = require('./server/db/migrations/financial-reconciliation-queue-index');
const { ensureProviderEventQueueIndexes } = require('./server/db/migrations/provider-event-queue-indexes');
const { isLoginLocked, recordLoginAttempt, resetLoginAttempts, cancelLoginAttempt } = createLoginRateLimiter({ getAsync, runAsync, withTransaction });
const scanSessionRateLimiter = createScanSessionRateLimiter({ getAsync, runAsync, withTransaction });
const { formatGlobalDateTime, formatGlobalTime } = require('./server/config/constants');
const { initMerchantSettings, initStoreSettings } = require('./server/services/settings-init');
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
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

// Minimal readiness endpoint used by the installer and operators.
// It reports only application/database availability and never exposes credentials or internals.
require('./routes/health.js')(app, { getPool: () => poolModule.pool });
const corsOrigins = new Set((process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean));

// Socket.IO: same-host requests are allowed; cross-origin browser clients must be explicitly allowlisted.
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, !origin || corsOrigins.has(origin)),
    credentials: false
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    if (corsOrigins.has(origin)) return callback(null, true);
    try {
      const parsed = new URL(origin);
      const requestHost = String(req.headers.host || '').toLowerCase();
      const sameHost = parsed.host.toLowerCase() === requestHost &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:');
      return callback(sameHost ? null : 'origin not allowed', sameHost);
    } catch (_) {
      return callback('invalid origin', false);
    }
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = Number(process.env.PORT || 3000);
const LISTEN_HOST = resolveListenHost(process.env.HOST);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const RUN_SCHEDULED_TASKS = process.env.RUN_SCHEDULED_TASKS === 'true';
const REDIS_URL = process.env.REDIS_URL || null;

// ===== Redis 缓存层 =====
let redisClient = null;
let redisReady = false;
let socketRedisPub = null;
let socketRedisSub = null;
async function initRedis() {
  if (!REDIS_URL) return false;
  if (!redis) {
    console.error('❌ REDIS_URL 已配置，但 redis 客户端依赖不可用；为避免多节点限流失效，将拒绝依赖 Redis 的操作');
    return false;
  }

  let client = null;
  try {
    client = redis.createClient({ url: REDIS_URL });
    client.on('error', err => console.error('Redis连接错误:', err.message));
    await client.connect();
    redisClient = client;
    redisReady = true;
    try {
      const state = require('./server/db/redis-state');
      state.client = client;
      state.ready = true;
    } catch (_) {}
    console.log('✅ Redis缓存已连接');
    return true;
  } catch (error) {
    await Promise.resolve(closeRedisClient(client)).catch(closeError => {
      console.error('Redis连接失败后的资源清理失败:', closeError.message);
    });
    redisClient = null;
    redisReady = false;
    try {
      const state = require('./server/db/redis-state');
      state.client = null;
      state.ready = false;
    } catch (_) {}
    console.error('❌ Redis配置存在但连接失败；已关闭残留客户端，依赖Redis的请求将安全失败:', error.message);
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
  async setIfAbsent(key, value, ttlSeconds) {
    if (REDIS_URL) {
      // A configured Redis instance is authoritative for cross-node cooldowns.
      // Fail closed while it is unavailable; per-process memory fallback would
      // allow duplicate submissions across application nodes.
      if (!redisReady || !redisClient || redisClient.isReady === false) return null;
      try {
        const result = await redisClient.set(key, JSON.stringify(value), {
          NX: true,
          ...(ttlSeconds > 0 ? { EX: ttlSeconds } : {})
        });
        return result === 'OK';
      } catch (error) {
        console.error('Redis cooldown acquisition failed:', error.message);
        return null;
      }
    }
    if (memoryCache.get(key) !== undefined && memoryCache.get(key) !== null) return false;
    memoryCache.set(key, value, ttlSeconds);
    return true;
  },
  async del(key) {
    if (redisReady) await redisClient.del(key);
    else memoryCache.delete(key);
  }
};
const checkAndSetCooldown = createCooldownChecker(cache);

// ---------- 模块化引入（从 server/services 引入） ----------
const { getClientIp, getLocationByIp } = require('./server/services/geo');
const { hashPassword, verifyPassword } = require('./server/middleware/password');
const {
  EscPosBuilder,
  buildReceipt,
  buildBatchReceipt,
  buildKitchenTicket,
  printToNetworkPrinter,
  dispatchPrint,
} = require('./server/services/printer');

const {
  formatOrder,
  normalizeOrderItems,
  assertTableExists,
  verifyLegacyAdminPassword,
} = require('./server/services/order');
const { allocateOrderNo, getOrderCooldownMs } = require('./server/services/orderNo');
const { closeRedisClient, createGracefulShutdown } = require('./server/services/graceful-shutdown');


const {
  collectBackupData,
  autoBackupDatabase,
  maybeAutoBackup,
  autoCleanLogs,
} = require('./server/services/backup');

const {
  getWaiterFromRequest,
  getCashierFromRequest,
  authenticateAdmin,
  requireAdminKey,
  requirePermission,
  logAudit,
  logAuditStrict,
  requireAdminOrWaiter,
} = require('./server/middleware/admin-auth');
const { requireSuperAdmin, requireCashier, requireAdminOrCashier, requireAdminOrCashierOrWaiter } = require('./server/middleware/auth');
const { createSocketAuthenticator, scheduleSocketRevalidation } = require('./server/middleware/socket-auth');

// ---------- 获取真实客户端IP ----------
// ---------- IP地理位置查询 ----------
// ---------- 中间件 ----------
app.use(cors({
  origin: (origin, callback) => {
    // Same-origin and non-browser clients do not need CORS headers.
    if (!origin || corsOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: false
}));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Prevent bearer credentials in legacy URLs from leaking through same-origin Referer headers.
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(...createRequestBodyParsers(express));
// 静态资源：协商缓存（文件没变 304，变了 200 拿新版）
// 不设 max-age，让浏览器每次都问服务器，改动即生效，不需要改文件名或版本号
const staticOptions = {
  dotfiles: 'deny',
  index: false,
  // 协商缓存：浏览器每次都带 If-None-Match 问服务器，
  // 文件没变 → 304（极省流量），文件变了 → 200 + 新内容
  // 好处：改完 JS/CSS 不用手动改 ?v=，硬刷新即生效
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
};
app.use('/assets', express.static(path.join(__dirname, 'assets'), staticOptions));
app.use('/pages', express.static(path.join(__dirname, 'pages'), staticOptions));
// uploads 保留长缓存（图片内容一般不变，改了就是新文件名）
app.use('/uploads', express.static(UPLOAD_DIR, {
  dotfiles: 'deny',
  index: false,
  // 协商缓存：文件名带时间戳时天然就是新文件，
  // 文件名不变的内容（如同一张图）走 304，一致且省流量
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

app.get('/languages.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'languages.js'));
});
app.get('/languages.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'languages.min.js'));
});

// PWA manifest（根目录文件，不在 /assets 里）
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Service Worker（必须和 HTML 同源，且不能被 CDN/代理缓存）
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'service-worker.js'));
});

// i18n 按需加载
const i18nCache = {};
// ----- 页面路由+i18n+qr-print -----
require('./routes/pages.js')(app, { getAsync, path, fs, QRCode, __dirname, requireAdminKey, requirePermission });


// ---------- 文件上传 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 5,
    fields: 100,
    parts: 120,
    fieldNameSize: 100,
    fieldSize: 1024 * 1024,
    headerPairs: 2000
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const imageMimes = {
      '.jpg': ['image/jpeg'],
      '.jpeg': ['image/jpeg'],
      '.png': ['image/png'],
      '.gif': ['image/gif'],
      '.webp': ['image/webp']
    };
    const videoMimes = {
      '.mp4': ['video/mp4', 'application/octet-stream'],
      '.webm': ['video/webm', 'application/octet-stream'],
      '.ogg': ['video/ogg', 'application/ogg'],
      '.mov': ['video/quicktime', 'application/octet-stream']
    };
    if (ext === '.zip') {
      if (['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(file.mimetype)) return cb(null, true);
      return cb(new Error('ZIP 文件 MIME 类型不正确'));
    }
    if (imageMimes[ext]?.includes(file.mimetype)) return cb(null, true);
    if (videoMimes[ext]?.includes(file.mimetype)) return cb(null, true);
    cb(new Error('不支持的文件格式或 MIME 类型不匹配'));
  }
});

// ---------- MySQL 连接池 + 数据库辅助函数已统一从 server/db/ 引入（见文件顶部）----------
// 保证 server.js / routes / middleware / services 共享同一个 pool 和 transactionStorage

// ---------- 常量 ----------
const createTableToken = () => crypto.randomBytes(12).toString('base64url');

// Login-attempt lifecycle is implemented by the database-backed limiter above.

// ============================================================
//  默认凭据集中定义 + 首次初始化凭据文件
// ============================================================
// Initial passwords are generated per first boot unless explicitly injected by the operator.
// They are written once to a mode-0600 file; never ship predictable production defaults.
const generateInitialPassword = () => crypto.randomBytes(24).toString('base64url');
const DEFAULT_CREDENTIALS = {
  superAdmin: {
    username: process.env.INIT_SUPER_USERNAME || 'superadmin',
    password: process.env.INIT_SUPER_PASSWORD || generateInitialPassword(),
    displayName: '超级管理员',
  },
  merchantAdmin: {
    username: process.env.INIT_ADMIN_USERNAME || 'admin',
    password: process.env.INIT_ADMIN_PASSWORD || generateInitialPassword(),
    displayName: 'FoodFlow管理员',
  },
  waiter: {
    username: process.env.INIT_WAITER_USERNAME || 'waiter',
    password: process.env.INIT_WAITER_PASSWORD || generateInitialPassword(),
    displayName: '服务员A',
  },
  cashier: {
    username: process.env.INIT_CASHIER_USERNAME || 'cashier',
    password: process.env.INIT_CASHIER_PASSWORD || generateInitialPassword(),
    displayName: '收银员',
  },
};

async function writeInitialCredentialsFile(credentials) {
  const file = process.env.INIT_CRED_FILE || '/var/lib/foodflow/initial-credentials.txt';
  const tempFile = file + '.tmp-' + process.pid;
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const merged = new Map();
    try {
      const existing = await fs.promises.readFile(file, 'utf8');
      for (const line of existing.split(/\r?\n/)) {
        const match = line.match(/^([^:]+):\s+(\S+)\s+\/\s+(.+)$/);
        if (match) merged.set(match[1], { username: match[2], password: match[3] });
      }
    } catch (readError) {
      if (readError.code !== 'ENOENT') throw readError;
    }
    for (const [role, value] of Object.entries(credentials)) merged.set(role, value);
    const content = Array.from(merged.entries())
      .map(([role, value]) => `${role}: ${value.username} / ${value.password}`)
      .join('\n') + '\n';
    await fs.promises.writeFile(tempFile, content, { mode: 0o600, flag: 'wx' });
    await fs.promises.chmod(tempFile, 0o600);
    await fs.promises.rename(tempFile, file);
    await fs.promises.chmod(file, 0o600);
    console.log(`  + 初始凭据已安全写入 ${file}（权限 600）`);
  } catch (e) {
    try { await fs.promises.unlink(tempFile); } catch (_) {}
    console.warn(`  ! 无法写入凭据文件 ${file}: ${e.message}（不影响服务启动）`);
  }
}

// ============================================================
//  订单号分配 → 已统一从 server/services/orderNo.js 引入（见文件顶部）
//  这样 allocateOrderNo 内部的 FOR UPDATE 才能使用同一个事务上下文
// ============================================================

// ---------- 数据库初始化 ----------
async function ensureOrderTables() {
  await runAsync(`
    CREATE TABLE IF NOT EXISTS login_rate_limits (
      login_type VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      username VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
      window_started_at DATETIME(3) NOT NULL,
      locked_until DATETIME(3) DEFAULT NULL,
      updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY (login_type, username),
      KEY idx_login_rate_locked (locked_until)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS login_rate_limit_attempts (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      login_type VARCHAR(50) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      username VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      state ENUM('pending','failed','succeeded','cancelled','expired') NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY (id),
      KEY idx_login_attempt_owner_state (login_type, username, state, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const missingTables = await allAsync(`
    SELECT DISTINCT o.table_name AS name, o.store_id AS store_id
    FROM orders o
    LEFT JOIN tables t ON t.name = o.table_name AND t.store_id = o.store_id
    WHERE t.id IS NULL
  `);
  for (const table of missingTables) {
    await runAsync(
      'INSERT INTO tables (name, status, store_id, merchant_id) VALUES (?, ?, ?, (SELECT merchant_id FROM stores WHERE id=?))',
      [table.name, 'available', table.store_id || 1, table.store_id || 1]
    );
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
    const probeConnection = await poolModule.pool.getConnection();
    probeConnection.release();
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
      const previousPool = poolModule.pool;
      setPool(mysql.createPool(poolConfig));
      await previousPool.end().catch(() => {});
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
      actor_id BIGINT,
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
    CREATE TABLE IF NOT EXISTS refund_requests (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      store_id INT NOT NULL,
      order_id INT NOT NULL,
      idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_hash CHAR(64) NOT NULL,
      response_json LONGTEXT DEFAULT NULL,
      cashier_username VARCHAR(100) DEFAULT '',
      created_at VARCHAR(50) NOT NULL,
      UNIQUE KEY unique_store_idempotency (store_id, idempotency_key),
      KEY idx_refund_order (store_id, order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Provider webhook inbox: persist event identity and a payload digest only.
  // Provider-specific authentication must be completed before an event can be marked verified.
  await runAsync(`
    CREATE TABLE IF NOT EXISTS provider_webhook_events (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      provider_code VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      provider_event_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      event_type VARCHAR(100) NOT NULL DEFAULT '',
      provider_transaction_id VARCHAR(191) DEFAULT '',
      payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      auth_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
      processing_status ENUM('received','processing','processed','failed') NOT NULL DEFAULT 'received',
      received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      processed_at DATETIME(3) DEFAULT NULL,
      last_error_code VARCHAR(64) DEFAULT NULL,
      UNIQUE KEY unique_provider_event (provider_code, provider_event_id),
      KEY idx_provider_event_store (merchant_id, store_id, received_at),
      KEY idx_provider_event_status (processing_status, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Backward-compatible queue columns for existing provider inbox tables.
  const providerEventColumns = await allAsync('SHOW COLUMNS FROM provider_webhook_events');
  const providerEventColumnNames = providerEventColumns.map(column => column.Field);
  const providerEventMigrations = [
    ['normalized_event_json', 'JSON DEFAULT NULL'],
    ['attempt_count', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['max_attempts', 'INT UNSIGNED NOT NULL DEFAULT 8'],
    ['next_attempt_at', 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)'],
    ['lease_token', 'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL'],
    ['lease_expires_at', 'DATETIME(3) DEFAULT NULL']
  ];
  for (const [column, definition] of providerEventMigrations) {
    if (!providerEventColumnNames.includes(column)) {
      await runAsync(`ALTER TABLE provider_webhook_events ADD COLUMN ${column} ${definition}`);
    }
  }

  // Keep the two queue claim paths indexed on both fresh and upgraded installations.
  await ensureProviderEventQueueIndexes({ runAsync, allAsync });

  // Append-only journal header and balanced debit/credit lines.
  // No existing order/refund totals are backfilled or rewritten by this foundation.
  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_journal_transactions (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      source_type VARCHAR(40) NOT NULL,
      source_id VARCHAR(128) NOT NULL,
      idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      created_by VARCHAR(100) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_journal_idempotency (merchant_id, store_id, idempotency_key),
      KEY idx_journal_source (merchant_id, store_id, source_type, source_id),
      KEY idx_journal_created (merchant_id, store_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_journal_entries (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      transaction_id BIGINT NOT NULL,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      line_no SMALLINT UNSIGNED NOT NULL,
      account_code VARCHAR(64) NOT NULL,
      direction ENUM('debit','credit') NOT NULL,
      amount_minor BIGINT UNSIGNED NOT NULL,
      memo VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_journal_line (transaction_id, line_no),
      KEY idx_journal_account (merchant_id, store_id, account_code, created_at),
      CONSTRAINT fk_journal_entry_transaction FOREIGN KEY (transaction_id)
        REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Provider-neutral, immutable statement import and reconciliation audit foundation.
  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_reconciliation_batches (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      provider_code VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      external_batch_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      statement_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      row_count INT UNSIGNED NOT NULL,
      total_debit_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
      total_credit_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
      status ENUM('imported','validated','closed') NOT NULL DEFAULT 'imported',
      imported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      validated_at DATETIME(3) DEFAULT NULL,
      closed_at DATETIME(3) DEFAULT NULL,
      UNIQUE KEY unique_reconciliation_batch (merchant_id, store_id, provider_code, external_batch_id),
      KEY idx_reconciliation_batch_status (merchant_id, store_id, status, imported_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_reconciliation_items (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      batch_id BIGINT NOT NULL,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      row_no INT UNSIGNED NOT NULL,
      external_reference VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      transaction_reference VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
      direction ENUM('debit','credit') NOT NULL,
      amount_minor BIGINT UNSIGNED NOT NULL,
      currency_code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      occurred_at DATETIME(3) NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      row_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      match_status ENUM('pending','matched','unmatched','ambiguous','exception') NOT NULL DEFAULT 'pending',
      match_reason VARCHAR(128) DEFAULT NULL,
      matched_journal_transaction_id BIGINT DEFAULT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_reconciliation_row (batch_id, row_no),
      KEY idx_reconciliation_external_ref (merchant_id, store_id, external_reference),
      KEY idx_reconciliation_match_status (batch_id, match_status),
      KEY idx_reconciliation_journal (matched_journal_transaction_id),
      CONSTRAINT fk_reconciliation_item_batch FOREIGN KEY (batch_id)
        REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT,
      CONSTRAINT fk_reconciliation_item_journal FOREIGN KEY (matched_journal_transaction_id)
        REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);


  // Fail closed if legacy rows already violate one-to-one journal assignment.
  const duplicateJournalAssignment = await getAsync(
    'SELECT matched_journal_transaction_id, COUNT(*) AS assignment_count FROM financial_reconciliation_items WHERE matched_journal_transaction_id IS NOT NULL GROUP BY matched_journal_transaction_id HAVING COUNT(*) > 1 LIMIT 1'
  );
  if (duplicateJournalAssignment) {
    throw new Error('financial reconciliation has duplicate journal assignments; resolve them before enabling finance review');
  }
  const reconciliationItemColumns = await allAsync('SHOW COLUMNS FROM financial_reconciliation_items');
  const reconciliationItemColumnNames = reconciliationItemColumns.map(column => column.Field);
  if (!reconciliationItemColumnNames.includes('exception_category')) {
    await runAsync("ALTER TABLE financial_reconciliation_items ADD COLUMN exception_category ENUM('refund','fee','settlement_difference','chargeback','other') DEFAULT NULL");
  }
  if (!reconciliationItemColumnNames.includes('exception_note')) {
    await runAsync('ALTER TABLE financial_reconciliation_items ADD COLUMN exception_note VARCHAR(500) DEFAULT NULL');
  }
  const reconciliationItemIndexes = await allAsync('SHOW INDEX FROM financial_reconciliation_items');
  if (!reconciliationItemIndexes.some(index => index.Key_name === 'unique_reconciliation_journal_assignment')) {
    await runAsync('CREATE UNIQUE INDEX unique_reconciliation_journal_assignment ON financial_reconciliation_items (matched_journal_transaction_id)');
  }

  // Add the tenant-scoped cursor index through an explicit, legacy-safe migration.
  await ensureFinancialReconciliationQueueIndex({ runAsync, allAsync });

  await runAsync(`
    CREATE TABLE IF NOT EXISTS financial_reconciliation_review_events (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      merchant_id INT NOT NULL,
      store_id INT NOT NULL,
      batch_id BIGINT NOT NULL,
      item_id BIGINT NOT NULL,
      journal_transaction_id BIGINT DEFAULT NULL,
      exception_category ENUM('refund','fee','settlement_difference','chargeback','other') DEFAULT NULL,
      actor_admin_id INT NOT NULL,
      actor_username VARCHAR(100) NOT NULL,
      action ENUM('confirm','reject','release','reassign','classify_exception') NOT NULL,
      reason VARCHAR(500) NOT NULL,
      idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      before_json JSON NOT NULL,
      after_json JSON NOT NULL,
      previous_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
      event_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY unique_finance_review_idempotency (merchant_id, store_id, batch_id, idempotency_key),
      KEY idx_finance_review_batch_chain (batch_id, id),
      KEY idx_finance_review_item_history (item_id, id),
      KEY idx_finance_review_actor (merchant_id, store_id, actor_admin_id, created_at),
      CONSTRAINT fk_finance_review_batch FOREIGN KEY (batch_id)
        REFERENCES financial_reconciliation_batches(id) ON DELETE RESTRICT,
      CONSTRAINT fk_finance_review_item FOREIGN KEY (item_id)
        REFERENCES financial_reconciliation_items(id) ON DELETE RESTRICT,
      CONSTRAINT fk_finance_review_journal FOREIGN KEY (journal_transaction_id)
        REFERENCES financial_journal_transactions(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureFinancialMonthCloseSchema({ runAsync, allAsync });
  await ensureFinancialExceptionWorkflowSchema({ runAsync, allAsync });
  await ensureFinancialExceptionAlertSchema({ runAsync, allAsync });

  await runAsync(`
    CREATE TABLE IF NOT EXISTS scan_sessions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      table_name VARCHAR(50) NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      expires_at VARCHAR(50) NOT NULL,
      created_at VARCHAR(50) NOT NULL,
      store_id INT NOT NULL DEFAULT 1,
      KEY idx_scan_sessions_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Shared per-IP scan-session throttling works across every application instance.
  // Only a one-way IP digest is persisted; stale counters are periodically pruned.
  await runAsync(`
    CREATE TABLE IF NOT EXISTS scan_session_rate_limits (
      ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      window_started_at DATETIME(3) NOT NULL,
      request_count INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_scan_session_rate_limits_window (window_started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const scanSessionExpiryIndexes = await allAsync('SHOW INDEX FROM scan_sessions');
  if (!scanSessionExpiryIndexes.some(index => index.Key_name === 'idx_scan_sessions_expires')) {
    await runAsync('CREATE INDEX idx_scan_sessions_expires ON scan_sessions (expires_at)');
  }

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
      settled_at VARCHAR(50) DEFAULT NULL,
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
    await runAsync('ALTER TABLE menus ADD COLUMN video VARCHAR(255) DEFAULT NULL');
  } catch (e) { if (!/duplicate column/i.test(e.message || '')) console.log('  ! menus.video:', e.message); }
  try {
    await runAsync('ALTER TABLE orders ADD COLUMN refund_amount DECIMAL(10,2) DEFAULT NULL');
  } catch (e) { if (!/duplicate column/i.test(e.message || '')) console.log('  ! refund_amount:', e.message); }
  try {
    await runAsync(`ALTER TABLE orders ADD COLUMN customer_token VARCHAR(255) DEFAULT ''`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message || '')) console.log('  ! customer_token:', e.message);
  }

  // ===== orders 支付/退款字段补全迁移（幂等）=====
  const ordersPaymentColumns = [
    ['order_no',          'VARCHAR(20) DEFAULT NULL'],
    ['settled_at',        'VARCHAR(50) DEFAULT NULL'],
    ['pay_method',        "VARCHAR(20) DEFAULT ''"],
    ['cash_received',     'DECIMAL(10,2) DEFAULT 0'],
    ['cash_change',       'DECIMAL(10,2) DEFAULT 0'],
    ['awaiting_confirm',  'TINYINT NOT NULL DEFAULT 0'],
    ['pay_khqr_ref',      "VARCHAR(255) DEFAULT ''"],
    ['pay_expires_at',    "VARCHAR(50) DEFAULT ''"],
    ['pay_qr_generation_id', "VARCHAR(64) DEFAULT ''"],
    ['paid_confirmed_by', "VARCHAR(100) DEFAULT ''"],
    ['refund_amount',     'DECIMAL(10,2) DEFAULT NULL'],
    ['refund_reason',     "VARCHAR(100) DEFAULT ''"],
    ['refund_note',       "VARCHAR(200) DEFAULT ''"],
    ['refunded_at',       "VARCHAR(50) DEFAULT ''"],
    ['refunded_by',       "VARCHAR(100) DEFAULT ''"],
  ];
  for (const [col, def] of ordersPaymentColumns) {
    try { await runAsync(`ALTER TABLE orders ADD COLUMN ${col} ${def}`); }
    catch (e) { if (!/duplicate column/i.test(e.message || '')) console.log(`  ! orders.${col}: ${e.message}`); }
  }

  // Give legacy active QR payloads a stable per-generation ownership token.
  await runAsync("UPDATE orders SET pay_qr_generation_id=SHA2(CONCAT(id, ':', COALESCE(pay_khqr_ref, ''), ':', COALESCE(pay_expires_at, ''), ':', UUID()), 256) WHERE pay_khqr_ref<>'' AND (pay_qr_generation_id IS NULL OR pay_qr_generation_id='')");
  try {
    await runAsync('ALTER TABLE orders ADD UNIQUE INDEX idx_order_no (order_no)');
  } catch (e) {
    if (!/duplicate key|Duplicate key name/i.test(e.message || '')) console.log('  ! idx_order_no:', e.message);
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

  // Persist only SHA-256 digests for bearer sessions. Existing raw tokens are
  // backfilled before the legacy token columns are cleared, preserving live sessions.
  await migrateSessionTokenStorage({ runAsync, allAsync, withTransaction });

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
      country VARCHAR(4) NOT NULL DEFAULT '',
      max_stores INT NOT NULL DEFAULT 1,
      status TINYINT NOT NULL DEFAULT 1,
      expire_date DATE,
      settings JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ★ 兼容旧库：merchants.country 字段迁移（幂等）
  try {
    await runAsync("ALTER TABLE merchants ADD COLUMN country VARCHAR(4) NOT NULL DEFAULT ''");
    console.log('  + 迁移 merchants: 添加 country 字段');
  } catch (e) {
    if (!/duplicate column/i.test(e.message || '')) console.log('  ! merchants.country:', e.message);
  }

  await runAsync(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      must_change_password TINYINT NOT NULL DEFAULT 0,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Upgrade legacy databases before any login/authentication query relies on active.
  await ensureSuperAdminActiveSchema({ allAsync, runAsync, logger: console });

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

  // Existing accounts keep current credentials; only a newly bootstrapped
  // super-admin is marked for mandatory first-login password rotation.
  try {
    await runAsync('ALTER TABLE super_admins ADD COLUMN must_change_password TINYINT NOT NULL DEFAULT 0');
  } catch (e) {
    if (!/duplicate column/i.test(e.message || '')) throw e;
  }

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

  // Finance reconciliation is sensitive and opt-in for non-primary administrators.
  try {
    await runAsync('ALTER TABLE merchant_admins ADD COLUMN can_manage_financial_reconciliation TINYINT NOT NULL DEFAULT 0');
  } catch (e) {
    if (!/duplicate column/i.test(e.message || '')) console.log('  ! merchant_admins.can_manage_financial_reconciliation:', e.message);
  }

  // ===== 初始化基础数据 =====
  const initialCredentials = {};

  // 超级管理员
  const superAdminCount = await getAsync('SELECT COUNT(*) AS count FROM super_admins');
  if (superAdminCount.count === 0) {
    const c = DEFAULT_CREDENTIALS.superAdmin;
    const superHash = hashPassword(c.password);
    await runAsync(
      "INSERT INTO super_admins (username, password_hash, display_name, must_change_password) VALUES (?, ?, ?, 1)",
      [c.username, superHash, c.displayName]
    );
    console.log(`  + 已创建超级管理员：${c.username}（密码已写入受保护的初始凭据文件）`);
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
    console.log(`  + 已创建商户管理员：${ac.username}（密码已写入受保护的初始凭据文件）`);
    initialCredentials.merchantAdmin = ac;

    // 默认店铺
    await runAsync("INSERT INTO stores (merchant_id, name, code, address, active) VALUES (?, ?, ?, ?, 1)",
      [defaultMerchantId, 'FoodFlow总店', 'ff-main', '']);
    const defaultStoreId = (await getAsync('SELECT id FROM stores WHERE merchant_id=? ORDER BY id ASC LIMIT 1', [defaultMerchantId])).id;
    console.log('  + 已创建默认店铺：FoodFlow总店 (id=' + defaultStoreId + ')');
    // ★ 初始化默认商户/门店的 settings
    await initMerchantSettings(runAsync, defaultMerchantId);
    await initStoreSettings(runAsync, defaultStoreId);
    console.log('  + 已初始化商户级/门店级默认 settings');

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
      await runAsync('INSERT INTO menu_categories (name, sort, store_id, merchant_id) VALUES (?, ?, ?, ?)', [catName, sort, defaultStoreId, defaultMerchantId]);
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
      await runAsync('INSERT INTO menus (name, emoji, price, category, `desc`, unit, active, store_id, currency_code, merchant_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [name, emoji, price, category, desc, unit, defaultStoreId, 'USD', defaultMerchantId]);
    }
    console.log('  + 已创建默认菜品：10道示例菜品');

    // 默认桌号
    const defaultTables = ['A01', 'A02', 'A03', 'A04', 'A05', 'B01', 'B02', 'B03', 'B04', 'B05'];
    for (const tableName of defaultTables) {
      await runAsync('INSERT INTO tables (name, status, store_id, merchant_id) VALUES (?, ?, ?, ?)', [tableName, 'available', defaultStoreId, defaultMerchantId]);
    }
    console.log('  + 已创建默认桌号：A01-A05, B01-B05');

    // 默认服务员
    const wc = DEFAULT_CREDENTIALS.waiter;
    const waiterHash = hashPassword(wc.password);
    await runAsync(
      'INSERT INTO waiters (username, password_hash, display_name, can_order, can_mark_item, can_complete_order, active, store_id, merchant_id) VALUES (?, ?, ?, 1, 1, 1, 1, ?, ?)',
      [wc.username, waiterHash, wc.displayName, defaultStoreId, defaultMerchantId]
    );
    console.log(`  + 已创建默认服务员：${wc.username}（密码已写入受保护的初始凭据文件）`);
    initialCredentials.waiter = wc;

    // 说明：默认收银员不再预置。
    // cashier_sessions 只存登录 session，收银员账号本身存在 settings 表的
    // cashiers_<storeId> JSON 中，由管理员在后台「收银员管理」添加。
  }

  // 迁移：qr_languages（使用统一 DB helper；server.js 不存在独立的 pool 变量）
  await require('./server/db/migrations/store-qr-languages').ensureStoreQrLanguagesSchema({
    allAsync,
    runAsync,
    logger: console
  });

  // 全局设置默认值
  const backupInterval = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
  if (!backupInterval) await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_interval_hours', '24')");
  const backupRetention = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_retention_days'");
  if (!backupRetention) await runAsync("INSERT INTO settings (`key`, value) VALUES ('backup_retention_days', '30')");
  const dualCurrency = await getAsync("SELECT value FROM settings WHERE `key` = 'dual_currency_enabled'");
  if (!dualCurrency) await runAsync("INSERT INTO settings (`key`, value) VALUES ('dual_currency_enabled', '1')");
  const secondaryCurrency = await getAsync("SELECT value FROM settings WHERE `key` = 'secondary_currency_code'");
  if (!secondaryCurrency) await runAsync("INSERT INTO settings (`key`, value) VALUES ('secondary_currency_code', 'KHR')");
  else if (secondaryCurrency.value === 'CNY') await runAsync("UPDATE settings SET value='USD' WHERE `key`='secondary_currency_code'");
  const newOrderSound = await getAsync("SELECT value FROM settings WHERE `key` = 'new_order_sound_enabled'");
  if (!newOrderSound) await runAsync("INSERT INTO settings (`key`, value) VALUES ('new_order_sound_enabled', '1')");
  const adminPassword = await getAsync("SELECT value FROM settings WHERE `key` = 'admin_password'");
  if (!adminPassword) await runAsync("INSERT INTO settings (`key`, value) VALUES ('admin_password', ?)", [hashPassword(DEFAULT_CREDENTIALS.merchantAdmin.password)]);

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
    'max_order_note_length': '200',
    'order_no_reset_period': 'never',
    'admin_idle_timeout': '30',
    'cashier_idle_timeout': '30',
    'kitchen_idle_timeout': '30',
    'super_idle_timeout': '30',
    'waiter_session_timeout': '24',
    'cashier_session_timeout': '12',
    'clean_login_log': '0',
    'clean_audit_log': '0',
    'super_ip_whitelist': '',
    'admin_access_key': '',
    'admin_access_key_store_id': '1'
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
// ---------- 辅助函数 ----------
// ---------- 自动备份 ----------
// 自动清理日志（已修复字段名：login_logs.createdAt 是驼峰）
// ============================================================
//  路由
// ============================================================

// ----- 公开接口 -----

// ----- 公开接口 -----
require('./routes/display.js')(app, { allAsync, runAsync, requireAdminKey, requirePermission });
require('./routes/public.js')(app, { getAsync, allAsync, runAsync });


// ----- 商户管理员登录 -----
// ----- 管理员登录 -----
require('./routes/auth.js')(app, { getAsync, runAsync, isLoginLocked, recordLoginAttempt, resetLoginAttempts, cancelLoginAttempt, verifyPassword, getClientIp, getLocationByIp, requireAdminKey });


// ===== 超级管理员登录 =====
// ----- 超管路由 -----
require('./routes/super.js')(app, { getAsync, runAsync, allAsync, isLoginLocked, recordLoginAttempt, resetLoginAttempts, cancelLoginAttempt, verifyPassword, hashPassword, getClientIp, getLocationByIp, requireSuperAdmin, logAudit, logAuditStrict, collectBackupData, autoBackupDatabase, withTransaction });


// ----- 系统日志+登出+改密码 -----
require('./routes/admin-system.js')(app, { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, verifyPassword, hashPassword, logAudit, getClientIp });


// ----- 服务员登录 -----
// ----- 服务员+收银员 -----
require('./routes/cashier.js')(app, { getAsync, runAsync, allAsync, withTransaction, isLoginLocked, recordLoginAttempt, resetLoginAttempts, cancelLoginAttempt, verifyPassword, getClientIp, requireCashier, requireAdminOrCashierOrWaiter, formatOrder, syncTableStatus, buildBatchReceipt, buildReceipt, printToNetworkPrinter, dispatchPrint, io });


// ----- 服务员概览 -----
// ----- 订单核心路由 -----
require('./routes/menu-zip.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, upload, UPLOAD_DIR });
require('./routes/waiter-overview.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction });
require('./routes/waiters.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction });
require('./routes/stores.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction });
require('./routes/menu.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction });
require('./routes/tables.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction });
require('./routes/orders.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction });
require('./routes/calls.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, getWaiterFromRequest, formatOrder, normalizeOrderItems, assertTableExists, syncTableStatus, ensureOrderTables, io, getClientIp, logAudit, upload, UPLOAD_DIR, path, allocateOrderNo, getOrderCooldownMs, createTableToken, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, verifyPassword, authenticateAdmin, checkAndSetCooldown, withTransaction });

// ----- 订单打印 -----
// ----- 打印机+打印路由 -----
require('./routes/admin-printers.js')(app, { getAsync, allAsync, runAsync, requireAdminKey, requirePermission, requireAdminOrWaiter, formatOrder, buildReceipt, buildKitchenTicket, printToNetworkPrinter, dispatchPrint, EscPosBuilder, formatGlobalDateTime });


// ----- 数据导出 -----
// ----- 报表+导出 -----
const _advExport = require('./routes/admin-reports.js');
_advExport(app, { getAsync, allAsync, requireAdminKey, requirePermission, authenticateAdmin });
if (typeof _advExport.attachAdvancedExport === 'function') {
  _advExport.attachAdvancedExport(app, { getAsync, allAsync, requireAdminKey, requirePermission });
}

require('./routes/financial-reconciliation.js')(app, {
  runAsync, getAsync, allAsync, withTransaction, requireAdminKey, requirePermission
});


// ----- 全局配置+催单+管理员/收银员+重置 -----
require('./routes/admin-manage.js')(app, { getAsync, runAsync, allAsync, withTransaction, syncTableStatus, requireAdminKey, requirePermission, requireAdminOrCashier, requireAdminOrCashierOrWaiter, requireAdminOrWaiter, hashPassword, verifyPassword, logAudit, getClientIp, io });



// ----- 货币管理 -----
// ----- 货币+显示+通知设置 -----
require('./routes/admin-settings.js')(app, { getAsync, runAsync, allAsync, withTransaction, requireAdminKey, requirePermission });


// ----- 二维码 -----
// ----- 二维码+桌台session -----
require('./routes/public-session.js')(app, { getAsync, runAsync, allAsync, requireAdminKey, requirePermission, formatOrder, scanSessionRateLimiter });


// ---------- 全局错误处理 ----------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API 接口不存在', path: req.path });
});

app.use(createSafeErrorHandler({ logger: console }));

// ============================================================
//  Socket.io 握手鉴权
// ============================================================
const socketAuthenticator = createSocketAuthenticator({ getAsync, logger: console });
io.use(socketAuthenticator);
io.on('connection', (socket) => {
  // Re-check persisted session state while connected; disconnect immediately on
  // expiry, logout/revocation, account deactivation, or auth-store failure.
  scheduleSocketRevalidation(socket, socketAuthenticator);
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
    socket.join('public-table-' + storeId + '-' + socket.data.tableName);
  }

  socket.on('disconnect', () => { /* 可选日志 */ });
});

// ---------- 启动 ----------
const isInitOnly = process.argv.includes('--init-only');

async function initSocketAdapter() {
  if (!REDIS_URL || !redis) return false;
  let pub = null;
  let sub = null;
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    pub = redis.createClient({ url: REDIS_URL });
    sub = pub.duplicate();
    pub.on('error', error => console.error('Socket.IO Redis publisher error:', error.message));
    sub.on('error', error => console.error('Socket.IO Redis subscriber error:', error.message));
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
    socketRedisPub = pub;
    socketRedisSub = sub;
    console.log('✅ Socket.io Redis Adapter 已启用');
    return true;
  } catch (error) {
    await Promise.allSettled([closeRedisClient(pub), closeRedisClient(sub)]);
    socketRedisPub = null;
    socketRedisSub = null;
    console.warn('⚠️ Socket.io Adapter 初始化失败，已清理连接:', error.message);
    return false;
  }
}

// ★ 启动时检查图标是否齐全（有缺失只告警，不阻断）
(async () => {
  try {
    const { findMissing } = require('./server/services/icon-resolver');
    const { BANKS } = require('./server/config/khqr-banks');
    const { VIETQR_BANKS } = require('./server/config/vietqr-banks');
    const configured = [
      ...BANKS.map(b => b.icon),
      ...Object.values(VIETQR_BANKS).map(b => b.icon),
      'KHQR.png',
    ];
    const missing = findMissing(configured);
    if (missing.length) {
      console.warn('⚠️  以下银行专属图标缺失，前端将使用通用 KHQR 图标：');
      missing.forEach(m => console.warn('   - assets/vendor/payment-icons/' + m));
    } else {
      console.log('✅ 所有配置的银行图标都齐全');
    }
  } catch (e) {
    console.warn('[icon-check] 启动检查失败:', e.message);
  }
})();

initDatabase().then(async () => {
  if (isInitOnly) {
    process.exit(0);
  }
  const redisInitialized = await initRedis();
  const socketAdapterInitialized = await initSocketAdapter();
  const clusterStartupError = getClusterStartupError({
    requireSharedRedis: process.env.REQUIRE_SHARED_REDIS,
    redisUrl: REDIS_URL,
    trustProxy: process.env.TRUST_PROXY,
    redisReady: redisInitialized,
    socketAdapterReady: socketAdapterInitialized
  });
  if (clusterStartupError) {
    console.error('[startup] Cluster deployment configuration rejected: ' + clusterStartupError);
    await poolModule.pool.end().catch(() => {});
    process.exit(1);
    return;
  }
  server.listen(PORT, LISTEN_HOST, () => {
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
      // KHQR 动态码过期清理：每 60 秒扫一次，清掉超过 15 分钟还未支付的 pending 订单
      setInterval(async () => {
        try {
          const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
          const result = await runAsync(
            "UPDATE orders SET pay_khqr_ref='', pay_expires_at='', pay_qr_generation_id='' " +
            "WHERE status='pending' AND awaiting_confirm=0 " +
            "AND pay_expires_at != '' AND pay_expires_at < ?",
            [cutoff]
          );
          if (result.changes > 0) {
            console.log('[cleanup] 清理了', result.changes, '个过期 KHQR 码');
          }
        } catch (e) {
          console.error('[cleanup] 过期清理失败:', e.message);
        }
      }, 60 * 1000);
    } else {
      console.log('⏭️ 定时任务未启用（设置 RUN_SCHEDULED_TASKS=true 启用）');
    }
  });
}).catch(err => {
  console.error('❌ 数据库初始化失败:', err);
  process.exit(1);
});

const shutdown = createGracefulShutdown({
  io,
  pool: { end: () => poolModule.pool.end() },
  getRedisClients: () => [redisClient, socketRedisPub, socketRedisSub],
  logger: console
});

function exitAfterShutdown(reason, exitCode) {
  shutdown(reason, exitCode)
    .catch(error => console.error('[shutdown] Fatal cleanup error:', error))
    .finally(() => process.exit(exitCode));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => exitAfterShutdown(signal, 0));
}

process.on('uncaughtException', error => {
  console.error('未捕获的异常，正在安全关闭服务:', error);
  exitAfterShutdown('uncaughtException', 1);
});

process.on('unhandledRejection', reason => {
  console.error('未处理的 Promise 拒绝，正在安全关闭服务:', reason);
  exitAfterShutdown('unhandledRejection', 1);
});
