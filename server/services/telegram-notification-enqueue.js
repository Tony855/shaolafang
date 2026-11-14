'use strict';

const { enqueueTelegramNotification } = require('./telegram-notification-outbox');

async function enqueueSystemAdminTelegramNotification({ getAsync, eventKey, event } = {}) {
  if (typeof getAsync !== 'function') throw new TypeError('getAsync is required');
  const setting = await getAsync("SELECT value FROM settings WHERE `key`=?", ['telegram_admin_bot_enabled']);
  if (String(setting?.value || '') !== '1') return false;
  await enqueueTelegramNotification({
    eventKey,
    recipientScope: 'system_admin',
    recipientKey: 'admin:primary',
    event
  });
  return true;
}

module.exports = { enqueueSystemAdminTelegramNotification };
