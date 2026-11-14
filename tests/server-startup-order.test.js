'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('server initializes the cooldown checker dependency before first use', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const importLine = "const { createCooldownChecker } = require('./server/services/cooldown');";
  const useLine = 'const checkAndSetCooldown = createCooldownChecker(cache);';

  assert.equal(source.split(importLine).length - 1, 1, 'cooldown checker must be imported exactly once');
  assert.ok(source.indexOf(importLine) >= 0, 'cooldown checker import must exist');
  assert.ok(source.indexOf(importLine) < source.indexOf(useLine), 'cooldown checker must be initialized before use');
});

test('cluster startup guard runs after Redis initialization and before listening', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const redisInit = source.indexOf('const redisInitialized = await initRedis();');
  const adapterInit = source.indexOf('const socketAdapterInitialized = await initSocketAdapter();');
  const guard = source.indexOf('const clusterStartupError = getClusterStartupError({');
  const listen = source.indexOf('server.listen(PORT, LISTEN_HOST');

  assert.ok(redisInit >= 0 && adapterInit > redisInit);
  assert.ok(guard > adapterInit && listen > guard,
    'cluster requirements must be checked before the HTTP server accepts traffic');
  assert.match(source, /REQUIRE_SHARED_REDIS/);
});
