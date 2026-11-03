'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCooldownChecker } = require('../server/services/cooldown');

test('cooldown uses atomic set-if-absent instead of a racy get-then-set', async () => {
  let locked = false;
  const calls = [];
  const checker = createCooldownChecker({
    async setIfAbsent(key, value, ttl) {
      calls.push({ key, value, ttl });
      if (locked) return false;
      locked = true;
      return true;
    },
    async get() { throw new Error('non-atomic get must not be used'); },
    async set() { throw new Error('non-atomic set must not be used'); }
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, () => checker('table-A', 3000))
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(calls.length, 20);
  assert.equal(calls[0].key, 'cooldown:table-A');
  assert.equal(calls[0].ttl, 3);
});

test('cooldown handles zero, invalid and negative intervals safely', async () => {
  const calls = [];
  const checker = createCooldownChecker({
    async setIfAbsent(key, value, ttl) { calls.push({ key, ttl }); return true; }
  });
  assert.equal(await checker('disabled', 0), true);
  assert.equal(calls.length, 0);
  await checker('invalid', NaN);
  await checker('negative', -1);
  assert.equal(calls[0].ttl, 30);
  assert.equal(calls[1].ttl, 30);
});


test('cooldown backend unavailability is distinguishable from an active cooldown', async () => {
  const checker = createCooldownChecker({
    async setIfAbsent() { return null; }
  });
  assert.equal(await checker('table-A', 3000), null);
});
