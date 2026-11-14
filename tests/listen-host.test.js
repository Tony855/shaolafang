'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveListenHost } = require('../server/config/listen-host');

test('backend binds to loopback by default for same-host Nginx deployments', () => {
  assert.equal(resolveListenHost(undefined), '127.0.0.1');
  assert.equal(resolveListenHost(''), '127.0.0.1');
  assert.equal(resolveListenHost('   '), '127.0.0.1');
});

test('backend accepts an explicit address for private-network reverse proxies', () => {
  assert.equal(resolveListenHost('10.20.0.15'), '10.20.0.15');
  assert.equal(resolveListenHost('0.0.0.0'), '0.0.0.0');
  assert.equal(resolveListenHost('  ::  '), '::');
});

test('server startup uses the configured safe listener host', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /resolveListenHost\(process\.env\.HOST\)/);
  assert.match(serverSource, /server\.listen\(PORT, LISTEN_HOST/);
  assert.doesNotMatch(serverSource, /server\.listen\(PORT,\s*['"]0\.0\.0\.0['"]/);
});
