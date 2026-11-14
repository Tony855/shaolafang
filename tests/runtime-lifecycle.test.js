'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { closeRedisClient, createGracefulShutdown } = require('../server/services/graceful-shutdown');

test('closeRedisClient uses the node-redis v6 close API', async () => {
  let closed = 0;
  await closeRedisClient({ isOpen: true, close: async () => { closed++; } });
  assert.equal(closed, 1);
});

test('closeRedisClient supports older quit clients and destroys unopened clients', async () => {
  let quit = 0;
  let destroyed = 0;
  await closeRedisClient({ isOpen: true, quit: async () => { quit++; } });
  await closeRedisClient({ isOpen: false, destroy: () => { destroyed++; } });
  assert.equal(quit, 1);
  assert.equal(destroyed, 1);
});

test('graceful shutdown closes Socket.IO, Redis clients and MySQL once', async () => {
  const calls = [];
  const shutdown = createGracefulShutdown({
    io: { close(callback) { calls.push('io'); callback(); } },
    pool: { async end() { calls.push('mysql'); } },
    getRedisClients: () => [
      { isOpen: true, async close() { calls.push('redis-cache'); } },
      { isOpen: true, async close() { calls.push('redis-pub'); } },
      { isOpen: true, async close() { calls.push('redis-sub'); } }
    ],
    logger: { log() {}, error() {} }
  });

  const [first, second] = await Promise.all([
    shutdown('SIGTERM', 0),
    shutdown('SIGTERM', 0)
  ]);
  assert.equal(first, second);
  assert.deepEqual(calls.sort(), ['io', 'mysql', 'redis-cache', 'redis-pub', 'redis-sub'].sort());
});

test('graceful shutdown continues when one resource fails to close', async () => {
  let mysqlClosed = false;
  const shutdown = createGracefulShutdown({
    io: { close(callback) { callback(); } },
    pool: { async end() { mysqlClosed = true; } },
    getRedisClients: () => [{ isOpen: true, async close() { throw new Error('redis close failed'); } }],
    logger: { log() {}, error() {} }
  });
  const result = await shutdown('test', 1);
  assert.equal(mysqlClosed, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.results.some(item => item.status === 'rejected'), true);
});


test('graceful shutdown stops background workers before closing database resources', async () => {
  const calls = [];
  const shutdown = createGracefulShutdown({
    stopWorkers: async () => { calls.push('worker'); },
    io: { close(callback) { calls.push('io'); callback(); } },
    pool: { async end() { calls.push('mysql'); } },
    logger: { log() {}, error() {} }
  });
  await shutdown('SIGTERM', 0);
  assert.equal(calls[0], 'worker');
  assert.equal(calls.includes('mysql'), true);
});
