'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sources = [
  fs.readFileSync(path.join(root, 'pages/admin/order.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'assets/admin-bundle.js'), 'utf8')
];

test('admin order transfer keeps database table names out of inline JavaScript', () => {
  for (const source of sources) {
    assert.match(source, /class="admin-transfer-order-btn" data-transfer-order-id=/);
    assert.match(source, /data-transfer-from-table="\$\{esc\(o\.table_name \|\| ''\)\}"/);
    assert.doesNotMatch(source, /onclick="showTransferModal\(\$\{o\.id\},'\$\{o\.table_name\}'\)"/);
    assert.match(source, /button\.addEventListener\('click'/);
    assert.match(source, /showTransferModal\(orderId, this\.dataset\.transferFromTable/);
  }
});
