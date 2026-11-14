'use strict';

const { randomUUID } = require('crypto');
function createTelegramNotificationWorker({
  resolveRecipient,
  processBatch,
  cleanupHistory,
  workerId = randomUUID(),
  intervalMs = 5000,
  logger = console
} = {}) {
  if (typeof workerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workerId)) throw new TypeError('Worker ID 无效');
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw new TypeError('Worker polling interval is invalid');
  if (!resolveRecipient) {
    const { allAsync } = require('../db/helpers');
    const { createTelegramNotificationRecipientResolver } = require('./telegram-notification-recipient');
    resolveRecipient = createTelegramNotificationRecipientResolver({ allAsync });
  }
  if (!processBatch) {
    ({ processTelegramNotificationBatch: processBatch } = require('./telegram-notification-worker'));
  }
  if (!cleanupHistory) {
    ({ cleanupTelegramNotificationHistory: cleanupHistory } = require('./telegram-notification-outbox'));
  }
  if (typeof resolveRecipient !== 'function') throw new TypeError('resolveRecipient is required');
  if (typeof processBatch !== 'function') throw new TypeError('processBatch is required');
  if (typeof cleanupHistory !== 'function') throw new TypeError('cleanupHistory is required');

  let running = false;
  let loopPromise = null;
  let pendingDelay = null;
  let resolvePendingDelay = null;
  let lastCleanupAt = 0;

  function waitForNextPoll() {
    return new Promise(resolve => {
      pendingDelay = setTimeout(() => {
        pendingDelay = null;
        resolvePendingDelay = null;
        resolve();
      }, intervalMs);
      resolvePendingDelay = resolve;
      if (typeof pendingDelay.unref === 'function') pendingDelay.unref();
    });
  }

  async function runLoop() {
    while (running) {
      if (Date.now() - lastCleanupAt >= 24 * 60 * 60 * 1000) {
        lastCleanupAt = Date.now();
        try {
          await cleanupHistory();
        } catch (_) {
          try { logger.error('[telegram-worker] retention cleanup failed'); } catch (_) {}
        }
      }
      let madeProgress = false;
      try {
        const results = await processBatch({ resolveRecipient, workerId, limit: 1, leaseSeconds: 60 });
        madeProgress = Array.isArray(results) && results.some(result =>
          result && ['delivered', 'suppressed', 'retry', 'dead'].includes(result.state)
        );
      } catch (_) {
        // Never log raw Telegram responses, credentials, or untrusted exception messages.
        try { logger.error('[telegram-worker] batch processing failed'); } catch (_) {}
      }
      // Drain one leased message at a time without an artificial five-second
      // gap. Keeping limit=1 preserves the 60-second lease/10-second HTTP
      // timeout safety margin; idle workers still back off to the poll interval.
      if (running && !madeProgress) await waitForNextPoll();
    }
  }

  function start() {
    if (running) return stop;
    running = true;
    loopPromise = runLoop();
    return stop;
  }

  async function stop() {
    running = false;
    if (pendingDelay) {
      clearTimeout(pendingDelay);
      pendingDelay = null;
      if (resolvePendingDelay) resolvePendingDelay();
      resolvePendingDelay = null;
    }
    if (loopPromise) {
      const current = loopPromise;
      loopPromise = null;
      await current;
    }
  }

  return { start, stop, get running() { return running; }, workerId };
}

module.exports = { createTelegramNotificationWorker };
