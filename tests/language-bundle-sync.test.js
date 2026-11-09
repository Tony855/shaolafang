'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LANGUAGES = ['zh', 'en', 'vi', 'th', 'km'];

function loadRuntimeAsset(filename) {
  const sandbox = { navigator: { language: 'zh' } };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, filename), 'utf8'), sandbox, { filename });
  return JSON.parse(JSON.stringify(sandbox.LANGUAGES));
}

test('committed language runtime assets exactly match all locale source files', () => {
  const expected = Object.fromEntries(LANGUAGES.map(lang => [
    lang,
    JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang + '.json'), 'utf8'))
  ]));

  assert.deepEqual(loadRuntimeAsset('languages.js'), expected, 'languages.js is stale; run npm run build:lang');
  assert.deepEqual(loadRuntimeAsset('languages.min.js'), expected, 'languages.min.js is stale; run npm run build:lang');
});
