'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const buildScript = fs.readFileSync(path.join(root, 'scripts/build-admin-bundle.js'), 'utf8');
const adminModules = [...buildScript.matchAll(/'(pages\/admin\/[^']+\.js)'/g)].map(match => match[1]);
const frontendFiles = [
  ...adminModules,
  'pages/admin.js',
  'pages/super.js',
  'pages/cashier.js',
  'pages/waiter.js',
  'pages/kitchen.js'
];
const localeCodes = ['zh', 'en', 'vi', 'th', 'km'];
const dynamicPrefixes = new Set(['financeCol_', 'financeMonth_']);
const translationCall = /(?:\btAdmin|\bL|\bt|SLF\.t|i18n\.t)\s*\(\s*['"]([^'"]+)['"]/g;

test('all static admin and front-desk translation references exist in every locale', () => {
  assert.ok(adminModules.length > 0, 'admin bundle must declare its source modules');
  const keysByFile = new Map();
  for (const file of frontendFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const keys = [...new Set([...source.matchAll(translationCall)].map(match => match[1]))]
      .filter(key => !dynamicPrefixes.has(key));
    keysByFile.set(file, keys);
  }

  for (const locale of localeCodes) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
    const missing = [];
    for (const [file, keys] of keysByFile) {
      for (const key of keys) {
        if (!(key in dictionary)) missing.push(file + ': ' + key);
      }
    }
    assert.deepEqual(missing, [], locale + ' is missing frontend translation keys');
  }
});
