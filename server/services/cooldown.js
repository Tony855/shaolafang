'use strict';

function createCooldownChecker(cache) {
  if (!cache || typeof cache.setIfAbsent !== 'function') {
    throw new TypeError('cache.setIfAbsent is required for atomic cooldowns');
  }

  return async function checkAndSetCooldown(key, cooldownMs) {
    let interval = Number(cooldownMs);
    if (!Number.isFinite(interval) || interval < 0) interval = 30000;
    if (interval === 0) return true;

    const ttlSeconds = Math.max(1, Math.ceil(interval / 1000) + 1);
    return cache.setIfAbsent('cooldown:' + String(key), Date.now(), ttlSeconds);
  };
}

module.exports = { createCooldownChecker };
