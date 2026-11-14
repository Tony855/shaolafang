'use strict';

const { randomUUID } = require('crypto');
const { processTelegramNotificationBatch } = require('./telegram-notification-worker');
const { createTelegramNotificationRecipientResolver } = require('./telegram-notification-recipient');
const { getAsync } = require('../db/helpers');

function createTelegramNotificationWorker({
  resolveRecipient = createTelegramNotificationRecipientResolver({ getAsync }),
  processBatch = processTelegramNotificationBatch,
  workerId = randomUUID(),
  intervalMs = 5000,
  logger = console
} = {}) {
  if (typeof resolveRecipient !== 'function') throw new TypeError('resolveRecipient is required');
  if (typeof processBatch !== 'function') throw new TypeError('processBatch is required');
  if (typeof workerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(workerId)) throw new TypeError('Worker ID 无效');
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw new TypeError('Worker polling interval is invalid');

  let running = false;
  let loopPromise = null;
  let pendingDelay = null;
  let resolvePendingDelay = null;

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
      try {
        await processBatch({ resolveRecipient, workerId, limit: 1, leaseSeconds: 60 });
      } catch (_) {
        // Never log raw Telegram responses, credentials, or untrusted exception messages.
        try { logger.error('[telegram-worker] batch processing failed'); } catch (_) {}
      }
      if (running) await waitForNextPoll();
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
