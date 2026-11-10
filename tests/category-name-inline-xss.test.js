'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sources = [
  fs.readFileSync(path.join(root, 'pages/admin/menu.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8')
];

test('category names are never interpolated into inline JavaScript handlers', () => {
  for (const source of sources) {
    assert.match(source, /class="edit-category-btn" data-category-id=/);
    assert.match(source, /data-category-name="\$\{esc\(c\.name\)\}"/);
    assert.doesNotMatch(source, /onclick="editCategory\(\$\{c\.id\},'\$\{esc\(c\.name\)\}'\)"/);
    assert.match(source, /button\.addEventListener\('click'/);
    assert.match(source, /editCategory\(categoryId, this\.dataset\.categoryName/);
  }
});
