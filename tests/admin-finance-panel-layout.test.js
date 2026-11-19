'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function findDivEnd(source, openIndex) {
  const tags = /<\\/?div\\b[^>]*>/gi;
  tags.lastIndex = openIndex;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    if (/^<\\//.test(match[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return match.index;
  }
  return -1;
}

function panelBounds(id) {
  const idIndex = html.indexOf(`id="${id}"`);
  assert.notEqual(idIndex, -1, `missing panel ${id}`);
  const openIndex = html.lastIndexOf('<div', idIndex);
  const closeIndex = findDivEnd(html, openIndex);
  assert.notEqual(closeIndex, -1, `unclosed panel ${id}`);
  return { openIndex, closeIndex };
}

test('finance exception panels are siblings, not children of the flex header', () => {
  const performance = panelBounds('financeExceptionPerformance');
  const exportAudit = panelBounds('financePerformanceExportAuditPanel');
  const queue = panelBounds('financeExceptionQueuePanel');

  assert.ok(performance.closeIndex < exportAudit.openIndex,
    'performance panel must close before export audit panel starts');
  assert.ok(exportAudit.closeIndex < queue.openIndex,
    'export audit panel must close before exception queue starts');

  const flexHeader = '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">';
  const nearestHeader = html.lastIndexOf(flexHeader, performance.openIndex);
  assert.notEqual(nearestHeader, -1, 'finance section should retain its preceding header');
  assert.ok(findDivEnd(html, nearestHeader) < performance.openIndex,
    'performance panel must not be nested inside a flex header');
});
