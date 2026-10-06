/* ============================================================
   server/db/pool.js — MySQL 连接池
   ============================================================ */
const mysql = require('mysql2/promise');
const env = require('../config/env');

const poolConfig = {
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_DATABASE,
  port: env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
};

let pool = mysql.createPool(poolConfig);

module.exports = {
  get pool() { return pool; },
  set pool(p) { pool = p; },
  setPool(p) { pool = p; },
  poolConfig
};
