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

let savepointSequence = 0;

async function withTransaction(work) {
  if (typeof work !== 'function') {
    throw new TypeError('withTransaction requires a callback');
  }

  // Reuse the current connection for nested transactions. A savepoint keeps
  // inner failures isolated without silently committing the outer transaction.
  const current = transactionStorage.getStore();
  if (current) {
    const savepoint = 'foodflow_sp_' + (++savepointSequence);
    await current.query('SAVEPOINT ' + savepoint);
    try {
      const result = await transactionStorage.run(current, work);
      await current.query('RELEASE SAVEPOINT ' + savepoint);
      return result;
    } catch (error) {
      try {
        await current.query('ROLLBACK TO SAVEPOINT ' + savepoint);
      } finally {
        await current.query('RELEASE SAVEPOINT ' + savepoint);
      }
      throw error;
    }
  }

  const conn = await pool.getConnection();
  let transactionStarted = false;
  try {
    await conn.query('START TRANSACTION');
    transactionStarted = true;
    const result = await transactionStorage.run(conn, work);
    await conn.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await conn.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { runAsync, getAsync, allAsync, withTransaction, transactionStorage };
