'use strict';

/**
 * Ensure stores.qr_languages exists for per-store QR print language settings.
 * DB helpers are injected so this migration can be tested without a live database.
 */
async function ensureStoreQrLanguagesSchema({ allAsync, runAsync, logger = console }) {
  if (typeof allAsync !== 'function' || typeof runAsync !== 'function') {
    throw new TypeError('ensureStoreQrLanguagesSchema requires allAsync and runAsync');
  }

  const columns = await allAsync('SHOW COLUMNS FROM stores LIKE ?', ['qr_languages']);
  if (columns.length > 0) {
    return { changed: false };
  }

  await runAsync('ALTER TABLE stores ADD COLUMN qr_languages VARCHAR(50) DEFAULT NULL');
  if (logger && typeof logger.log === 'function') {
    logger.log('  + 迁移 stores: 添加 qr_languages 字段');
  }
  return { changed: true };
}

module.exports = { ensureStoreQrLanguagesSchema };
