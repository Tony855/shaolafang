/* ============================================================
   server/services/orderNo.js — 订单号分配
   ============================================================ */
const { runAsync, getAsync } = require('../db/helpers');

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

async function getOrderCooldownMs() {
  try {
    const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'order_interval_seconds'");
    const seconds = parseInt(setting?.value || '30', 10);
    return Math.max(0, Math.min(3600, seconds)) * 1000;
  } catch (e) {
    return 30 * 1000;
  }
}

module.exports = { allocateOrderNo, getOrderCooldownMs };
