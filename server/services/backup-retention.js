'use strict';

const fs = require('fs');
const path = require('path');

function parseRetentionDays(value, fallback = 30) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 3650);
}

function pruneAutoBackups(backupDir, retentionDays, nowMs = Date.now(), fsImpl = fs) {
  const days = parseRetentionDays(retentionDays);
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  if (!fsImpl.existsSync(backupDir)) return removed;

  for (const name of fsImpl.readdirSync(backupDir)) {
    if (!/^auto-\d{4}-\d{2}-\d{2}(?:T[^/]*)?\.json$/i.test(name)) continue;
    const fullPath = path.join(backupDir, name);
    try {
      const stat = fsImpl.statSync(fullPath);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      fsImpl.unlinkSync(fullPath);
      removed++;
    } catch (_) {
      // Retention is best-effort; never fail a successful backup because a file vanished.
    }
  }
  return removed;
}

module.exports = { parseRetentionDays, pruneAutoBackups };
