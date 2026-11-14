'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resolver = require('../server/services/icon-resolver');

test('missing bank-specific icon resolves to the existing generic KHQR asset', () => {
  assert.equal(fs.existsSync(path.join(resolver.ICON_DIR, 'KHQR.png')), true);
  assert.equal(resolver.resolveIcon('maybank.png'), 'KHQR.png');
  assert.equal(resolver.resolveIcon('hattha.png'), 'KHQR.png');
  assert.equal(resolver.resolveIcon('prince.png'), 'KHQR.png');
});

test('existing bank icon keeps its configured filename', () => {
  assert.equal(resolver.resolveIcon('aba.png'), 'aba.png');
});
