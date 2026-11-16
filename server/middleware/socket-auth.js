'use strict';

const { hashSessionToken } = require('../services/session-token');
const { safeErrorMetadata } = require('./safe-error-metadata');
const { resolveAdminStoreAccess } = require('../services/admin-store-access');

function isLiveSession(session) {
  if (!session) return false;
  const expiresAt = new Date(session.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function positiveSafeInteger(value) {
  const number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function createSocketAuthenticator({ getAsync, allAsync = async (sql, params) => { const result = await getAsync(sql, params); return Array.isArray(result) ? result : (result ? [result] : []); }, logger = console }) {
  if (typeof getAsync !== 'function') throw new TypeError('getAsync is required');

  return async function authenticateSocket(socket, next) {
    try {
      // Keep bearer credentials out of the URL/query string and reverse-proxy access logs.
      const auth = socket.handshake?.auth || {};
      const deliveryCustomerToken = typeof auth.deliveryCustomerToken === 'string' ? auth.deliveryCustomerToken.trim() : '';
      const deliveryOrderId = positiveSafeInteger(auth.deliveryOrderId);
      if (deliveryCustomerToken && deliveryOrderId && deliveryCustomerToken.length <= 128) {
        const order = await getAsync('SELECT id, store_id, customer_token FROM orders WHERE id=?', [deliveryOrderId]);
        const job = order ? await getAsync('SELECT id FROM delivery_jobs WHERE order_id=? AND store_id=?', [deliveryOrderId, order.store_id]) : null;
        if (!order || !job || !order.customer_token || hashSessionToken(deliveryCustomerToken) !== order.customer_token) {
          return next(new Error('unauthorized: delivery tracking access denied'));
        }
        socket.data.role = 'delivery_customer';
        socket.data.storeId = positiveSafeInteger(order.store_id);
        socket.data.deliveryOrderId = deliveryOrderId;
        return next();
      }

      const rawToken = auth.token;
      const token = typeof rawToken === 'string' ? rawToken.trim() : '';
      const tokenHash = hashSessionToken(token);
      if (!token || token.length > 256) return next(new Error('unauthorized: valid session token required'));

      const riderSession = await getAsync(
        `SELECT r.id, r.merchant_id, r.store_id, r.display_name, s.expires_at
         FROM delivery_rider_sessions s JOIN delivery_riders r ON r.id=s.rider_id
         JOIN stores st ON st.id=r.store_id AND st.merchant_id=r.merchant_id AND st.active=1
         JOIN merchants m ON m.id=r.merchant_id AND m.status=1
         WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(3) AND r.active=1`,
        [tokenHash]
      );
      if (riderSession) {
        socket.data.role = 'delivery_rider';
        socket.data.storeId = positiveSafeInteger(riderSession.store_id);
        socket.data.merchantId = positiveSafeInteger(riderSession.merchant_id);
        socket.data.deliveryRiderId = positiveSafeInteger(riderSession.id);
        socket.data.expiresAt = riderSession.expires_at;
        return next();
      }

      const scanSession = await getAsync(
        'SELECT table_name, store_id, expires_at FROM scan_sessions WHERE token_hash=?',
        [tokenHash]
      );
      if (scanSession) {
        if (!isLiveSession(scanSession)) return next(new Error('unauthorized: table session expired'));
        const storeId = positiveSafeInteger(scanSession.store_id);
        if (!storeId) return next(new Error('unauthorized: invalid table store'));
        const activeStore = await getAsync(
          'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.active=1 AND m.status=1',
          [storeId]
        );
        if (!activeStore) return next(new Error('unauthorized: table store inactive'));
        const table = await getAsync(
          'SELECT id FROM tables WHERE name=? AND store_id=?',
          [scanSession.table_name, storeId]
        );
        if (!table) return next(new Error('unauthorized: table session is stale'));
        socket.data.role = 'public';
        socket.data.storeId = storeId;
        socket.data.tableName = scanSession.table_name;
        socket.data.expiresAt = scanSession.expires_at;
        return next();
      }

      const waiterSession = await getAsync(
        'SELECT waiter_id, expires_at FROM waiter_sessions WHERE token_hash=?',
        [tokenHash]
      );
      if (isLiveSession(waiterSession)) {
        const waiter = await getAsync(
          'SELECT w.* FROM waiters w JOIN stores s ON s.id=w.store_id AND s.merchant_id=w.merchant_id AND s.active=1 JOIN merchants m ON m.id=w.merchant_id AND m.status=1 WHERE w.id=? AND w.active=1',
          [waiterSession.waiter_id]
        );
        if (waiter) {
          const storeId = positiveSafeInteger(waiter.store_id);
          if (!storeId) return next(new Error('unauthorized: invalid waiter store'));
          socket.data.role = 'waiter';
          socket.data.storeId = storeId;
          socket.data.waiterId = waiter.id;
          socket.data.expiresAt = waiterSession.expires_at;
          return next();
        }
      }

      const cashierSession = await getAsync(
        'SELECT cashier_id, store_id, merchant_id, expires_at FROM cashier_sessions WHERE token_hash=?',
        [tokenHash]
      );
      if (isLiveSession(cashierSession)) {
        const storeId = positiveSafeInteger(cashierSession.store_id);
        const merchantId = positiveSafeInteger(cashierSession.merchant_id);
        if (storeId && merchantId) {
          const activeStore = await getAsync(
            'SELECT s.id FROM stores s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=? AND s.merchant_id=? AND s.active=1 AND m.status=1',
            [storeId, merchantId]
          );
          const settings = activeStore
            ? await getAsync('SELECT value FROM settings WHERE `key`=?', ['cashiers_' + storeId])
            : null;
          let cashiers = [];
          try { cashiers = JSON.parse(settings?.value || '[]'); } catch (_) {}
          const cashier = cashiers.find(item => String(item.id) === String(cashierSession.cashier_id) &&
            (item.active === true || item.active === 1 || item.active === '1' || item.active === 'true'));
          if (cashier) {
            socket.data.role = 'cashier';
            socket.data.storeId = storeId;
            socket.data.cashierId = cashierSession.cashier_id;
            socket.data.expiresAt = cashierSession.expires_at;
            return next();
          }
        }
      }

      const adminSession = await getAsync(
        'SELECT admin_id, expires_at FROM admin_sessions WHERE token_hash=?',
        [tokenHash]
      );
      if (isLiveSession(adminSession)) {
        const admin = await getAsync(
          'SELECT id, merchant_id FROM merchant_admins WHERE id=? AND active=1',
          [adminSession.admin_id]
        );
        const merchant = admin
          ? await getAsync('SELECT id FROM merchants WHERE id=? AND status=1', [admin.merchant_id])
          : null;
        if (admin && merchant) {
          const rawStoreId = socket.handshake?.query?.storeId;
          const requestedStoreId = rawStoreId === undefined || rawStoreId === null || rawStoreId === '' ? null : positiveSafeInteger(rawStoreId);
          if (rawStoreId !== undefined && rawStoreId !== null && rawStoreId !== '' && !requestedStoreId) return next(new Error('unauthorized: invalid store id'));
          const storeAccess = await resolveAdminStoreAccess({ getAsync, allAsync, adminId: admin.id, merchantId: admin.merchant_id, requestedStoreId });
          if (storeAccess.error) return next(new Error(storeAccess.code === 'NO_ASSIGNED_ACTIVE_STORE' ? 'unauthorized: no active store assigned' : 'unauthorized: ' + storeAccess.code.toLowerCase()));
          const storeId = positiveSafeInteger(storeAccess.storeId);
          if (!storeId) return next(new Error('unauthorized: no active store'));
          socket.data.role = 'admin';
          socket.data.storeId = storeId;
          socket.data.adminId = admin.id;
          socket.data.merchantId = admin.merchant_id;
          socket.data.expiresAt = adminSession.expires_at;
          return next();
        }
      }

      return next(new Error('unauthorized: token invalid or expired'));
    } catch (error) {
      logger.error('[socket] authentication storage failed; connection rejected', safeErrorMetadata(error));
      return next(new Error('auth failed'));
    }
  };
}

function socketIdentity(socket) {
  const data = socket.data || {};
  return [data.role, data.storeId, data.merchantId, data.adminId, data.cashierId, data.waiterId, data.tableName];
}

// Handshake authentication alone leaves established sockets alive after logout,
// expiry, account deactivation, or session revocation. Re-run the same DB-backed
// authenticator periodically and fail closed if the session can no longer be verified.
function scheduleSocketRevalidation(socket, authenticateSocket, options = {}) {
  const intervalMs = Number.isSafeInteger(options.intervalMs) && options.intervalMs >= 1000
    ? options.intervalMs : 30000;
  const schedule = options.setTimeoutFn || setTimeout;
  const cancel = options.clearTimeoutFn || clearTimeout;
  const initialIdentity = socketIdentity(socket);
  let timer = null;
  let closed = false;

  const stop = () => {
    closed = true;
    if (timer) cancel(timer);
    timer = null;
  };
  socket.once('disconnect', stop);

  const revalidate = () => {
    if (closed) return;
    authenticateSocket(socket, error => {
      if (closed) return;
      const currentIdentity = socketIdentity(socket);
      if (error || currentIdentity.some((value, index) => value !== initialIdentity[index])) {
        socket.disconnect(true);
        return;
      }
      timer = schedule(revalidate, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  };

  timer = schedule(revalidate, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return stop;
}

module.exports = { createSocketAuthenticator, isLiveSession, positiveSafeInteger, scheduleSocketRevalidation };
