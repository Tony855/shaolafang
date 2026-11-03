'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Server } = require('socket.io');
const { closeRedisClient } = require('../server/services/graceful-shutdown');

const REDIS_URL = process.env.REDIS_URL;

test('Redis 6 client commands, atomic cooldown and pub/sub work against a live server', {
  skip: !REDIS_URL && 'REDIS_URL is not configured'
}, async () => {
  const clients = [];
  const makeClient = () => {
    const client = createClient({ url: REDIS_URL });
    client.on('error', error => {
      // Keep the test process alive long enough to report the originating assertion.
      if (!process.env.CI) console.error('[redis-test]', error.message);
    });
    clients.push(client);
    return client;
  };

  const commandClient = makeClient();
  const publisher = makeClient();
  const subscriber = makeClient();
  const adapterPublisher = makeClient();
  const adapterSubscriber = makeClient();
  let io;

  try {
    await Promise.all(clients.map(client => client.connect()));

    const prefix = 'foodflow:ci:' + process.pid + ':' + Date.now();
    const key = prefix + ':cooldown';
    assert.equal(await commandClient.set(key, 'first', { NX: true, EX: 30 }), 'OK');
    assert.equal(await commandClient.set(key, 'second', { NX: true, EX: 30 }), null);
    assert.equal(await commandClient.get(key), 'first');

    await commandClient.setEx(key, 30, JSON.stringify({ accepted: true }));
    assert.deepEqual(JSON.parse(await commandClient.get(key)), { accepted: true });
    assert.equal(await commandClient.del(key), 1);

    const channel = prefix + ':channel';
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis pub/sub message timed out')), 5000);
      subscriber.subscribe(channel, message => {
        clearTimeout(timer);
        resolve(message);
      }).catch(error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await new Promise(resolve => setImmediate(resolve));
    await publisher.publish(channel, 'redis6-pubsub-ok');
    assert.equal(await received, 'redis6-pubsub-ok');

    const adapterFactory = createAdapter(adapterPublisher, adapterSubscriber);
    assert.equal(typeof adapterFactory, 'function');
    io = new Server();
    io.adapter(adapterFactory);
    assert.ok(io.of('/').adapter);
  } finally {
    if (io) await new Promise(resolve => io.close(resolve));
    await Promise.allSettled(clients.map(client => closeRedisClient(client)));
  }
});
