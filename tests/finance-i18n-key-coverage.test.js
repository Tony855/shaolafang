'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'pages/admin/financial-reconciliation.js'), 'utf8');
const localeCodes = ['zh', 'en', 'vi', 'th', 'km'];
const dynamicPrefixes = new Set(['financeCol_', 'financeMonth_']);

test('all static translation keys used by finance reconciliation exist in every locale', () => {
  const keys = [...new Set([...source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]))]
    .filter(key => !dynamicPrefixes.has(key));

  assert.ok(keys.length > 0, 'finance reconciliation should declare static translation keys');
  for (const locale of localeCodes) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
    const missing = keys.filter(key => !(key in dictionary));
    assert.deepEqual(missing, [], locale + ' is missing finance reconciliation translation keys');
  }
});
