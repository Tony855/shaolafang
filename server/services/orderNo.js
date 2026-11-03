const { runAsync, getAsync } = require('../db/helpers');
const redisState = require('../db/redis-state');

const LUA_INCR = "if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], tonumber(ARGV[1]) or 0) end return redis.call('INCR', KEYS[1])";

async function allocateOrderNo(todayPrefix) {
  if (redisState.ready && redisState.client) {
    try {
      const row = await getAsync('SELECT current_value FROM order_sequences WHERE prefix = ?', [todayPrefix]);
      const dbVal = row ? row.current_value : 0;
      const seq = await redisState.client.eval(LUA_INCR, {
        keys: ['order_seq:' + todayPrefix],
        arguments: [String(dbVal)]
      });
      runAsync(
        'INSERT INTO order_sequences (prefix, current_value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE current_value = GREATEST(current_value, VALUES(current_value))',
        [todayPrefix, seq, new Date().toISOString()]
      ).catch(function () {});
      return todayPrefix + String(seq).padStart(5, '0');
    } catch (e) {
      console.warn('[orderNo] Redis failed, fallback DB: ' + e.message);
    }
  }
  const now = new Date().toISOString();
  await runAsync(
    "INSERT INTO order_sequences (prefix, current_value, updated_at) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)",
    [todayPrefix, now]
  );
  const row2 = await getAsync('SELECT current_value FROM order_sequences WHERE prefix = ? FOR UPDATE', [todayPrefix]);
  const next = ((row2 && row2.current_value) || 0) + 1;
  await runAsync('UPDATE order_sequences SET current_value = ?, updated_at = ? WHERE prefix = ?', [next, now, todayPrefix]);
  return todayPrefix + String(next).padStart(5, '0');
}

async function getOrderCooldownMs() {
  try {
    const setting = await getAsync("SELECT value FROM settings WHERE `key` = 'order_interval_seconds'");
    const raw = setting?.value ?? '30';
    const seconds = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isSafeInteger(seconds)) return 30 * 1000;
    return Math.max(0, Math.min(3600, seconds)) * 1000;
  } catch (e) { return 30 * 1000; }
}

module.exports = { allocateOrderNo, getOrderCooldownMs };
