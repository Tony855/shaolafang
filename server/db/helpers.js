/* ============================================================
   server/db/helpers.js — runAsync/getAsync/allAsync/withTransaction
   ============================================================ */
const { AsyncLocalStorage } = require('async_hooks');
const { pool } = require('./pool');

const transactionStorage = new AsyncLocalStorage();

async function runAsync(sql, params) {
  const db = transactionStorage.getStore() || pool;
  const [result] = await db.execute(sql, params);
  return { lastID: result.insertId, insertId: result.insertId, changes: result.affectedRows, affectedRows: result.affectedRows };
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

module.exports = { runAsync, getAsync, allAsync, withTransaction, transactionStorage };
