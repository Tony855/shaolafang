/* ============================================================
   server/config/env.js — 环境变量加载
   ============================================================ */
const path = require('path');
const fs = require('fs');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
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

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'),
  RUN_SCHEDULED_TASKS: process.env.RUN_SCHEDULED_TASKS === 'true',
  REDIS_URL: process.env.REDIS_URL || null,
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_USER: process.env.DB_USER || 'root',
  DB_PASSWORD: process.env.DB_PASSWORD || '',
  DB_DATABASE: (() => {
    const db = String(process.env.DB_DATABASE || '').trim();
    if (!db) {
      console.error('❌ .env 缺少 DB_DATABASE');
      process.exit(1);
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(db)) {
      throw new Error('DB_DATABASE must be a valid MySQL identifier (1-64 letters, numbers, underscores or hyphens)');
    }
    return db;
  })(),
  DB_PORT: Number(process.env.DB_PORT) || 3306,
  DB_CONNECTION_LIMIT: Number(process.env.DB_CONNECTION_LIMIT) || 50,
};
