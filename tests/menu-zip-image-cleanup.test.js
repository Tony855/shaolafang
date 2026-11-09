const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupUnreferencedImages } = require('../server/services/menu-zip-image-cleanup');

test('ZIP import cleanup removes extracted images not referenced by saved menu rows', () => {
  const removed = [];
  cleanupUnreferencedImages(
    new Set(['/uploads/used.jpg', '/uploads/orphan.png']),
    new Set(['/uploads/used.jpg']),
    file => removed.push(file)
  );
  assert.deepEqual(removed, ['/uploads/orphan.png']);
});

test('ZIP import cleanup removes every extracted image when no menu row was saved', () => {
  const removed = [];
  cleanupUnreferencedImages(
    new Set(['/uploads/a.jpg', '/uploads/b.png']),
    new Set(),
    file => removed.push(file)
  );
  assert.deepEqual(removed, ['/uploads/a.jpg', '/uploads/b.png']);
});

test('ZIP import cleanup does not mask the import result when file deletion fails', () => {
  assert.doesNotThrow(() => cleanupUnreferencedImages(
    new Set(['/uploads/orphan.jpg']),
    new Set(),
    () => { throw new Error('permission denied'); }
  ));
});
