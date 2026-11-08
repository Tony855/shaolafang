'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadFlagHelper(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/function isEnabledFlag\(value, fallback = false\) \{[\s\S]*?\n\s*\}/);
  assert.ok(match, file + ' must define strict isEnabledFlag');
  return { source, isEnabledFlag: vm.runInNewContext('(' + match[0] + ')') };
}

test('admin cashier manager parses legacy string flags strictly', () => {
  const { source, isEnabledFlag } = loadFlagHelper('pages/admin/cashier-mgr.js');
  assert.equal(isEnabledFlag('false'), false);
  assert.equal(isEnabledFlag('0'), false);
  assert.equal(isEnabledFlag(false), false);
  assert.equal(isEnabledFlag('true'), true);
  assert.equal(isEnabledFlag('1'), true);
  assert.equal(isEnabledFlag(1), true);
  assert.equal(isEnabledFlag(undefined, true), true);
  assert.equal(isEnabledFlag(undefined, false), false);
  assert.match(source, /Array\.isArray\(data\?\.cashiers\)/);
  assert.doesNotMatch(source, /cashier\.active !== false|permissions\?\.can_\w+ !== false/);
});

test('cashier POS hides actions for string false and zero permissions', () => {
  const { source, isEnabledFlag } = loadFlagHelper('pages/cashier.js');
  const permissions = { can_settle: 'false', can_cancel: '0', can_refund: 'true' };
  assert.equal(isEnabledFlag(permissions.can_settle, true), false);
  assert.equal(isEnabledFlag(permissions.can_cancel, true), false);
  assert.equal(isEnabledFlag(permissions.can_refund, false), true);
  assert.equal(isEnabledFlag(undefined, true), true);
  assert.doesNotMatch(source, /perms\.can_settle !== false|perms\.can_cancel !== false|perms\.can_refund === true/);
});
