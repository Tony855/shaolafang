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

  const proxy = typeof trustProxy === 'string' ? trustProxy.trim() : '';
  if (!proxy || /^(?:loopback|true|\*|0\.0\.0\.0\/0|::\/0)$/i.test(proxy)) {
    return 'REQUIRE_SHARED_REDIS=true requires an explicit trusted load-balancer IP/CIDR in TRUST_PROXY';
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
