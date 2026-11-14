'use strict';

/**
 * Ensure super_admins.active exists for account disable/revoke checks.
 * Existing accounts are enabled by default; no credentials or account data change.
 */
async function ensureSuperAdminActiveSchema({ allAsync, runAsync, logger = console }) {
  if (typeof allAsync !== 'function' || typeof runAsync !== 'function') {
    throw new TypeError('ensureSuperAdminActiveSchema requires allAsync and runAsync');
  }

  const columns = await allAsync(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'super_admins' AND COLUMN_NAME = ?",
    ['active']
  );
  if (columns.length > 0) return { changed: false };

  try {
    await runAsync('ALTER TABLE super_admins ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER display_name');
  } catch (error) {
    // Another application instance may have completed the same idempotent DDL.
    if (error && (error.code === 'ER_DUP_FIELDNAME' || /duplicate column/i.test(error.message || ''))) {
      return { changed: false };
    }
    throw error;
  }

  if (logger && typeof logger.log === 'function') {
    logger.log('  + 迁移 super_admins: 添加 active 字段（现有账号默认启用）');
  }
  return { changed: true };
}

module.exports = { ensureSuperAdminActiveSchema };
