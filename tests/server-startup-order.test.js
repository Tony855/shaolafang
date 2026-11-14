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
