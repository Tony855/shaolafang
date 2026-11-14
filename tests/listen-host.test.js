'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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
