'use strict';

const net = require('node:net');

function isExplicitProxyEntry(value) {
  const parts = value.split('/');
  if (parts.length > 2) return false;
  const address = parts[0];
  const version = net.isIP(address);
  if (!version) return false;
  if (version === 4 && (address === '0.0.0.0' || address.startsWith('127.'))) return false;
  if (version === 6 && (address === '::' || address === '::1')) return false;
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[1])) return false;
    const prefix = Number(parts[1]);
    if (prefix < 1 || prefix > (version === 4 ? 32 : 128)) return false;
  }
  return true;
}

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
  if (!proxyEntries.length || proxyEntries.some(value =>
    unsafeProxyEntries.has(value) || !isExplicitProxyEntry(value)
  )) {
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
