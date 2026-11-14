'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getClusterStartupError } = require('../server/config/cluster-requirements');

const valid = {
  requireSharedRedis: 'true',
  redisUrl: 'redis://redis.internal:6379/0',
  trustProxy: '10.10.0.10/32',
  redisReady: true,
  socketAdapterReady: true
};

test('single-node deployments retain optional Redis behavior', () => {
  assert.equal(getClusterStartupError({ requireSharedRedis: 'false' }), null);
  assert.equal(getClusterStartupError({}), null);
});

test('cluster mode requires an explicit shared Redis URL', () => {
  assert.match(getClusterStartupError({ ...valid, redisUrl: '' }), /requires REDIS_URL/);
});

test('cluster mode requires an explicit trusted proxy IP or CIDR', () => {
  for (const trustProxy of ['', 'loopback', 'linklocal', 'uniquelocal', 'true', '*', '0.0.0.0/0', '::/0', '10.0.0.1,0.0.0.0/0', 'localhost', '127.0.0.1', '::1', '10.0.0.1/0', '10.0.0.1/33', '192.168.1.10/32']) {
    assert.match(getClusterStartupError({ ...valid, trustProxy }), /explicit trusted load-balancer/);
  }
});

test('cluster mode fails closed when Redis or Socket.IO adapter is unavailable', () => {
  assert.match(getClusterStartupError({ ...valid, redisReady: false }), /Redis connection is not ready/);
  assert.match(getClusterStartupError({ ...valid, socketAdapterReady: false }), /Socket.IO Redis adapter is not ready/);
});

test('cluster mode starts only when Redis, adapter and proxy configuration are ready', () => {
  assert.equal(getClusterStartupError(valid), null);
  assert.equal(getClusterStartupError({ ...valid, trustProxy: '10.0.0.0/16,2001:db8::10/128' }), null);
});
