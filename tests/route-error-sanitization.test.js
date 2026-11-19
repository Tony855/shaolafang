'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routesDir = path.join(__dirname, '..', 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(file => file.endsWith('.js'));
const unsafePatterns = [
  /(?:error|err)\.(?:status|statusCode)\s*\?\s*(?:error|err)\.message/,
  /res\.status\(\s*(?:error|err)\.(?:status|statusCode)\s*\|\|\s*500\s*\)\.json\(\s*\{\s*error:\s*(?:error|err)\.message/
];

test('route handlers must not expose arbitrary error messages for 5xx responses', () => {
  for (const file of routeFiles) {
    const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
    for (const pattern of unsafePatterns) {
      assert.doesNotMatch(source, pattern, file + ' contains an unsafe error response pattern');
    }
  }
});
