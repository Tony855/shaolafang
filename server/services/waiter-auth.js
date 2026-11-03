'use strict';

const ACTIVE_WAITER_SQL = 'SELECT w.* FROM waiters w JOIN stores s ON s.id=w.store_id AND s.merchant_id=w.merchant_id AND s.active=1 JOIN merchants m ON m.id=w.merchant_id AND m.status=1 WHERE w.id=? AND w.active=1';

async function getActiveWaiter(getAsync, waiterId) {
  if (typeof getAsync !== 'function') throw new TypeError('getAsync is required');
  return getAsync(ACTIVE_WAITER_SQL, [waiterId]);
}

module.exports = { getActiveWaiter, ACTIVE_WAITER_SQL };
