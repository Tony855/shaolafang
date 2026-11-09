'use strict';

/**
 * Resolve the store scope attached by the authenticated admin/waiter middleware.
 * Never invent a default store: missing scope must fail closed.
 */
function resolveOrderStoreId(req) {
  if (!req || typeof req !== 'object') return null;
  const raw = req.isAdmin
    ? req.storeId
    : (req.waiterStoreId ?? req.waiter?.store_id);
  if (raw === null || raw === undefined || raw === '') return null;
  const storeId = Number(raw);
  return Number.isSafeInteger(storeId) && storeId > 0 ? storeId : null;
}

module.exports = { resolveOrderStoreId };
