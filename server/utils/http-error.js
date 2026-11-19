'use strict';

function normalizeRouteError(error, fallbackMessage) {
  const candidate = Number(error && (error.statusCode ?? error.status));
  const isClientError = Number.isInteger(candidate) && candidate >= 400 && candidate < 500;
  const publicMessage = error && typeof error.publicMessage === 'string' && error.publicMessage.trim()
    ? error.publicMessage
    : null;
  const message = isClientError && typeof error.message === 'string' && error.message.trim()
    ? error.message
    : publicMessage || String(fallbackMessage || 'Request failed');
  return {
    status: isClientError ? candidate : 500,
    message,
    isClientError
  };
}

module.exports = { normalizeRouteError };
