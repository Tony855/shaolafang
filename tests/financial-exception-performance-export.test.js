'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExceptionPerformanceCsv, csvCell } = require('../server/services/financial-exception-performance-export');

test('exception performance CSV groups currencies, assignees and categories and neutralizes formulas', () => {
  const csv = buildExceptionPerformanceCsv({
    byCurrency: [{ currencyCode: 'USD', activeCount: 2 }],
    byAssignee: [{ currencyCode: 'USD', username: '=HYPERLINK("x")', activeCount: 1 }],
    byCategory: [{ currencyCode: 'KHR', category: 'fee', activeCount: 3 }]
  });
  assert.match(csv, /"currency","USD"/);
  assert.match(csv, /"assignee","USD","'=HYPERLINK/);
  assert.match(csv, /"category","KHR","fee"/);
  assert.ok(csv.startsWith('\uFEFF"group"'));
  assert.equal(csvCell('+SUM(1,2)'), "\"'+SUM(1,2)\"");
});

test('empty exception performance CSV has stable header and newline', () => {
  const csv = buildExceptionPerformanceCsv({});
  assert.ok(csv.startsWith('\uFEFF"group"'));
  assert.ok(csv.endsWith('\r\n'));
});
