'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRetentionDays, pruneAutoBackups } = require('../server/services/backup-retention');

test('backup retention is bounded and invalid settings use the safe default', () => {
  assert.equal(parseRetentionDays('14'), 14);
  assert.equal(parseRetentionDays('-1'), 30);
  assert.equal(parseRetentionDays('0'), 30);
  assert.equal(parseRetentionDays('invalid'), 30);
  assert.equal(parseRetentionDays('99999'), 3650);
});

test('automatic backup pruning removes only expired automatic backup files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-backup-retention-'));
  try {
    const oldAuto = path.join(dir, 'auto-2020-01-01.json');
    const newAuto = path.join(dir, 'auto-2026-11-03T14-00-00-000Z.json');
    const manual = path.join(dir, 'manual-export.json');
    for (const file of [oldAuto, newAuto, manual]) fs.writeFileSync(file, '{}');
    const now = Date.now();
    fs.utimesSync(oldAuto, new Date(now - 40 * 86400000), new Date(now - 40 * 86400000));
    fs.utimesSync(newAuto, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
    fs.utimesSync(manual, new Date(now - 90 * 86400000), new Date(now - 90 * 86400000));

    assert.equal(pruneAutoBackups(dir, 30, now), 1);
    assert.equal(fs.existsSync(oldAuto), false);
    assert.equal(fs.existsSync(newAuto), true);
    assert.equal(fs.existsSync(manual), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('audit-log retention always preserves per-refund financial audit records', () => {
  // Read the source rather than requiring backup.js: that module intentionally
  // initializes database helpers and requires production DB configuration.
  const backupSource = fs.readFileSync(path.join(__dirname, '../server/services/backup.js'), 'utf8');
  assert.match(backupSource, /function buildAuditLogCleanupSql\\(\\)/);
  assert.match(backupSource, /return "DELETE FROM audit_logs WHERE created_at < \\? AND action <> 'refund_order'"/);
  assert.match(backupSource, /runAsync\\(buildAuditLogCleanupSql\\(\\), \\[cutoff\\]\\)/);
});
