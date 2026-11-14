'use strict';

function getClusterStartupError({
  requireSharedRedis,
  redisUrl,
  trustProxy,
  redisReady,
  socketAdapterReady
} = {}) {
  if (requireSharedRedis !== true && requireSharedRedis !== 'true') return null;

  if (typeof redisUrl !== 'string' || !redisUrl.trim()) {
    return 'REQUIRE_SHARED_REDIS=true requires REDIS_URL';
  }

  const proxyEntries = typeof trustProxy === 'string'
    ? trustProxy.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    : [];
  const unsafeProxyEntries = new Set(['loopback', 'linklocal', 'uniquelocal', 'true', '*', '0.0.0.0/0', '::/0']);
  if (!proxyEntries.length || proxyEntries.every(value => value === 'loopback') ||
      proxyEntries.some(value => unsafeProxyEntries.has(value))) {
    return 'REQUIRE_SHARED_REDIS=true requires explicit trusted load-balancer IP/CIDR entries in TRUST_PROXY';
  }

  if (redisReady !== true) {
    return 'Shared Redis is required but the Redis connection is not ready';
  }
  if (socketAdapterReady !== true) {
    return 'Shared Redis is required but the Socket.IO Redis adapter is not ready';
  }
  return null;
}

module.exports = { getClusterStartupError };
