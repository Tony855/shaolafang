'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramNotificationWorker } = require('../server/services/telegram-notification-worker-runtime');

const workerId = '123e4567-e89b-42d3-a456-426614174000';

test('Telegram worker runs one batch at a time and stops cleanly during an active batch', async () => {
  let started;
  let finishBatch;
  const batchStarted = new Promise(resolve => { started = resolve; });
  const batchGate = new Promise(resolve => { finishBatch = resolve; });
  let calls = 0;
  const worker = createTelegramNotificationWorker({
    workerId,
    intervalMs: 250,
    resolveRecipient: async () => null,
    processBatch: async options => {
      calls++;
      assert.equal(options.limit, 1);
      assert.equal(options.workerId, workerId);
      started();
      await batchGate;
    },
    logger: { error() {} }
  });
  worker.start();
  await batchStarted;
  const stopping = worker.stop();
  finishBatch();
  await stopping;
  assert.equal(worker.running, false);
  assert.equal(calls, 1);
});

test('Telegram worker can stop during its idle poll delay without hanging', async () => {
  let called;
  const firstBatch = new Promise(resolve => { called = resolve; });
  const worker = createTelegramNotificationWorker({
    workerId,
    intervalMs: 1000,
    resolveRecipient: async () => null,
    processBatch: async () => { called(); },
    logger: { error() {} }
  });
  worker.start();
  await firstBatch;
  await worker.stop();
  assert.equal(worker.running, false);
});

test('Telegram worker rejects unsafe polling intervals and worker IDs', () => {
  assert.throws(() => createTelegramNotificationWorker({ workerId: 'not-a-uuid' }), /Worker ID/);
  assert.throws(() => createTelegramNotificationWorker({ workerId, intervalMs: 10 }), /polling interval/);
});
