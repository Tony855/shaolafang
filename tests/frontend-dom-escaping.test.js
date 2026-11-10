const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

function readRepoFile(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

test('waiter history escapes unknown order statuses before inserting HTML', () => {
  const source = readRepoFile('pages', 'waiter.js');
  assert.ok(source.includes('${statusMap[o.status] || esc(o.status)}'));
  assert.ok(source.includes('${statusMap[order.status] || esc(order.status)}'));
});

test('KHQR provider identifiers are escaped in source and generated admin bundle', () => {
  for (const file of [
    ['pages', 'admin', 'khqr.js'],
    ['assets', 'admin-bundle.js']
  ]) {
    const source = readRepoFile(...file);
    assert.equal(source.split('data-id="${esc(p.id)}"').length - 1, 2);
    assert.equal(source.includes('data-id="${p.id}"'), false);
  }
});
