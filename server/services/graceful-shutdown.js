'use strict';

async function closeRedisClient(client) {
  if (!client) return;
  if (client.isOpen) {
    if (typeof client.close === 'function') return client.close();
    if (typeof client.quit === 'function') return client.quit();
    if (typeof client.disconnect === 'function') return client.disconnect();
  }
  if (typeof client.destroy === 'function') return client.destroy();
  if (typeof client.disconnect === 'function') return client.disconnect();
}

function createGracefulShutdown({ io, pool, getRedisClients = () => [], stopWorkers = async () => {}, logger = console }) {
  let shutdownPromise = null;

  return function shutdown(reason, exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      try {
        await stopWorkers();
      } catch (error) {
        logger.error('[shutdown] Worker stop failed:', error?.message || 'unknown error');
      }
      const tasks = [];
      if (io && typeof io.close === 'function') {
        tasks.push(new Promise(resolve => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(finish, 5000);
          if (typeof timer.unref === 'function') timer.unref();
          try {
            const result = io.close(finish);
            if (result && typeof result.then === 'function') result.then(finish, error => {
              logger.error('[shutdown] Socket.IO close failed:', error.message);
              finish();
            });
          } catch (error) {
            logger.error('[shutdown] Socket.IO close failed:', error.message);
            finish();
          }
        }));
      }

      for (const client of getRedisClients() || []) {
        if (client) tasks.push(Promise.resolve().then(() => closeRedisClient(client)));
      }
      if (pool && typeof pool.end === 'function') {
        tasks.push(Promise.resolve().then(() => pool.end()));
      }

      const results = await Promise.allSettled(tasks);
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.error('[shutdown] Resource close failed:', result.reason?.message || result.reason);
        }
      }
      logger.log('[shutdown] Graceful shutdown completed:', reason);
      return { reason, exitCode, results };
    })();

    return shutdownPromise;
  };
}

module.exports = { closeRedisClient, createGracefulShutdown };
